const { API_URL, WS_URL } = window.CHAT_CONFIG;

// ---------- State ----------
let token = localStorage.getItem("uc_token");
let user = JSON.parse(localStorage.getItem("uc_user") || "null"); // { id, displayName }

let ws = null;
let ready = false;          // true after the server sends "ready"
let signingOut = false;
let reconnectAttempt = 0;
let reconnectTimer = null;

let rooms = [];             // [{ id, name, members, joined }]
let currentRoomId = null;
const messages = new Map();     // roomId -> Map(seq -> message)
const loadedRooms = new Set();  // rooms whose history has been fetched
const unread = new Set();       // rooms that got messages while another room was open
const pending = new Map();      // msgId -> { roomId, text }  sent but not acked yet

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const meEl = $("me");
const dropBtn = $("drop-btn");
const signoutBtn = $("signout-btn");
const authView = $("auth-view");
const authForm = $("auth-form");
const nameField = $("name-field");
const emailInput = $("email");
const nameInput = $("display-name");
const passwordInput = $("password");
const authError = $("auth-error");
const authBtn = $("auth-btn");
const chatView = $("chat-view");
const myRoomsEl = $("my-rooms");
const otherRoomsEl = $("other-rooms");
const createForm = $("create-form");
const roomNameInput = $("room-name");
const roomError = $("room-error");
const roomTitle = $("room-title");
const leaveBtn = $("leave-btn");
const messageList = $("messages");
const sendForm = $("send-form");
const messageInput = $("message-input");
const sendBtn = $("send-btn");
const sendError = $("send-error");

// ---------- Helpers ----------
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) signOut("Your session expired. Please sign in again.");
  if (!res.ok) throw new ApiError(res.status, data.message || `Request failed (${res.status})`);
  return data;
}

function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = `status status-${state}`;
}

function lastSeq(roomId) {
  const map = messages.get(roomId);
  return map && map.size ? Math.max(...map.keys()) : 0;
}

function isJoined(roomId) {
  return rooms.some((r) => r.id === roomId && r.joined);
}

// ---------- Sign in / sign up ----------
let mode = "signin";

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    mode = tab.dataset.mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    nameField.hidden = mode !== "signup";
    authBtn.textContent = mode === "signup" ? "Create account" : "Sign in";
    passwordInput.autocomplete = mode === "signup" ? "new-password" : "current-password";
    authError.textContent = "";
  });
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";

  const body = { email: emailInput.value.trim(), password: passwordInput.value };
  if (mode === "signup") {
    body.displayName = nameInput.value.trim();
    if (!body.displayName) return (authError.textContent = "Pick a display name.");
  }

  authBtn.disabled = true;
  try {
    const data = await api(`/${mode}`, { method: "POST", body });
    token = data.token;
    user = data.user;
    localStorage.setItem("uc_token", token);
    localStorage.setItem("uc_user", JSON.stringify(user));
    passwordInput.value = "";
    startChat();
  } catch (err) {
    if (err.status === 401) authError.textContent = "Wrong email or password.";
    else if (err.status === 409) authError.textContent = "That email is already registered.";
    else if (err instanceof TypeError) authError.textContent = "Can't reach the server. Is it running?";
    else authError.textContent = err.message;
  } finally {
    authBtn.disabled = false;
  }
});

function startChat() {
  signingOut = false;
  authView.hidden = true;
  chatView.hidden = false;
  meEl.textContent = user.displayName;
  meEl.hidden = dropBtn.hidden = signoutBtn.hidden = false;
  connect();
}

function signOut(reason = "") {
  signingOut = true;
  clearTimeout(reconnectTimer);
  if (ws) ws.close(1000, "sign out");
  ws = null;
  ready = false;
  token = null;
  user = null;
  localStorage.removeItem("uc_token");
  localStorage.removeItem("uc_user");

  rooms = [];
  currentRoomId = null;
  messages.clear();
  loadedRooms.clear();
  unread.clear();
  pending.clear();

  chatView.hidden = true;
  authView.hidden = false;
  meEl.hidden = dropBtn.hidden = signoutBtn.hidden = true;
  setStatus("offline");
  authError.textContent = reason;
}

signoutBtn.addEventListener("click", () => signOut());

// ---------- WebSocket ----------
function connect() {
  clearTimeout(reconnectTimer);
  setStatus(reconnectAttempt ? "reconnecting" : "connecting");

  const socket = new WebSocket(WS_URL);
  ws = socket;
  ready = false;

  // First frame must be hello with the token
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello", token }));

  socket.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  };

  socket.onclose = (event) => {
    if (ws !== socket) return; // an old socket we already replaced
    ws = null;
    ready = false;
    updateComposer();
    if (signingOut) return;
    if (event.code === 4002) return signOut("Your session expired. Please sign in again.");
    scheduleReconnect();
  };
}

