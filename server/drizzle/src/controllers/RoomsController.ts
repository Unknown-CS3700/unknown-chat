import { asc, count, eq, and } from "drizzle-orm";
import { Response } from "express";
import { db, roomMembers, rooms } from "../db";
import { AuthRequest } from "../middleware/authMiddleware";
import { isUuid } from "../utils";

const ROOM_NAME = /^[a-z0-9][a-z0-9 _-]{0,29}$/;

// GET /rooms -> every room, with member count and whether I have joined it
export async function listRooms(req: AuthRequest, res: Response) {
  try {
    const all = await db
      .select({ id: rooms.id, name: rooms.name, members: count(roomMembers.userId) })
      .from(rooms)
      .leftJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .groupBy(rooms.id, rooms.name)
      .orderBy(asc(rooms.name));

    const mine = await db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(eq(roomMembers.userId, req.user!.id));
    const joined = new Set(mine.map((m) => m.roomId));

    res.json({ rooms: all.map((r) => ({ ...r, joined: joined.has(r.id) })) });
  } catch (e: any) {
    console.error("listRooms failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /rooms {name} -> create a room and join it
export async function createRoom(req: AuthRequest, res: Response) {
  const name = String(req.body?.name ?? "").trim().toLowerCase();
  if (!ROOM_NAME.test(name)) {
    res.status(400).json({ message: "Room name: 1-30 characters, letters/numbers/space/-/_" });
    return;
  }

  try {
    const room = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(rooms)
        .values({ name, createdBy: req.user!.id })
        .returning({ id: rooms.id, name: rooms.name });
      await tx.insert(roomMembers).values({ roomId: created.id, userId: req.user!.id });
      return created;
    });
    res.status(201).json({ room: { ...room, members: 1, joined: true } });
  } catch (e: any) {
    if ((e.code ?? e.cause?.code) === "23505") {
      res.status(409).json({ message: "A room with that name already exists" });
      return;
    }
    console.error("createRoom failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /rooms/:id/join -> become a member (safe to call twice)
export async function joinRoom(req: AuthRequest, res: Response) {
  const roomId = req.params.id;
  if (!isUuid(roomId)) {
    res.status(400).json({ message: "Invalid room id" });
    return;
  }

  try {
    const [room] = await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.id, roomId));
    if (!room) {
      res.status(404).json({ message: "Room not found" });
      return;
    }
    await db.insert(roomMembers).values({ roomId, userId: req.user!.id }).onConflictDoNothing();
    res.json({ room: { ...room, joined: true } });
  } catch (e: any) {
    console.error("joinRoom failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /rooms/:id/leave -> stop being a member (you no longer receive or can read its messages)
export async function leaveRoom(req: AuthRequest, res: Response) {
  const roomId = req.params.id;
  if (!isUuid(roomId)) {
    res.status(400).json({ message: "Invalid room id" });
    return;
  }

  try {
    await db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, req.user!.id)));
    res.json({ ok: true });
  } catch (e: any) {
    console.error("leaveRoom failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}
