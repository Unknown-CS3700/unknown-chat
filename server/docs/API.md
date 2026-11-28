# API contract (for the frontend)

Real server: `https://localhost:8443` / `wss://localhost:8443/ws`
Mock server (no database needed): `http://localhost:8080` / `ws://localhost:8080/ws`  (`npm run mock`)

Keep these in env vars in the frontend, never hardcode:
```
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080/ws
```
A page served over https must use `wss://` (browsers block `ws://` from https pages).

## How users find who to talk to: rooms

- A **room** is a public channel (for example `general`, `class-demo`). Anyone can see the list of rooms.
- You only receive messages from, and can only read or write in, rooms you have **joined**.
- A new account is automatically joined to `general`, so the app is never empty.
- Anyone can create a room (the creator joins it) and anyone can join or leave a room.
- When you join a room you can read its full history.

Suggested UI: left sidebar with "My rooms" (click to open) and "Browse rooms" (Join button) + a "Create room" box;
main area shows the open room's messages; unread dot on rooms that receive a message while another room is open.

## HTTP (JSON). Everything except signup/signin/health needs `Authorization: Bearer <token>`

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/signup` | `{email, displayName, password(8+)}` | 201 `{token, user:{id, displayName}}` | 400 invalid, 409 email taken |
| POST | `/signin` | `{email, password}` | 200 `{token, user}` | 400, 401 wrong email/password |
| GET | `/rooms` | | `{rooms:[{id, name, members, joined}]}` | 401 |
| POST | `/rooms` | `{name}` (1-30 chars: letters, numbers, space, `-`, `_`; lowercased) | 201 `{room}` (creator is joined) | 400 invalid name, 409 name taken |
| POST | `/rooms/:id/join` | | 200 `{room}` (safe to call twice) | 400 bad id, 404 no such room |
| POST | `/rooms/:id/leave` | | 200 `{ok:true}` | |
| GET | `/rooms/:id/messages?after=N` | | `{messages:[...], headSeq}` | 403 not a member, 401 bad/expired token |
| GET | `/health` | | `{status:"ok"}` | 503 db down |

`GET /rooms/:id/messages?after=0` returns the room's last 50 messages. `after=N` returns that room's messages with seq > N (max 500).
`headSeq` is the newest seq in that room (0 if empty) and is never lower than the newest message in the same response.
A message looks like: `{seq, roomId, msgId, userId, from, text, serverTs}`. Tokens last 1 hour.

## WebSocket `/ws` (JSON frames)

```
client -> {type:"hello", token}                              FIRST frame, within 5 seconds
server -> {type:"ready"}                                     now catch up (below), then you may send
client -> {type:"msg", roomId, msgId:<uuid v4>, text}        text 1-2000 chars; only after "ready"
server -> {type:"msg", seq, roomId, msgId, userId, from, text, serverTs}   to every member of that room, sender included
server -> {type:"ack", msgId, seq}                           your send is saved
server -> {type:"error", code, msgId?}                       bad_json | invalid_msg | not_member | unavailable
```

One socket carries messages for all of the user's rooms; use `roomId` to route them in the UI.
Close codes: `4002` bad/expired token (sign in again, then reconnect), `4004` no hello in 5s, anything else: reconnect.
There is no app-level ping/pong; the browser answers protocol pings itself.

## Client rules (this is what makes it reliable)

1. Keep `token` and a **`lastSeq` per room** in storage (e.g. `{ [roomId]: lastSeq }`).
2. On every (re)connect: open socket -> send `hello` -> on `ready`: `GET /rooms`, then for each joined room fetch
   `/rooms/:id/messages?after=lastSeq[room]` and merge (you can fetch only the open room and the rest when opened).
3. Merge by `seq`; ignore anything with `seq <= lastSeq[room]`; render sorted by `seq`, never by time.
4. `seq` is one counter shared by all rooms, so inside a single room it only increases and has gaps. Never assume contiguous.
5. Create a `msgId` (uuid) per message. Show it as "pending" until its `ack` (or its echo) arrives.
   After a reconnect resend every unacked `msgId` (with the same `roomId`): the server ignores duplicates and re-acks.
6. Reconnect with exponential backoff + jitter (1s, 2s, 4s... capped ~30s); reset after `ready`.
7. If `lastSeq[room]` is greater than the `headSeq` returned for that room, the server database was reset: clear that room and set its `lastSeq = 0`.
8. On close code 4002: sign in again for a fresh token before reconnecting.
9. After `leave`, drop that room's local messages. A `not_member` error means the user is not in that room (any more).

## Demo accounts (after `npm run db:seed` on the real server), password `password123`

| Account | Rooms |
|---|---|
| `alice@test.com` | general, class-demo |
| `bob@test.com` | general, class-demo |
| `carol@test.com` | general (not class-demo: shows rooms are separate) |
| (anyone) | `random` exists but has no members: use it to try Join |

The mock server accepts any email and a password of 8+ characters and has the same rooms (alice and bob are members of general and class-demo).