// Exponential backoff with jitter: ~1s, 2s, 4s ... capped at 30s
function scheduleReconnect() {
  setStatus("reconnecting");
  const base = Math.min(30000, 1000 * 2 ** reconnectAttempt);
  const delay = base / 2 + Math.random() * (base / 2);
  reconnectAttempt++;
  reconnectTimer = setTimeout(connect, delay);
}

// Reconnect right away when the computer gets its network back
window.addEventListener("online", () => {
  if (token && !ws && !signingOut) {
    reconnectAttempt = 0;
    connect();
  }
});

// Demo button: cut the connection to show reconnect + catch-up
dropBtn.addEventListener("click", () => {
  if (ws) ws.close(4000, "manual drop");
});

async function handleFrame(frame) {
  switch (frame.type) {
    case "ready":
      ready = true;
      reconnectAttempt = 0;
      setStatus("connected");
      updateComposer();
      await catchUp();
      resendPending();
      break;

    case "msg":
      if (frame.userId === user.id) pending.delete(frame.msgId); // our own echo
      addMessages(frame.roomId, [frame]);
      if (frame.roomId !== currentRoomId) {
        unread.add(frame.roomId);
        renderRooms();
      }
      break;

    case "ack":
      if (pending.delete(frame.msgId)) renderMessages();
      break;

    case "error":
      // "unavailable" is temporary, so keep the message queued to resend
      if (frame.msgId && frame.code !== "unavailable") pending.delete(frame.msgId);
      sendError.textContent = errorText(frame.code);
      renderMessages();
      break;
  }
}

function errorText(code) {
  switch (code) {
    case "not_member": return "You're not a member of that room anymore.";
    case "invalid_msg": return "That message couldn't be sent (1-2000 characters).";
    case "unavailable": return "Server is busy. Your message will be resent.";
    default: return "Something went wrong sending that message.";
  }
}

// After every (re)connect: refresh rooms, then fetch anything missed
async function catchUp() {
  try {
    await loadRooms();

    for (const roomId of [...loadedRooms]) {
      if (isJoined(roomId)) await fetchMessages(roomId);
      else forgetRoom(roomId);
    }

    if (!currentRoomId || !isJoined(currentRoomId)) {
      const first = rooms.find((r) => r.joined);
      if (first) await openRoom(first.id);
      else showNoRoom();
    } else if (!loadedRooms.has(currentRoomId)) {
      await openRoom(currentRoomId);
    }

    renderRooms();
    renderMessages();
  } catch (err) {
    if (!signingOut) sendError.textContent = `Couldn't load messages: ${err.message}`;
  }
}

function resendPending() {
  for (const msgId of pending.keys()) sendFrame(msgId);
}

function sendFrame(msgId) {
  const p = pending.get(msgId);
  if (p && ws && ready) {
    ws.send(JSON.stringify({ type: "msg", roomId: p.roomId, msgId, text: p.text }));
  }
}

// ---------- Rooms ----------
async function loadRooms() {
  const data = await api("/rooms");
  rooms = data.rooms;
  renderRooms();
}

async function fetchMessages(roomId) {
  // First load of a room: last 50 messages. After that: only what's new.
  const after = loadedRooms.has(roomId) ? lastSeq(roomId) : 0;
  const data = await api(`/rooms/${roomId}/messages?after=${after}`);

  // Our lastSeq is ahead of the server: the server's data was reset
  if (after > data.headSeq) {
    messages.delete(roomId);
    loadedRooms.delete(roomId);
    return fetchMessages(roomId);
  }

  addMessages(roomId, data.messages);
  loadedRooms.add(roomId);
}

function addMessages(roomId, list) {
  if (!messages.has(roomId)) messages.set(roomId, new Map());
  const map = messages.get(roomId);
  for (const m of list) map.set(m.seq, m); // keyed by seq, so duplicates can't appear twice
  if (roomId === currentRoomId) renderMessages();
}

async function openRoom(roomId) {
  currentRoomId = roomId;
  unread.delete(roomId);
  sendError.textContent = "";
  renderRooms();
  renderMessages();

  if (!loadedRooms.has(roomId)) {
    try {
      await fetchMessages(roomId);
    } catch (err) {
      sendError.textContent = err.message;
    }
    renderMessages();
  }
  messageInput.focus();
}

function showNoRoom() {
  currentRoomId = null;
  renderRooms();
  renderMessages();
}

function forgetRoom(roomId) {
  messages.delete(roomId);
  loadedRooms.delete(roomId);
  unread.delete(roomId);
  for (const [msgId, p] of pending) if (p.roomId === roomId) pending.delete(msgId);
}

