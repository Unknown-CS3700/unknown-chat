// Fake backend for the frontend developer: same API as the real server, no database, no TLS.
//   npm run mock      -> http://localhost:8080   ws://localhost:8080/ws
// Any email + password (8+ chars) works. New accounts are auto-joined to "general".
// alice@test.com and bob@test.com are members of general and class-demo; "random" is empty.
// Restarting the mock resets everything.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PORT = 8080;
type Msg = { seq: number; roomId: string; msgId: string; userId: string; from: string; text: string; serverTs: string };
type User = { id: string; displayName: string };
type Room = { id: string; name: string; members: Set<string> };

const makeRoom = (name: string, members: string[]): Room => ({ id: randomUUID(), name, members: new Set(members) });
const rooms: Room[] = [
  makeRoom("general", ["u-alice", "u-bob"]),
  makeRoom("class-demo", ["u-alice", "u-bob"]),
  makeRoom("random", []),
];
const log: Msg[] = [];
let nextSeq = 1;
const seed = (room: string, userId: string, from: string, text: string) =>
  log.push({ seq: nextSeq++, roomId: rooms.find((r) => r.name === room)!.id, msgId: randomUUID(), userId, from, text, serverTs: new Date().toISOString() });
seed("general", "u-alice", "alice", "Hey everyone, welcome to the chat!");
seed("general", "u-bob", "bob", "Hi alice! Messages show up instantly.");
seed("class-demo", "u-alice", "alice", "This room is only for alice and bob.");

const makeToken = (u: User) => Buffer.from(JSON.stringify(u)).toString("base64");
const readToken = (t: string): User | null => {
  try {
    const u = JSON.parse(Buffer.from(t, "base64").toString());
    return u?.id ? u : null;
  } catch {
    return null;
  }
};
const send = (ws: WebSocket, data: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(data));
const view = (r: Room, userId: string) => ({ id: r.id, name: r.name, members: r.members.size, joined: r.members.has(userId) });

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  const json = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") return json(200, { status: "ok", mock: true });

  const readBody = (cb: (b: any) => void) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { cb(JSON.parse(body || "{}")); } catch { cb({}); }
    });
  };

  if (req.method === "POST" && (path === "/signup" || path === "/signin")) {
    return readBody((b) => {
      const email = String(b.email ?? "").trim().toLowerCase();
      if (!email || !b.password || String(b.password).length < 8) {
        return json(400, { message: "email and a password (8+ chars) are required" });
      }
      const displayName = String(b.displayName ?? email.split("@")[0]);
      const user = { id: `u-${displayName}`, displayName };
      if (path === "/signup") rooms[0].members.add(user.id); // auto-join general
      json(path === "/signup" ? 201 : 200, { token: makeToken(user), user });
    });
  }

  // everything below needs a token
  const user = readToken((req.headers.authorization ?? "").replace("Bearer ", ""));
  if (!user) return json(401, { message: "Invalid or expired token" });

  if (req.method === "GET" && path === "/rooms") return json(200, { rooms: rooms.map((r) => view(r, user.id)) });

  if (req.method === "POST" && path === "/rooms") {
    return readBody((b) => {
      const name = String(b.name ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9 _-]{0,29}$/.test(name)) return json(400, { message: "Invalid room name" });
      if (rooms.some((r) => r.name === name)) return json(409, { message: "A room with that name already exists" });
      const room = makeRoom(name, [user.id]);
      rooms.push(room);
      json(201, { room: view(room, user.id) });
    });
  }

  const m = path.match(/^\/rooms\/([^/]+)\/(messages|join|leave)$/);
  if (m) {
    const room = rooms.find((r) => r.id === m[1]);
    if (!room) return json(404, { message: "Room not found" });

    if (req.method === "POST" && m[2] === "join") {
      room.members.add(user.id);
      return json(200, { room: view(room, user.id) });
    }
    if (req.method === "POST" && m[2] === "leave") {
      room.members.delete(user.id);
      return json(200, { ok: true });
    }
    if (req.method === "GET" && m[2] === "messages") {
      if (!room.members.has(user.id)) return json(403, { message: "Join this room first" });
      const inRoom = log.filter((x) => x.roomId === room.id);
      const headSeq = inRoom.length ? inRoom[inRoom.length - 1].seq : 0;
      const after = Number(url.searchParams.get("after")) || 0;
      const list = after === 0 ? inRoom.slice(-50) : inRoom.filter((x) => x.seq > after).slice(0, 500);
      return json(200, { messages: list, headSeq });
    }
  }

  json(404, { message: "Not found" });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
const clients = new Map<WebSocket, User>();

wss.on("connection", (ws) => {
  const timer = setTimeout(() => !clients.has(ws) && ws.close(4004, "hello timeout"), 5000);
  ws.on("close", () => { clearTimeout(timer); clients.delete(ws); });

  ws.on("message", (raw) => {
    let d: any;
    try { d = JSON.parse(raw.toString()); } catch { return void send(ws, { type: "error", code: "bad_json" }); }

    if (d.type === "hello") {
      const u = readToken(String(d.token));
      if (!u) return void ws.close(4002, "invalid or expired token");
      clients.set(ws, u);
      return void send(ws, { type: "ready" });
    }

    const user = clients.get(ws);
    if (!user) return void ws.close(4002, "send hello first");

    if (d.type === "msg") {
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (typeof d.msgId !== "string" || d.msgId.length !== 36 || typeof d.roomId !== "string" || !text || text.length > 2000) {
        return void send(ws, { type: "error", code: "invalid_msg", msgId: d.msgId });
      }
      const room = rooms.find((r) => r.id === d.roomId);
      if (!room || !room.members.has(user.id)) return void send(ws, { type: "error", code: "not_member", msgId: d.msgId });

      const dup = log.find((x) => x.userId === user.id && x.msgId === d.msgId);
      if (dup) return void send(ws, { type: "ack", msgId: dup.msgId, seq: dup.seq });

      const msg: Msg = { seq: nextSeq++, roomId: room.id, msgId: d.msgId, userId: user.id, from: user.displayName, text, serverTs: new Date().toISOString() };
      log.push(msg);
      for (const [c, u] of clients) if (room.members.has(u.id)) send(c, { type: "msg", ...msg });
      send(ws, { type: "ack", msgId: msg.msgId, seq: msg.seq });
    }
  });
});

server.listen(PORT, () => console.log(`MOCK server: http://localhost:${PORT}   ws://localhost:${PORT}/ws`));
