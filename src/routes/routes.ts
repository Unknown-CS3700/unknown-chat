import express from "express";
import signup from "../controllers/SignUpController";
import signin from "../controllers/SigninController";
import { getRoomMessages } from "../controllers/MessagesController";
import { createRoom, joinRoom, leaveRoom, listRooms } from "../controllers/RoomsController";
import authMiddleware from "../middleware/authMiddleware";
import { pool } from "../db";

const router = express.Router();

//GET METHODS
router.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db_down" });
  }
});
router.get("/rooms", authMiddleware, listRooms);
router.get("/rooms/:id/messages", authMiddleware, getRoomMessages);

//POST METHODS
router.post("/signup", signup);
router.post("/signin", signin);
router.post("/rooms", authMiddleware, createRoom);
router.post("/rooms/:id/join", authMiddleware, joinRoom);
router.post("/rooms/:id/leave", authMiddleware, leaveRoom);

export default router;
