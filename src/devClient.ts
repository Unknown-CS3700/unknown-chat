// Terminal chat client for testing without a frontend.
//   npm run client -- alice@test.com alice
// Type text + Enter to send to your current room. Commands:
//   /rooms            list rooms (* = joined, > = current)
//   /join <name>      join a room and switch to it
//   /create <name>    create a room (you join it) and switch to it
//   /use <name>       switch to a room you already joined
//   /leave <name>     leave a room
//   /drop             kill your connection (it reconnects and catches up)
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import WebSocket from "ws";

const [email = "alice@test.com", name = "alice"] = process.argv.slice(2);
const BASE_URL = process.env.BASE_URL ?? "https://localhost:8443";
const WS_URL = BASE_URL.replace(/^http/, "ws") + "/ws";
const PASSWORD = "password123";

type Room = { id: string; name: string; joined: boolean };

let token = "";
let ws: WebSocket | null = null;
let ready = false;
let rooms: Room[] = [];
let current: Room | null = null;
const lastSeq = new Map<string, number>(); // roomId -> last seq shown for that room

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function getToken(): Promise<string> {
  token = "";
  let r = await api("/signin", "POST", { email, password: PASSWORD });
  if (r.status === 401) r = await api("/signup", "POST", { email, password: PASSWORD, displayName: name });
  if (r.status >= 300) throw new Error(`auth failed: ${r.status}`);
  return r.json.token;
}

const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? id.slice(0, 8);

function show(m: any) {
  if (m.seq <= (lastSeq.get(m.roomId) ?? 0)) return; // already shown (live/history overlap)
  lastSeq.set(m.roomId, m.seq);
  console.log(`[${roomName(m.roomId)}] #${m.seq} ${m.from}: ${m.text}`);
}

async function refreshRooms() {
  rooms = (await api("/rooms")).json.rooms ?? [];
  if (!current || !rooms.find((r) => r.id === current!.id && r.joined)) {
    current = rooms.find((r) => r.name === "general" && r.joined) ?? rooms.find((r) => r.joined) ?? null;
  }
}

async function catchUp(room: Room) {
  const r = await api(`/rooms/${room.id}/messages?after=${lastSeq.get(room.id) ?? 0}`);
  (r.json.messages ?? []).forEach(show);
}

async function connect() {
  ready = false;
  try {
    token = await getToken();
  } catch (e: any) {
    console.log("[auth error, retry in 3s]", e.message);
    setTimeout(connect, 3000);
    return;
  }

  const sock = new WebSocket(WS_URL);
  ws = sock;
  sock.on("open", () => sock.send(JSON.stringify({ type: "hello", token })));

  sock.on("message", async (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "ready") {
      await refreshRooms();
      for (const r of rooms.filter((r) => r.joined)) await catchUp(r); // anything missed while offline
      ready = true;
      console.log(`[live] current room: ${current?.name ?? "(none, use /join <name>)"}`);
    } else if (f.type === "msg") show(f);
    else if (f.type === "ack") console.log(`[ack] seq=${f.seq}`);
    else if (f.type === "error") console.log(`[error] ${f.code}`);
  });

  sock.on("close", (code) => {
    ready = false;
    console.log(`[closed] ${code}, reconnecting in 3s`);
    setTimeout(connect, 3000);
  });
  sock.on("error", (e) => console.log("[socket error]", e.message));
}

async function command(line: string) {
  const [cmd, ...rest] = line.split(" ");
  const arg = rest.join(" ").trim().toLowerCase();
  const find = () => rooms.find((r) => r.name === arg);

  if (cmd === "/drop") return void ws?.terminate();
  if (cmd === "/rooms") {
    await refreshRooms();
    return void rooms.forEach((r) => console.log(`${r.id === current?.id ? ">" : " "} ${r.joined ? "*" : " "} ${r.name}`));
  }
  if (cmd === "/create") {
    const r = await api("/rooms", "POST", { name: arg });
    if (r.status !== 201) return void console.log(`[cannot create] ${r.json.message}`);
    await refreshRooms();
    current = find() ?? current;
    return void console.log(`[created and joined] ${arg}`);
  }
  await refreshRooms();
  const room = find();
  if (!room) return void console.log(`[no room named "${arg}"]  try /rooms`);

  if (cmd === "/join") {
    await api(`/rooms/${room.id}/join`, "POST");
    await refreshRooms();
    current = find() ?? current;
    await catchUp(room);
    return void console.log(`[joined] ${room.name}`);
  }
  if (cmd === "/use") {
    if (!room.joined) return void console.log("[not joined] use /join first");
    current = room;
    return void console.log(`[current room] ${room.name}`);
  }
  if (cmd === "/leave") {
    await api(`/rooms/${room.id}/leave`, "POST");
    await refreshRooms();
    return void console.log(`[left] ${room.name}`);
  }
  console.log("[unknown command]");
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    try {
      await command(text);
    } catch (e: any) {
      console.log("[command failed]", e.message);
    }
    return;
  }
  if (!ready || ws?.readyState !== WebSocket.OPEN) return void console.log("[not ready]");
  if (!current) return void console.log("[no current room] use /join <name>");
  ws.send(JSON.stringify({ type: "msg", roomId: current.id, msgId: randomUUID(), text }));
});

connect();
