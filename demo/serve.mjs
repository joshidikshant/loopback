/**
 * Demo app server: serves demo/index.html and a deliberately broken backend —
 * POST /api/contact returns 500 with a database error. The frontend "works";
 * the backend doesn't. Run: node demo/serve.mjs  → http://127.0.0.1:5173
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || 5173);

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/contact") {
    // The bug an agent should find: backend rejects valid input.
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "DB_WRITE_FAILED",
        detail: "column \"message\" of relation \"contacts\" does not exist",
        hint: "migration 0042_add_message_column was never applied",
      }),
    );
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "index.html")));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`demo app on http://127.0.0.1:${PORT} (backend intentionally broken)`);
});
