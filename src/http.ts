/**
 * HTTP surface: stateless MCP (/mcp), widget ingestion (/ingest), pin hydration
 * (GET /feedback), a minimal human queue view (/queue), the embeddable widget
 * (/widget.js), and /health. CORS is open so the widget can post from any app
 * origin during dev; token-gate before exposing beyond localhost.
 * SSE is deliberately not offered (deprecated in Claude Code, unsupported in Codex).
 */

import express from "express";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoopbackStore } from "./store.js";
import { listSchema, submitSchema } from "./schemas.js";
import { SERVER_VERSION } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function createHttpApp(
  makeServer: () => McpServer,
  store: LoopbackStore,
): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // CORS: the widget posts from the host app's origin.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "loopback-mcp-server", version: SERVER_VERSION });
  });

  /** Embeddable capture widget. */
  app.get("/widget.js", (_req, res) => {
    try {
      const source = readFileSync(
        join(__dirname, "..", "widget", "loopback-widget.js"),
        "utf-8",
      );
      res.type("application/javascript").send(source);
    } catch {
      res.status(404).send("// widget file missing — reinstall loopback-mcp-server");
    }
  });

  /**
   * Plain JSON ingestion for non-MCP producers: the capture widget, CI hooks,
   * automation runs, cron ingestors polling Sentry/PostHog.
   */
  app.post("/ingest", (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "Invalid feedback payload",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const item = store.submit(parsed.data);
    res.status(201).json({ ok: true, id: item.id, item });
  });

  /** Pin hydration + programmatic reads: same filters as loopback_list_feedback. */
  app.get("/feedback", (req, res) => {
    const parsed = listSchema.safeParse({
      ...req.query,
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
      response_format: "json",
    });
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid query" });
      return;
    }
    const { response_format: _rf, ...filters } = parsed.data;
    res.json(store.list(filters));
  });

  /** Minimal human triage view — the cross-project queue at a glance. */
  app.get("/queue", (req, res) => {
    const project =
      typeof req.query.project === "string" ? req.query.project : undefined;
    const result = store.list({ project, limit: 100, offset: 0 });
    const rows = result.items
      .map(
        (i) => `<tr>
          <td><code>${escapeHtml(i.id)}</code></td>
          <td>${escapeHtml(i.project)}</td>
          <td>${escapeHtml(i.severity)}/${escapeHtml(i.type)}</td>
          <td>${escapeHtml(i.title)}</td>
          <td class="s-${escapeHtml(i.status)}">${escapeHtml(i.status)}</td>
          <td>${escapeHtml(i.assignee_agent ?? "—")}</td>
          <td>${i.links.pr_url ? `<a href="${escapeHtml(i.links.pr_url)}">PR</a>` : "—"}</td>
        </tr>`,
      )
      .join("\n");
    res.type("html").send(`<!doctype html><meta charset="utf-8">
<title>Loopback queue</title>
<style>
  body{font:14px/1.5 system-ui;margin:2rem;color:#111}
  table{border-collapse:collapse;width:100%}
  td,th{border-bottom:1px solid #e5e5e5;padding:.5rem .6rem;text-align:left;vertical-align:top}
  code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}
  .s-open{color:#b45309}.s-in_progress{color:#1d4ed8}.s-fixed{color:#047857}
  .s-verified{color:#047857;font-weight:600}.s-wontfix{color:#6b7280}
  h1{font-size:1.2rem}
</style>
<h1>Loopback queue ${project ? `— ${escapeHtml(project)}` : "(all projects)"} · ${result.total} items</h1>
<table><tr><th>id</th><th>project</th><th>sev/type</th><th>title</th><th>status</th><th>assignee</th><th>change</th></tr>
${rows || "<tr><td colspan=7>Queue is empty.</td></tr>"}
</table>`);
  });

  // Stateless MCP: fresh server+transport per request (no session state, no SSE).
  app.post("/mcp", async (req, res) => {
    try {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. This server is stateless: POST /mcp only.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
