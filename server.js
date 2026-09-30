import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("./.env", import.meta.url));
const { error: envError } = dotenv.config({ path: envPath, override: true });
if (envError) throw new Error("Unable to load the local .env file.", { cause: envError });

const { default: chatHandler } = await import("./api/chat.js");
const app = express();
const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));

app.use(express.json());
app.all("/api/chat", chatHandler);
app.get("/", (_req, res) => res.sendFile(indexPath));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`TestAllWater running at http://localhost:${port}`);
});
