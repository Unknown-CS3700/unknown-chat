import type http from "node:http";
import type https from "node:https";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";
import { isMember, memberIds, saveMessage } from "./controllers/MessagesController";
import { isUuid } from "./utils";

interface Client extends WebSocket {
  userId?: string;
  name?: string;
  isAlive?: boolean;
}

const send = (ws: WebSocket, data: object) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};

export function setupSocket(server: http.Server | https.Server) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

  wss.on("connection", (socket) => {
    const ws = socket as Client;
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("error", (e) => console.error("socket error:", e.message));

    // Must say hello (with a token) within 5 seconds
    const timer = setTimeout(() => {
      if (!ws.userId) ws.close(4004, "hello timeout");
    }, 5000);
    ws.on("close", () => clearTimeout(timer));

    ws.on("message", async (raw) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", code: "bad_json" });
        return;
      }

      // 1) hello: log the socket in with the token from /signin or /signup
      if (data.type === "hello") {
        try {
          const d = jwt.verify(data.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
          ws.userId = d.sub;
          ws.name = d.name;
          send(ws, { type: "ready" });
        } catch {
          ws.close(4002, "invalid or expired token");
        }
        return;
      }

      if (!ws.userId) {
        ws.close(4002, "send hello first");
        return;
      }

      // 2) msg: validate, check room membership, save, send to the room's members, ack
      if (data.type === "msg") {
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (!isUuid(data.msgId) || !isUuid(data.roomId) || text.length < 1 || text.length > 2000) {
          send(ws, { type: "error", code: "invalid_msg", msgId: data.msgId });
          return;
        }
        try {
          if (!(await isMember(data.roomId, ws.userId))) {
            send(ws, { type: "error", code: "not_member", msgId: data.msgId });
            return;
          }

          const { duplicate, message } = await saveMessage(ws.userId, ws.name!, data.roomId, data.msgId, text);

          if (!duplicate) {
            // Only members of THIS room receive it (every device they are logged in on)
            const members = new Set(await memberIds(data.roomId));
            wss.clients.forEach((c) => {
              const uid = (c as Client).userId;
              if (uid && members.has(uid)) send(c, { type: "msg", ...message });
            });
          }
          send(ws, { type: "ack", msgId: data.msgId, seq: message.seq });
        } catch (e: any) {
          console.error("save failed:", e.message);
          send(ws, { type: "error", code: "unavailable", msgId: data.msgId });
        }
      }
    });
  });

  // Heartbeat: protocol ping every 15s; no pong by the next round = dead socket.
  // Browsers and the ws library answer protocol pings automatically.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      const ws = c as Client;
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
