// Automated end-to-end check of the running server.  Start the server first, seed the DB, then:
//   npm run smoke
// (HTTPS with mkcert:  export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem")
// It creates a few throwaway users/rooms each run; that is harmless.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const BASE_URL = process.env.BASE_URL ?? "https://localhost:8443";
const WS_URL = BASE_URL.replace(/^http/, "ws") + "/ws";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failed++;
}

async function api(path: string, opts: { method?: string; body?: object; token?: string } = {}) {
  const res = await fetch(BASE_URL + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function login(email: string) {
  const r = await api("/signin", { body: { email, password: "password123" } });
  if (r.status !== 200) throw new Error(`signin ${email} failed (${r.status}). Did you run: npm run db:seed ?`);
  return r.json.token as string;
}

async function roomsOf(token: string) {
  const r = await api("/rooms", { token });
  return (r.json.rooms ?? []) as { id: string; name: string; joined: boolean }[];
}

function openSocket(token: string) {
  const ws = new WebSocket(WS_URL);
  const frames: any[] = [];
  let closeCode: number | null = null;
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("close", (code) => (closeCode = code));
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token })));
  const waitFor = async (pred: (f: any) => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = frames.find(pred);
      if (f) return f;
      await sleep(25);
    }
    return null;
  };
  const sendMsg = (roomId: string, msgId: string, text: string) =>
    ws.send(JSON.stringify({ type: "msg", roomId, msgId, text }));
  const got = (msgId: string) => frames.some((f) => f.type === "msg" && f.msgId === msgId);
  return { ws, frames, waitFor, sendMsg, got, closeCode: () => closeCode };
}

