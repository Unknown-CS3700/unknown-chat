import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db, users } from "../db";

export default async function signin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ message: "email and password are required" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, String(email).trim().toLowerCase()));

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    const token = jwt.sign({ name: user.displayName }, process.env.JWT_SECRET!, {
      subject: user.id,
      expiresIn: "1h",
    });
    res.json({ token, user: { id: user.id, displayName: user.displayName } });
  } catch (e: any) {
    console.error("signin failed:", e.message);
    res.status(500).json({ message: "Server error" });
  }
}
