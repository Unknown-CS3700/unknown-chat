import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const ROOMS = ["General", "CS3700", "Random"];
const HISTORY_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 500;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Per-room state:
//   history: last 50 messages (used to recover missed messages)
//   nextSeq: sequence number so every client sees the same order
//   users:   Map<username, { socketId, sessionId }>
const rooms = new Map(
  ROOMS.map((name) => [name, { history: [], nextSeq: 1, users: new Map() }])
);

function userList(room) {
  return [...rooms.get(room).users.keys()];
}

function leaveCurrentRoom(socket) {
  const { username, room } = socket.data;
  if (!room) return;

  const state = rooms.get(room);
  const entry = state.users.get(username);

  // Only remove the name if THIS socket still owns it
  // (after a reconnect, a newer socket may have taken it over)
  if (entry && entry.socketId === socket.id) {
    state.users.delete(username);
    socket.to(room).emit("user_left", { username, users: userList(room) });
  }

  socket.leave(room);
  socket.data.room = null;
}

// Serve the website (entry page) from the public folder
app.use(express.static(path.join(__dirname, "public")));

// List of rooms for the entry page dropdown
app.get("/api/rooms", (req, res) => res.json(ROOMS));

io.on("connection", (socket) => {
  console.log(`connected: ${socket.id}`);

  socket.on("join_room", (payload, ack) => {
    if (typeof ack !== "function") return;

    const username = String(payload?.username ?? "").trim();
    const room = payload?.room;
    const sessionId = String(payload?.sessionId ?? "");

    if (username.length < 2 || username.length > 20) {
      return ack({ ok: false, error: "Name must be 2-20 characters." });
    }
    if (!rooms.has(room)) {
      return ack({ ok: false, error: "That room doesn't exist." });
    }

    const state = rooms.get(room);
    const existing = state.users.get(username);

    // Same name from a different browser tab = taken.
    // Same name from the same tab = a reconnect, so allow it.
    if (existing && existing.sessionId !== sessionId) {
      return ack({ ok: false, error: "That name is taken in this room." });
    }

    leaveCurrentRoom(socket);

    state.users.set(username, { socketId: socket.id, sessionId });
    socket.data.username = username;
    socket.data.room = room;
    socket.join(room);

    // Send history back so the client recovers anything it missed
    ack({ ok: true, history: state.history, users: userList(room) });

    if (!existing) {
      socket.to(room).emit("user_joined", { username, users: userList(room) });
    }
  });

  socket.on("send_message", (payload, ack) => {
    if (typeof ack !== "function") return;

    const { username, room } = socket.data;
    if (!room) return ack({ ok: false, error: "Join a room first." });

    const text = String(payload?.text ?? "").trim();
    if (!text) return ack({ ok: false, error: "Message is empty." });
    if (text.length > MAX_MESSAGE_LENGTH) {
      return ack({ ok: false, error: `Max ${MAX_MESSAGE_LENGTH} characters.` });
    }

    const state = rooms.get(room);
    const message = {
      id: randomUUID(),
      seq: state.nextSeq++,
      username,
      text,
      timestamp: Date.now(),
    };

    state.history.push(message);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();

    io.to(room).emit("new_message", message);
    ack({ ok: true, id: message.id });
  });

  socket.on("disconnect", (reason) => {
    console.log(`disconnected: ${socket.id} (${reason})`);
    leaveCurrentRoom(socket);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Unknown Chat running on http://localhost:${PORT}`);
});