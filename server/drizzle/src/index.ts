import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import router from "./routes/routes";
import { setupSocket } from "./socket";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set (copy .env.example to .env)");

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",") }));
app.use(express.json({ limit: "10kb" }));
app.use("/", router);

// HTTPS locally with mkcert; plain HTTP when a host/tunnel provides TLS
const { TLS_KEY_PATH, TLS_CERT_PATH } = process.env;
const server =
  TLS_KEY_PATH && TLS_CERT_PATH
    ? https.createServer({ key: fs.readFileSync(TLS_KEY_PATH), cert: fs.readFileSync(TLS_CERT_PATH) }, app)
    : http.createServer(app);

setupSocket(server);

const PORT = Number(process.env.PORT ?? 8443);
server.listen(PORT, () => {
  const secure = TLS_KEY_PATH && TLS_CERT_PATH;
  console.log(`listening on ${secure ? "https/wss" : "http/ws"}://localhost:${PORT}`);
});
