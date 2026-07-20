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

/**
 * The design system, read from disk once and inlined into the queue page.
 * One source of truth shared with `design/` and the published shadcn registry;
 * inlining keeps the page a single request with no asset pipeline.
 */
let designCssCache: string | null = null;
function designCss(): string {
  if (designCssCache !== null) return designCssCache;
  const read = (name: string): string => {
    try {
      return readFileSync(join(__dirname, "..", "design", name), "utf-8");
    } catch {
      return "";
    }
  };
  designCssCache = `${read("tokens.css")}\n${read("components.css")}`;
  return designCssCache;
}

/**
 * Origin this request came in on, so the queue page's own widget talks back to
 * the same instance whether that's 127.0.0.1, a LAN IP (--host), or a proxy.
 */
function selfOrigin(req: express.Request): string {
  const host = req.get("host") ?? "127.0.0.1:7077";
  return `${req.protocol}://${host}`;
}

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

  /** Single item with its full trail — the read behind the queue's detail rows. */
  app.get("/feedback/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) {
      res.status(404).json({
        ok: false,
        error: `Feedback '${req.params.id}' not found.`,
        hint: "List valid ids at GET /feedback",
      });
      return;
    }
    res.json(item);
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

  /**
   * Human triage view — the cross-project queue, built on the Loopback design
   * system. Rows expand in place to the item's full trail (captured context,
   * linked change, comments) so a human can audit a fix without an agent.
   */
  app.get("/queue", (req, res) => {
    const project =
      typeof req.query.project === "string" ? req.query.project : undefined;
    const result = store.list({ project, limit: 100, offset: 0 });

    const counts = new Map<string, number>();
    for (const i of result.items) {
      counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .map(
        ([status, n]) =>
          `<span class="lb-badge lb-badge--${escapeHtml(status)}">${n} ${escapeHtml(status)}</span>`,
      )
      .join(" ");

    const kv = (label: string, value: string): string =>
      `<div class="kv"><span class="lb-label">${escapeHtml(label)}</span><div>${value}</div></div>`;
    const pre = (text: string): string =>
      `<pre class="lb-pre">${escapeHtml(text)}</pre>`;

    const detailFor = (id: string): string => {
      const full = store.get(id);
      if (!full) return "";
      const parts: string[] = [];
      if (full.body) parts.push(kv("Report", `<div class="body">${escapeHtml(full.body)}</div>`));
      if (full.repro_steps.length) {
        parts.push(
          kv(
            "Repro steps",
            `<ol class="steps">${full.repro_steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`,
          ),
        );
      }
      // The money shot: a frontend pin carrying the backend's own error body.
      const failed = (full.extra as { failed_responses?: { url: string; status: number; body: string }[] })
        .failed_responses;
      if (Array.isArray(failed) && failed.length) {
        parts.push(
          kv(
            "Failed requests",
            failed
              .map((f) => `<div class="fail"><code class="lb-mono">${escapeHtml(String(f.status))} ${escapeHtml(f.url)}</code>${pre(f.body ?? "")}</div>`)
              .join(""),
          ),
        );
      } else if (full.network.length) {
        parts.push(
          kv(
            "Network",
            full.network
              .map((n) => `<code class="lb-mono">${escapeHtml(n.method ?? "GET")} ${escapeHtml(n.url)} → ${escapeHtml(String(n.status ?? "?"))}</code>`)
              .join("<br>"),
          ),
        );
      }
      const ctx = (full.extra as { context?: Record<string, unknown> }).context;
      if (ctx) parts.push(kv("Run context", pre(JSON.stringify(ctx, null, 2))));
      if (full.console.length) parts.push(kv("Console", pre(full.console.join("\n"))));

      const linkBits = Object.entries(full.links)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) =>
          k === "pr_url"
            ? `<a href="${escapeHtml(String(v))}">${escapeHtml(String(v))}</a>`
            : `<span class="lb-muted">${escapeHtml(k)}:</span> <code class="lb-mono">${escapeHtml(String(v))}</code>`,
        );
      if (linkBits.length) parts.push(kv("Linked change", linkBits.join("<br>")));

      if (full.comments?.length) {
        parts.push(
          kv(
            `Trail (${full.comments.length})`,
            full.comments
              .map(
                (c) =>
                  `<div class="comment"><div class="lb-muted">${escapeHtml(c.author)} · ${escapeHtml(c.created_at)}</div><div class="body">${escapeHtml(c.body)}</div></div>`,
              )
              .join(""),
          ),
        );
      }
      if (full.dom_selector) {
        parts.push(kv("Anchor", `<code class="lb-mono">${escapeHtml(full.dom_selector)}</code>`));
      }
      return parts.join("") || `<span class="lb-muted">No further context captured.</span>`;
    };

    const rows = result.items
      .map((i) => {
        const change = i.links.pr_url
          ? `<a href="${escapeHtml(i.links.pr_url)}">PR</a>`
          : i.links.commit
            ? `<code class="lb-mono">${escapeHtml(i.links.commit.slice(0, 9))}</code>`
            : `<span class="lb-muted">—</span>`;
        return `<tr class="row" data-id="${escapeHtml(i.id)}" tabindex="0" aria-expanded="false">
  <td><span class="chev" aria-hidden="true">▸</span> <code class="lb-mono">${escapeHtml(i.id)}</code></td>
  <td>${escapeHtml(i.project)}</td>
  <td><span class="lb-sev lb-sev--${escapeHtml(i.severity)}">${escapeHtml(i.severity)}</span> <span class="lb-muted">${escapeHtml(i.type)}</span></td>
  <td class="ttl">${escapeHtml(i.title)}</td>
  <td><span class="lb-badge lb-badge--${escapeHtml(i.status)}">${escapeHtml(i.status)}</span></td>
  <td>${i.assignee_agent ? escapeHtml(i.assignee_agent) : `<span class="lb-muted">—</span>`}</td>
  <td>${change}</td>
</tr>
<tr class="detail" hidden><td colspan="7"><div class="detail-inner">${detailFor(i.id)}</div></td></tr>`;
      })
      .join("\n");

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loopback queue${project ? ` — ${escapeHtml(project)}` : ""}</title>
<script>
  // Resolve the theme before first paint. A class applied after hydration is
  // exactly the flash-of-wrong-theme bug this project has filed against others.
  (function () {
    try {
      var stored = localStorage.getItem("lb-theme");
      var dark = stored ? stored === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      if (dark) document.documentElement.classList.add("dark");
    } catch (e) {}
  })();
</script>
<style>
${designCss()}
  html { color-scheme: light; }
  html.dark { color-scheme: dark; }
  body { padding: 2rem 1.5rem; max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: .35rem; }
  .counts { display: flex; gap: .35rem; flex-wrap: wrap; margin: .75rem 0 1rem; }
  .bar { display: flex; align-items: center; gap: .5rem; margin-left: auto; }
  .row { cursor: pointer; }
  .row .chev { display: inline-block; width: .7em; color: var(--muted-foreground); transition: transform .15s; }
  .row[aria-expanded="true"] .chev { transform: rotate(90deg); }
  .row .ttl { font-weight: 500; }
  .detail td { background: var(--muted); }
  .detail-inner { display: grid; gap: .85rem; padding: .35rem .25rem .6rem; }
  .kv { display: grid; gap: .25rem; }
  .body { white-space: pre-wrap; font-size: .8125rem; }
  .steps { margin: 0; padding-left: 1.1rem; font-size: .8125rem; }
  .comment { border-left: 2px solid var(--border); padding-left: .6rem; margin-bottom: .5rem; }
  .fail { margin-bottom: .5rem; }
  .lb-pre { margin: .2rem 0 0; padding: .5rem .6rem; background: var(--background); border: 1px solid var(--border);
            border-radius: var(--radius-sm); font-family: var(--lb-font-mono); font-size: .75rem;
            white-space: pre-wrap; overflow-x: auto; }
  a { color: var(--foreground); }
</style>
</head>
<body class="lb-body">
<header>
  <h1 class="lb-title">Loopback queue${project ? ` — ${escapeHtml(project)}` : ""}</h1>
  <span class="lb-muted">${result.total} item${result.total === 1 ? "" : "s"}${project ? "" : " · all projects"}</span>
  <div class="bar">
    <button class="lb-btn lb-btn--outline lb-btn--sm" id="theme">Theme</button>
  </div>
</header>
<p class="lb-muted">Something wrong or clumsy on <em>this</em> page? Pin it — feedback about Loopback
files to the <code class="lb-mono">loopback</code> project, the same loop everything else uses.
Click any row to read its full trail.</p>
<div class="counts">${summary}</div>
<table class="lb-table">
  <thead><tr><th>id</th><th>project</th><th>sev / type</th><th>title</th><th>status</th><th>assignee</th><th>change</th></tr></thead>
  <tbody>
${rows || `<tr><td colspan="7" class="lb-muted">Queue is empty.</td></tr>`}
  </tbody>
</table>
<script>
  document.querySelectorAll("tr.row").forEach(function (row) {
    function toggle() {
      var open = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", String(!open));
      row.nextElementSibling.hidden = open;
    }
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
  document.getElementById("theme").addEventListener("click", function () {
    var dark = document.documentElement.classList.toggle("dark");
    try { localStorage.setItem("lb-theme", dark ? "dark" : "light"); } catch (e) {}
  });
</script>
<!-- Loopback, pinnable by Loopback: the triage page is its own reference integration. -->
<script src="${escapeHtml(selfOrigin(req))}/widget.js"
        data-project="loopback"
        data-endpoint="${escapeHtml(selfOrigin(req))}"></script>
</body>
</html>`);
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
