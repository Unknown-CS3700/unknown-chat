import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db, roomMembers, rooms, users } from "../db";

export default async function signup(req: Request, res: Response) {
  const { email, password, displayName } = req.body ?? {};
  if (!email || !displayName || !password || password.length < 8) {
    res.status(400).json({ message: "email, displayName and a password (8+ chars) are required" });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const [user] = await db
      .insert(users)
      .values({
        email: String(email).trim().toLowerCase(),
        passwordHash,
        displayName: String(displayName).trim(),
      })
      .returning({ id: users.id, displayName: users.displayName });

    // New accounts start in the "general" room so they are never in an empty app
    const [general] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.name, "general"));
    if (general) {
      await db.insert(roomMembers).values({ roomId: general.id, userId: user.id }).onConflictDoNothing();
    }

    const token = jwt.sign({ name: user.displayName }, process.env.JWT_SECRET!, {
      subject: user.id,
      expiresIn: "1h",
    });
    res.status(201).json({ token, user });
  } catch (e: any) {
    // Drizzle wraps the pg error, so check both places for the unique-violation code
    if ((e.code ?? e.cause?.code) === "23505") {
      res.status(409).json({ message: "Email already registered" });
      return;
    }
    console.error("signup failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}
