# Unknown Chat

Real-time chat app for CS3700-002 (Node.js + Express + Socket.IO).

## Running locally
```
cd server
npm install
npm run dev
```

Then open http://localhost:3000

## Project layout
- `server/index.js` - Express + Socket.IO server
- `server/public/` - website (entry page + chat view)

## Socket.IO Events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `join_room` | client → server | `{ username, room, sessionId }` | Ack: `{ ok, history, users }` or `{ ok: false, error }` |
| `send_message` | client → server | `{ text }` | Ack: `{ ok, id }` or `{ ok: false, error }` |
| `new_message` | server → room | `{ id, seq, username, text, timestamp }` | Broadcast to everyone in the room |
| `user_joined` | server → room | `{ username, users }` | |
| `user_left` | server → room | `{ username, users }` | |

REST: `GET /api/rooms` returns the list of room names.