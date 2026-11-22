import { and, asc, desc, eq, gt, max } from "drizzle-orm";
import { Response } from "express";
import { db, messages, roomMembers, users } from "../db";
import { AuthRequest } from "../middleware/authMiddleware";
import { isUuid } from "../utils";

export async function isMember(roomId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function memberIds(roomId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  return rows.map((r) => r.userId);
}

// Used by the socket. Saves one message at a time so seq order == commit order
// (Postgres sequences are not commit-ordered, so overlapping inserts could be seen out of order).
let queue: Promise<unknown> = Promise.resolve();

export function saveMessage(userId: string, name: string, roomId: string, msgId: string, text: string) {
  const run = queue.then(async () => {
    // ON CONFLICT DO NOTHING: a retry of the same (userId, msgId) inserts nothing
    const [inserted] = await db
      .insert(messages)
      .values({ roomId, userId, msgId, body: text })
      .onConflictDoNothing({ target: [messages.userId, messages.msgId] })
      .returning();

    const duplicate = !inserted;
    const row =
      inserted ??
      (await db
        .select()
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.msgId, msgId))))[0];

    return {
      duplicate,
      message: {
        seq: row.seq,
        roomId: row.roomId,
        msgId,
        userId,
        from: name,
        text: row.body,
        serverTs: row.createdAt,
      },
    };
  });
  queue = run.catch(() => undefined); // one failed save must not block later messages
  return run;
}

// GET /rooms/:id/messages?after=12 -> that room's messages after seq 12 (first load: the last 50)
export async function getRoomMessages(req: AuthRequest, res: Response) {
  const roomId = req.params.id;
  if (!isUuid(roomId)) {
    res.status(400).json({ message: "Invalid room id" });
    return;
  }

  try {
    if (!(await isMember(roomId, req.user!.id))) {
      res.status(403).json({ message: "Join this room first" });
      return;
    }

    const after = Number(req.query.after) || 0;
    let start = after;
    if (after === 0) {
      // first load: start just before the 50th most recent message of THIS room
      const last = await db
        .select({ seq: messages.seq })
        .from(messages)
        .where(eq(messages.roomId, roomId))
        .orderBy(desc(messages.seq))
        .limit(50);
      start = last.length ? last[last.length - 1].seq - 1 : 0;
    }

    const rows = await db
      .select({
        seq: messages.seq,
        roomId: messages.roomId,
        msgId: messages.msgId,
        userId: messages.userId,
        from: users.displayName,
        text: messages.body,
        serverTs: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.userId))
      .where(and(eq(messages.roomId, roomId), gt(messages.seq, start)))
      .orderBy(asc(messages.seq))
      .limit(500);

    // Read the head AFTER the rows: a message saved in between can only raise it, so
    // headSeq is never lower than the newest message returned (clients rely on that).
    const [{ head }] = await db
      .select({ head: max(messages.seq) })
      .from(messages)
      .where(eq(messages.roomId, roomId));
    const headSeq = Math.max(Number(head ?? 0), rows.length ? rows[rows.length - 1].seq : 0);

    res.json({ messages: rows, headSeq });
  } catch (e: any) {
    console.error("getRoomMessages failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}
