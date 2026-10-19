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

// A malformed request body (e.g. invalid JSON) throws inside body-parser before chatHandler
// ever runs. Express's default error handler would otherwise return the raw error to the
// client, including a stack trace with local filesystem paths — never expose that, even on
// a local dev server. This must be registered after the routes and keep all four arguments
// (err, req, res, next) so Express recognizes it as an error-handling middleware.
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON in request body." });
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`TestAllWater running at http://localhost:${port}`);
});
