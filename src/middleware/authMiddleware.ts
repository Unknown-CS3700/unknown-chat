import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: { id: string; name: string };
}

export default function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "No token" });
    return;
  }
  try {
    const d = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as jwt.JwtPayload;
    req.user = { id: d.sub as string, name: d.name };
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}