async function joinRoom(roomId) {
  roomError.textContent = "";
  try {
    await api(`/rooms/${roomId}/join`, { method: "POST" });
    await loadRooms();
    await openRoom(roomId);
  } catch (err) {
    roomError.textContent = err.message;
  }
}

leaveBtn.addEventListener("click", async () => {
  const roomId = currentRoomId;
  if (!roomId) return;
  try {
    await api(`/rooms/${roomId}/leave`, { method: "POST" });
    forgetRoom(roomId);
    currentRoomId = null;
    await loadRooms();
    const first = rooms.find((r) => r.joined);
    if (first) await openRoom(first.id);
    else showNoRoom();
  } catch (err) {
    sendError.textContent = err.message;
  }
});

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  roomError.textContent = "";
  const name = roomNameInput.value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9 _-]{0,29}$/.test(name)) {
    roomError.textContent = "1-30 characters: letters, numbers, spaces, - or _";
    return;
  }

  try {
    const data = await api("/rooms", { method: "POST", body: { name } });
    roomNameInput.value = "";
    await loadRooms();
    await openRoom(data.room.id);
  } catch (err) {
    roomError.textContent = err.status === 409 ? "A room with that name already exists." : err.message;
  }
});

// ---------- Rendering ----------
function renderRooms() {
  myRoomsEl.innerHTML = "";
  otherRoomsEl.innerHTML = "";

  const sorted = [...rooms].sort((a, b) => a.name.localeCompare(b.name));
  for (const room of sorted) {
    const li = document.createElement("li");

    if (room.joined) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "room" + (room.id === currentRoomId ? " active" : "");
      btn.textContent = `#${room.name}`;
      if (unread.has(room.id)) {
        const dot = document.createElement("span");
        dot.className = "dot";
        btn.append(dot);
      }
      btn.addEventListener("click", () => openRoom(room.id));
      li.append(btn);
      myRoomsEl.append(li);
    } else {
      li.className = "browse";
      const name = document.createElement("span");
      name.textContent = `#${room.name} `;
      const count = document.createElement("span");
      count.className = "muted count";
      count.textContent = `(${room.members})`;
      name.append(count);

      const join = document.createElement("button");
      join.type = "button";
      join.className = "small";
      join.textContent = "Join";
      join.addEventListener("click", () => joinRoom(room.id));

      li.append(name, join);
      otherRoomsEl.append(li);
    }
  }

  if (!otherRoomsEl.children.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "You're in every room.";
    otherRoomsEl.append(li);
  }
}

function renderMessages() {
  const room = rooms.find((r) => r.id === currentRoomId);
  roomTitle.textContent = room ? `#${room.name}` : "Pick a room";
  leaveBtn.hidden = !room;
  updateComposer();

  messageList.innerHTML = "";
  if (!room) return;

  // Always sort by seq, never by time
  const saved = [...(messages.get(room.id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
  const savedIds = new Set(saved.filter((m) => m.userId === user.id).map((m) => m.msgId));

  for (const m of saved) {
    messageList.append(bubble(m.from, m.text, m.serverTs, m.userId === user.id, false));
  }

  // Messages we sent that the server hasn't confirmed yet
  for (const [msgId, p] of pending) {
    if (p.roomId === room.id && !savedIds.has(msgId)) {
      messageList.append(bubble(user.displayName, p.text, null, true, true));
    }
  }

  if (!messageList.children.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No messages yet. Say hi!";
    messageList.append(li);
  }

  messageList.scrollTop = messageList.scrollHeight;
}

function bubble(from, text, ts, mine, isPending) {
  const li = document.createElement("li");
  if (mine) li.classList.add("mine");
  if (isPending) li.classList.add("pending");

  const meta = document.createElement("span");
  meta.className = "meta";
  const time = ts
    ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "sending...";
  meta.textContent = `${from} · ${time}`;

  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text; // textContent, not innerHTML, so users can't inject HTML

  li.append(meta, body);
  return li;
}

function updateComposer() {
  const room = rooms.find((r) => r.id === currentRoomId);
  // You can type even while offline: messages queue up and send after reconnecting
  messageInput.disabled = sendBtn.disabled = !room;
  if (room) {
    messageInput.placeholder = ready
      ? `Message #${room.name}`
      : "Offline - messages will send when reconnected";
  }
}

// ---------- Sending ----------
sendForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentRoomId) return;

  const msgId = uuid();
  pending.set(msgId, { roomId: currentRoomId, text });
  messageInput.value = "";
  sendError.textContent = "";
  renderMessages();
  sendFrame(msgId); // if offline, resendPending() sends it after reconnecting
});

// ---------- Start ----------
if (token && user) startChat();