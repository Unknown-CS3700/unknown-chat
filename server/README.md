# Chat server

Express + WebSockets (WSS) + PostgreSQL through the Drizzle ORM. Users chat in **rooms** (public channels).

```
src/
├── index.ts                 start HTTP(S) server + attach WebSocket
├── socket.ts                /ws: hello -> msg -> check membership -> save -> send to room members -> ack
├── routes/routes.ts         /signup /signin /rooms /rooms/:id/(join|leave|messages) /health
├── controllers/             SignUp, Signin, Rooms, Messages controllers
├── middleware/              authMiddleware (Bearer JWT)
├── db/                      schema.ts (tables), index.ts (connection), seed.ts (demo data)
├── mockServer.ts            fake backend for the frontend dev (no database)
├── devClient.ts             terminal chat client (rooms commands)
└── smoke.ts                 automated end-to-end check (39 checks)
drizzle/                     generated SQL migration (committed)
docs/API.md                  the contract for the frontend
```

## Setup (about 5 minutes)

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL and set JWT_SECRET:  openssl rand -hex 32
createdb chatapp
npm run db:setup              # creates the tables + seeds demo users, rooms and messages
npm run dev
```

If `chatapp` already has tables from an earlier version (raw-SQL setup, or the first zip without rooms), recreate it,
otherwise the migration fails with "relation already exists" or the tables don't match:

```bash
dropdb chatapp && createdb chatapp && npm run db:setup
```

Local HTTPS (WSS) with mkcert, once:

```bash
brew install mkcert && mkcert -install
mkdir -p ../certs
mkcert -cert-file ../certs/localhost.pem -key-file ../certs/localhost-key.pem localhost 127.0.0.1 ::1
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"     # needed in each terminal that runs a Node client
```

Leave `TLS_KEY_PATH` / `TLS_CERT_PATH` empty in `.env` to run plain HTTP (for a tunnel or hosting that provides TLS).

## Rooms: who do users talk to?

- Every user can list rooms, **join** one, **create** one, or **leave** one.
- New accounts are auto-joined to `general`.
- Only members receive a room's messages and can read its history. The server checks membership on every send and read.
- Seeded: `general` (alice, bob, carol), `class-demo` (alice, bob only), `random` (empty, to try joining).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with auto-reload |
| `npm run db:setup` | Apply migrations, then seed |
| `npm run db:generate` | After editing `src/db/schema.ts`: create a new migration |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Insert demo data (safe to repeat) |
| `npm run db:studio` | Browse the database in the browser (like pgAdmin) |
| `npm run smoke` | End-to-end check of a running server |
| `npm run client -- bob@test.com bob` | Terminal chat client |
| `npm run mock` | Fake backend on :8080 for the frontend developer |
| `npm run typecheck` | TypeScript check |

Seeded accounts: `alice@test.com`, `bob@test.com`, `carol@test.com`, password `password123`.

## Try the features (terminal client)

```bash
npm run client -- alice@test.com alice      # terminal 1
npm run client -- carol@test.com carol      # terminal 2
```

Client commands: `/rooms`, `/join <name>`, `/create <name>`, `/use <name>`, `/leave <name>`, `/drop`.
Anything else you type is sent to your current room.

```
- type in general in one terminal: the other sees it with the same #seq
- alice: /use class-demo, type something -> carol does NOT see it (not a member)
- carol: /join class-demo -> she now gets the room's history and live messages
- alice: /drop -> she reconnects and catches up on what carol sent meanwhile
```

## How it works (short version)

- Login is plain HTTPS (`/signin`) and returns a JWT. The WebSocket's first frame sends that token (`hello`).
- Every saved message gets a global, increasing `seq` from Postgres and belongs to one room. Clients order by `seq`, never by time.
- The server checks the sender is a member, saves, sends the message only to that room's members, then acks the sender.
- Each message carries a client `msgId`; the DB unique constraint on `(user_id, msg_id)` turns retries into no-ops,
  so a resend never duplicates a message.
- After a disconnect the client calls `GET /rooms/:id/messages?after=<lastSeq>` per room and merges by `seq`.
- Saves go through a one-at-a-time queue so `seq` order always equals commit order (single server process).
- Dead connections are detected with a ping every 15 seconds. Known limit: one server instance, because the
  list of connected sockets lives in memory.
