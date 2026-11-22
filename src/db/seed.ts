// Demo data. Safe to run many times (it never creates duplicates).
// Every demo account uses the password:  password123
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, messages, pool, roomMembers, rooms, users } from "./index";

const PASSWORD = "password123";

const demoUsers = [
  { email: "alice@test.com", displayName: "alice" },
  { email: "bob@test.com", displayName: "bob" },
  { email: "carol@test.com", displayName: "carol" },
];

// room name -> who is a member. carol is NOT in class-demo on purpose (shows rooms are separate).
const demoRooms: Record<string, string[]> = {
  general: ["alice@test.com", "bob@test.com", "carol@test.com"],
  "class-demo": ["alice@test.com", "bob@test.com"],
  random: [], // nobody has joined yet: use it to try "join"
};

// Fixed msgIds so re-seeding is ignored by the (user_id, msg_id) unique constraint
const demoMessages = [
  { room: "general", who: "alice@test.com", msgId: "00000000-0000-4000-8000-000000000001", body: "Hey everyone, welcome to the chat!" },
  { room: "general", who: "bob@test.com", msgId: "00000000-0000-4000-8000-000000000002", body: "Hi alice! Messages show up instantly." },
  { room: "general", who: "carol@test.com", msgId: "00000000-0000-4000-8000-000000000003", body: "Try dropping your connection, you will catch up on reconnect." },
  { room: "class-demo", who: "alice@test.com", msgId: "00000000-0000-4000-8000-000000000004", body: "This room is only for alice and bob. Carol cannot see it." },
];

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await db
    .insert(users)
    .values(demoUsers.map((u) => ({ ...u, passwordHash })))
    .onConflictDoNothing({ target: users.email });

  const userId = async (email: string) =>
    (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;
  const roomId = async (name: string) =>
    (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.name, name)))[0].id;

  for (const [name, members] of Object.entries(demoRooms)) {
    await db.insert(rooms).values({ name }).onConflictDoNothing({ target: rooms.name });
    const rid = await roomId(name);
    for (const email of members) {
      await db
        .insert(roomMembers)
        .values({ roomId: rid, userId: await userId(email) })
        .onConflictDoNothing();
    }
  }

  for (const m of demoMessages) {
    await db
      .insert(messages)
      .values({ roomId: await roomId(m.room), userId: await userId(m.who), msgId: m.msgId, body: m.body })
      .onConflictDoNothing({ target: [messages.userId, messages.msgId] });
  }

  console.log(
    `seeded ${demoUsers.length} users (password: ${PASSWORD}), ${Object.keys(demoRooms).length} rooms, ${demoMessages.length} messages`
  );
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