async function main() {
  console.log(`Testing ${BASE_URL}\n`);

  // ---------- accounts ----------
  const health = await api("/health");
  check("GET /health is ok", health.status === 200 && health.json.status === "ok");
  check("GET /rooms without token -> 401", (await api("/rooms")).status === 401);
  const wrong = await api("/signin", { body: { email: "alice@test.com", password: "wrong-password" } });
  check("signin with wrong password -> 401", wrong.status === 401);

  const email = `smoke-${randomUUID().slice(0, 8)}@test.com`;
  const su = await api("/signup", { body: { email, password: "password123", displayName: "smoke" } });
  check("signup creates a user (201 + token)", su.status === 201 && !!su.json.token);
  check("signup with same email -> 409", (await api("/signup", { body: { email, password: "password123", displayName: "smoke" } })).status === 409);
  check("signup with short password -> 400", (await api("/signup", { body: { email: "x@test.com", password: "short", displayName: "x" } })).status === 400);

  const newUserRooms = await roomsOf(su.json.token);
  check("new account is auto-joined to 'general'", newUserRooms.find((r) => r.name === "general")?.joined === true);

  const aliceToken = await login("alice@test.com");
  const bobToken = await login("bob@test.com");
  const carolToken = await login("carol@test.com");

  // ---------- rooms ----------
  const aliceRooms = await roomsOf(aliceToken);
  const carolRooms = await roomsOf(carolToken);
  const general = aliceRooms.find((r) => r.name === "general")!;
  const classDemo = aliceRooms.find((r) => r.name === "class-demo")!;
  check("alice sees general + class-demo as joined", general?.joined === true && classDemo?.joined === true);
  check("carol sees class-demo but has not joined it", carolRooms.find((r) => r.name === "class-demo")?.joined === false);

  const bad = openSocket("not-a-real-token");
  await sleep(500);
  check("socket with bad token is closed with 4002", bad.closeCode() === 4002, `got ${bad.closeCode()}`);

  const alice = openSocket(aliceToken);
  const bob = openSocket(bobToken);
  const carol = openSocket(carolToken);
  check("alice, bob, carol are ready", !!(await alice.waitFor((f) => f.type === "ready")) && !!(await bob.waitFor((f) => f.type === "ready")) && !!(await carol.waitFor((f) => f.type === "ready")));

  // ---------- live delivery in a room ----------
  const id1 = randomUUID();
  alice.sendMsg(general.id, id1, "hello general");
  const ack1 = await alice.waitFor((f) => f.type === "ack" && f.msgId === id1);
  const bobGot = await bob.waitFor((f) => f.type === "msg" && f.msgId === id1);
  const carolGot = await carol.waitFor((f) => f.type === "msg" && f.msgId === id1);
  check("alice receives ack", !!ack1);
  check("bob and carol receive it with the same seq and roomId", !!bobGot && !!carolGot && bobGot.seq === ack1?.seq && carolGot.seq === ack1?.seq && bobGot.roomId === general.id);

  // ---------- duplicates ----------
  const before = bob.frames.filter((f) => f.msgId === id1 && f.type === "msg").length;
  alice.sendMsg(general.id, id1, "hello general");
  await sleep(400);
  const acks = alice.frames.filter((f) => f.type === "ack" && f.msgId === id1);
  check("duplicate send is re-acked with the same seq", acks.length === 2 && acks[1].seq === acks[0].seq);
  check("duplicate send is NOT broadcast again", bob.frames.filter((f) => f.msgId === id1 && f.type === "msg").length === before);

  // ---------- validation ----------
  alice.sendMsg(general.id, "not-a-uuid", "x");
  check("invalid msgId -> error invalid_msg", !!(await alice.waitFor((f) => f.type === "error" && f.code === "invalid_msg")));
  alice.ws.send(JSON.stringify({ type: "msg", msgId: randomUUID(), text: "no room" }));
  await sleep(300);
  check("missing roomId -> error invalid_msg", alice.frames.filter((f) => f.type === "error" && f.code === "invalid_msg").length >= 2);

  // ---------- rooms are isolated ----------
  const id2 = randomUUID();
  alice.sendMsg(classDemo.id, id2, "only alice and bob");
  check("bob (member) receives a class-demo message", !!(await bob.waitFor((f) => f.type === "msg" && f.msgId === id2)));
  await sleep(400);
  check("carol (not a member) does NOT receive it", !carol.got(id2));

  const id3 = randomUUID();
  carol.sendMsg(classDemo.id, id3, "let me in");
  check("carol sending to a room she has not joined -> not_member", !!(await carol.waitFor((f) => f.type === "error" && f.code === "not_member" && f.msgId === id3)));
  check("carol reading that room over HTTP -> 403", (await api(`/rooms/${classDemo.id}/messages`, { token: carolToken })).status === 403);
  const id4 = randomUUID();
  alice.sendMsg(randomUUID(), id4, "nowhere");
  check("sending to a room that does not exist -> not_member", !!(await alice.waitFor((f) => f.type === "error" && f.code === "not_member" && f.msgId === id4)));

  // ---------- create / join ----------
  const name = `smoke-${randomUUID().slice(0, 6)}`;
  const created = await api("/rooms", { token: aliceToken, body: { name } });
  check("create room -> 201 and creator is joined", created.status === 201 && created.json.room?.joined === true);
  check("create room with an existing name -> 409", (await api("/rooms", { token: bobToken, body: { name } })).status === 409);
  check("create room with an invalid name -> 400", (await api("/rooms", { token: bobToken, body: { name: "!!bad" } })).status === 400);
  const roomId = created.json.room.id as string;

  check("bob cannot read the new room before joining (403)", (await api(`/rooms/${roomId}/messages`, { token: bobToken })).status === 403);
  const idEarly = randomUUID();
  alice.sendMsg(roomId, idEarly, "written before bob joined");
  await alice.waitFor((f) => f.type === "ack" && f.msgId === idEarly);
  check("bob joins the room -> 200", (await api(`/rooms/${roomId}/join`, { token: bobToken, method: "POST" })).status === 200);
  const history = await api(`/rooms/${roomId}/messages?after=0`, { token: bobToken });
  check("after joining, bob can read the room's history", history.status === 200 && history.json.messages.some((m: any) => m.msgId === idEarly));
  const id5 = randomUUID();
  alice.sendMsg(roomId, id5, "bob is here now");
  check("bob receives live messages from the room he joined", !!(await bob.waitFor((f) => f.type === "msg" && f.msgId === id5)));
  await sleep(300);
  check("carol (never joined) does not receive them", !carol.got(id5) && !carol.got(idEarly));

  // ---------- reconnect / catch-up ----------
  const bobLastGeneral = bobGot.seq as number;
  bob.ws.terminate();
  const missed = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of missed.entries()) alice.sendMsg(general.id, id, `missed ${i}`);
  await alice.waitFor((f) => f.type === "ack" && f.msgId === missed[2]);
  const catchUp = await api(`/rooms/${general.id}/messages?after=${bobLastGeneral}`, { token: bobToken });
  const seqs: number[] = catchUp.json.messages?.map((m: any) => m.seq) ?? [];
  check("catch-up returns exactly the 3 missed messages of that room", seqs.length === 3, JSON.stringify(seqs));
  check("catch-up is in increasing seq order", seqs.every((s, i) => i === 0 || s > seqs[i - 1]));

  // ---------- concurrency ----------
  const ids = Array.from({ length: 30 }, () => randomUUID());
  ids.forEach((id, i) => alice.sendMsg(general.id, id, `burst ${i}`));
  // messages arrive in the order the server processed them, not the order they were sent: wait for all 30
  const countSeen = () => carol.frames.filter((f) => f.type === "msg" && ids.includes(f.msgId)).length;
  for (let i = 0; i < 200 && countSeen() < 30; i++) await sleep(25);
  const seen = carol.frames.filter((f) => f.type === "msg" && ids.includes(f.msgId)).map((f) => f.seq);
  check("30 concurrent sends all delivered", seen.length === 30, `got ${seen.length}`);
  check("30 concurrent sends have unique, increasing seq", new Set(seen).size === 30 && seen.every((s, i) => i === 0 || s > seen[i - 1]));

  const first = await api(`/rooms/${general.id}/messages?after=0`, { token: aliceToken });
  const firstSeqs: number[] = first.json.messages?.map((m: any) => m.seq) ?? [];
  check("first load returns at most 50 messages, in order, ending with the newest", firstSeqs.length > 0 && firstSeqs.length <= 50 && firstSeqs.every((s, i) => i === 0 || s > firstSeqs[i - 1]) && first.json.headSeq === firstSeqs[firstSeqs.length - 1]);

  // ---------- leave / rejoin ----------
  check("carol leaves general -> 200", (await api(`/rooms/${general.id}/leave`, { token: carolToken, method: "POST" })).status === 200);
  const id6 = randomUUID();
  alice.sendMsg(general.id, id6, "carol already left");
  await alice.waitFor((f) => f.type === "ack" && f.msgId === id6);
  await sleep(300);
  check("after leaving, carol no longer receives that room's messages", !carol.got(id6));
  check("after leaving, carol cannot read the room (403)", (await api(`/rooms/${general.id}/messages`, { token: carolToken })).status === 403);
  check("carol rejoins general -> 200 (restores the demo state)", (await api(`/rooms/${general.id}/join`, { token: carolToken, method: "POST" })).status === 200);

  [alice.ws, bob.ws, carol.ws].forEach((w) => w.terminate());
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e.message);
  process.exit(1);
});
