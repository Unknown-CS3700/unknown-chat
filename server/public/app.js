// Connect only when the user clicks Join
const socket = io({ autoConnect: false });

// Page elements
const entryView = document.getElementById("entry-view");
const chatView = document.getElementById("chat-view");
const joinForm = document.getElementById("join-form");
const usernameInput = document.getElementById("username");
const roomSelect = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const joinError = document.getElementById("join-error");
const statusEl = document.getElementById("status");
const roomTitle = document.getElementById("room-title");
const leaveBtn = document.getElementById("leave-btn");
const messageList = document.getElementById("messages");
const sendForm = document.getElementById("send-form");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const sendError = document.getElementById("send-error");

let currentUser = null; // { username, room } once joined

// Random ID per browser tab, so the server can tell
// "same person reconnecting" apart from "someone else using the same name"
function getSessionId() {
  let id = sessionStorage.getItem("unknownChatSession");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("unknownChatSession", id);
  }
  return id;
}

// ---------- Connection status ----------
function setStatus(state) {
  statusEl.textContent = state;
  statusEl.className = `status status-${state}`;
  const connected = state === "connected";
  messageInput.disabled = !connected;
  sendBtn.disabled = !connected;
  messageInput.placeholder = connected ? "Type a message..." : "Reconnecting...";
}

socket.on("connect", () => setStatus("connected"));
socket.on("disconnect", (reason) =>
  setStatus(reason === "io client disconnect" ? "disconnected" : "reconnecting")
);
socket.io.on("reconnect_attempt", () => setStatus("reconnecting"));

// After an automatic reconnect, rejoin the room and recover missed messages
socket.io.on("reconnect", () => {
  if (!currentUser) return;
  socket.timeout(5000).emit(
    "join_room",
    { ...currentUser, sessionId: getSessionId() },
    (err, res) => {
      if (err || !res.ok) {
        sendError.textContent = "Reconnected, but couldn't rejoin the room.";
        return;
      }
      sendError.textContent = "";
      res.history.forEach(addMessage); // duplicates are skipped
    }
  );
});

// ---------- Entry page ----------
fetch("/api/rooms")
  .then((res) => res.json())
  .then((rooms) => {
    for (const room of rooms) {
      const option = document.createElement("option");
      option.value = room;
      option.textContent = room;
      roomSelect.append(option);
    }
  })
  .catch(() => (joinError.textContent = "Can't reach the server. Is it running?"));

// Only enable Join when the name is 2-20 characters
usernameInput.addEventListener("input", () => {
  const len = usernameInput.value.trim().length;
  joinBtn.disabled = len < 2 || len > 20;
});

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const room = roomSelect.value;

  joinBtn.disabled = true;
  joinBtn.textContent = "Joining...";
  joinError.textContent = "";
  socket.connect();

  socket.timeout(5000).emit("join_room", { username, room, sessionId: getSessionId() }, (err, res) => {
    joinBtn.disabled = false;
    joinBtn.textContent = "Join";

    if (err || !res.ok) {
      joinError.textContent = err ? "Server didn't respond. Try again." : res.error;
      socket.disconnect();
      return;
    }

    currentUser = { username, room };
    showChat(res.history);
  });
});

// ---------- Chat view ----------
function showChat(history) {
  entryView.hidden = true;
  chatView.hidden = false;
  roomTitle.textContent = `#${currentUser.room}`;
  messageList.innerHTML = "";
  history.forEach(addMessage);
  addSystemMessage(`You joined as ${currentUser.username}`);
  messageInput.focus();
}

function addMessage(msg) {
  // Skip messages already on screen (prevents duplicates after reconnecting)
  if (messageList.querySelector(`[data-id="${msg.id}"]`)) return;

  const li = document.createElement("li");
  li.dataset.id = msg.id;
  if (msg.username === currentUser.username) li.classList.add("mine");

  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  meta.textContent = `${msg.username} · ${time}`;

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = msg.text; // textContent (not innerHTML) so users can't inject HTML

  li.append(meta, text);
  messageList.append(li);
  messageList.scrollTop = messageList.scrollHeight;
}

function addSystemMessage(text) {
  const li = document.createElement("li");
  li.className = "system";
  li.textContent = text;
  messageList.append(li);
  messageList.scrollTop = messageList.scrollHeight;
}

socket.on("new_message", addMessage);
socket.on("user_joined", ({ username }) => addSystemMessage(`${username} joined`));
socket.on("user_left", ({ username }) => addSystemMessage(`${username} left`));

sendForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  socket.timeout(5000).emit("send_message", { text }, (err, res) => {
    if (err) return (sendError.textContent = "Message not delivered. Check your connection.");
    if (!res.ok) return (sendError.textContent = res.error);
    sendError.textContent = "";
  });
  messageInput.value = "";
});

leaveBtn.addEventListener("click", () => {
  socket.disconnect();
  currentUser = null;
  chatView.hidden = true;
  entryView.hidden = false;
  usernameInput.focus();
});