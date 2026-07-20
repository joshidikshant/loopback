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
import type { FeedbackItem } from "./types.js";
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

const STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "fixed",
  "verified",
  "wontfix",
] as const;

/**
 * CSRF guard for the state-changing triage endpoints.
 *
 * The server is unauthenticated and CORS is deliberately wide open, because
 * the capture widget has to POST /ingest from whatever origin the host app
 * runs on. That is an acceptable trade for an append-only intake endpoint —
 * but it must NOT extend to mutating an item's status or audit trail, or any
 * page you happen to visit could quietly rewrite your queue. These endpoints
 * therefore require a same-origin submission: browsers always attach Origin to
 * a cross-origin POST, so a foreign page is rejected, while local tooling
 * (curl, scripts) that sends no Origin still works.
 */
function sameOriginOnly(
  req: express.Request,
  res: express.Response,
): boolean {
  const origin = req.get("origin");
  if (!origin) return true; // curl / server-side tooling
  if (origin === selfOrigin(req)) return true;
  res.status(403).json({
    ok: false,
    error: "Cross-origin writes are not allowed on triage endpoints.",
    hint: "Use the /queue UI on this origin, the MCP tools, or a local script.",
  });
  return false;
}

/** Shared page chrome for the queue and item views. */
function pageShell(req: express.Request, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
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
  .bar { display: flex; align-items: center; gap: .5rem; margin-left: auto; }
  .counts { display: flex; gap: .35rem; flex-wrap: wrap; margin: .75rem 0 1rem; }
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
  a.plain { text-decoration: none; }
  a.plain:hover { text-decoration: underline; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem;
          margin: 1rem 0; padding: 1rem; }
  .actions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1.25rem; }
  @media (max-width: 720px) { .actions-grid { grid-template-columns: 1fr; } }
  form.act { display: grid; gap: .5rem; }
  .inline { display: flex; gap: .5rem; align-items: center; }
  .flash { margin: .75rem 0; }
</style>
</head>
<body class="lb-body">
${body}
<script>
  var t = document.getElementById("theme");
  if (t) t.addEventListener("click", function () {
    var dark = document.documentElement.classList.toggle("dark");
    try { localStorage.setItem("lb-theme", dark ? "dark" : "light"); } catch (e) {}
  });
  document.querySelectorAll("tr.row").forEach(function (row) {
    function toggle(e) {
      if (e.target.closest("a")) return; // let the id link through
      var open = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", String(!open));
      row.nextElementSibling.hidden = open;
    }
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); }
    });
  });
</script>
<!-- Loopback, pinnable by Loopback: these pages are its own reference integration. -->
<script src="${escapeHtml(selfOrigin(req))}/widget.js"
        data-project="loopback"
        data-endpoint="${escapeHtml(selfOrigin(req))}"></script>
</body>
</html>`;
}

/**
 * The captured context of one item, rendered as labelled sections. Shared by
 * the queue's inline expansion and the full item view so the two can never
 * disagree about what an item contains.
 */
function itemSections(item: FeedbackItem, opts: { full: boolean }): string {
  const parts: string[] = [];
  const kv = (label: string, value: string): string =>
    `<div class="kv"><span class="lb-label">${escapeHtml(label)}</span><div>${value}</div></div>`;
  const pre = (text: string): string => `<pre class="lb-pre">${escapeHtml(text)}</pre>`;

  if (item.body) parts.push(kv("Report", `<div class="body">${escapeHtml(item.body)}</div>`));
  if (item.repro_steps.length) {
    parts.push(
      kv(
        "Repro steps",
        `<ol class="steps">${item.repro_steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`,
      ),
    );
  }

  // The money shot: a frontend pin carrying the backend's own error body.
  const failed = (item.extra as { failed_responses?: { url: string; status: number; body: string }[] })
    .failed_responses;
  if (Array.isArray(failed) && failed.length) {
    parts.push(
      kv(
        "Failed requests",
        failed
          .map(
            (f) =>
              `<div class="fail"><code class="lb-mono">${escapeHtml(String(f.status))} ${escapeHtml(f.url)}</code>${pre(f.body ?? "")}</div>`,
          )
          .join(""),
      ),
    );
  }
  if (item.network.length && (opts.full || !failed?.length)) {
    const rows = opts.full ? item.network : item.network.slice(-5);
    parts.push(
      kv(
        `Network${opts.full ? ` (${item.network.length})` : ""}`,
        rows
          .map(
            (n) =>
              `<code class="lb-mono">${escapeHtml(n.method ?? "GET")} ${escapeHtml(n.url)} → ${escapeHtml(String(n.status ?? "?"))}${n.ms !== undefined ? ` (${escapeHtml(String(n.ms))}ms)` : ""}</code>`,
          )
          .join("<br>"),
      ),
    );
  }

  const ctx = (item.extra as { context?: Record<string, unknown> }).context;
  if (ctx) parts.push(kv("Run context", pre(JSON.stringify(ctx, null, 2))));
  if (item.console.length) {
    const lines = opts.full ? item.console : item.console.slice(-10);
    parts.push(kv(`Console${opts.full ? ` (${item.console.length})` : ""}`, pre(lines.join("\n"))));
  }

  const linkBits = Object.entries(item.links)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) =>
      k === "pr_url"
        ? `<a href="${escapeHtml(String(v))}">${escapeHtml(String(v))}</a>`
        : `<span class="lb-muted">${escapeHtml(k)}:</span> <code class="lb-mono">${escapeHtml(String(v))}</code>`,
    );
  if (linkBits.length) parts.push(kv("Linked change", linkBits.join("<br>")));

  if (item.comments?.length) {
    parts.push(
      kv(
        `Trail (${item.comments.length})`,
        item.comments
          .map(
            (c) =>
              `<div class="comment"><div class="lb-muted">${escapeHtml(c.author)} · ${escapeHtml(c.created_at)}</div><div class="body">${escapeHtml(c.body)}</div></div>`,
          )
          .join(""),
      ),
    );
  }
  if (item.dom_selector) {
    parts.push(kv("Anchor", `<code class="lb-mono">${escapeHtml(item.dom_selector)}</code>`));
  }
  if (opts.full) {
    const rest = { ...item.extra } as Record<string, unknown>;
    delete rest.context;
    delete rest.failed_responses;
    if (Object.keys(rest).length) {
      parts.push(kv("Captured environment", pre(JSON.stringify(rest, null, 2))));
    }
  }
  return parts.join("") || `<span class="lb-muted">No further context captured.</span>`;
}

export function createHttpApp(
  makeServer: () => McpServer,
  store: LoopbackStore,
): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Triage actions post as plain HTML forms so they work without JavaScript.
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

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
   * system. Rows expand in place for a quick read; the id links to the full
   * item view, which is where a human can actually act on it.
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

    const rows = result.items
      .map((i) => {
        const change = i.links.pr_url
          ? `<a href="${escapeHtml(i.links.pr_url)}">PR</a>`
          : i.links.commit
            ? `<code class="lb-mono">${escapeHtml(i.links.commit.slice(0, 9))}</code>`
            : `<span class="lb-muted">—</span>`;
        const full = store.get(i.id);
        return `<tr class="row" data-id="${escapeHtml(i.id)}" tabindex="0" aria-expanded="false">
  <td><span class="chev" aria-hidden="true">▸</span> <a class="plain" href="/queue/${encodeURIComponent(i.id)}"><code class="lb-mono">${escapeHtml(i.id)}</code></a></td>
  <td>${escapeHtml(i.project)}</td>
  <td><span class="lb-sev lb-sev--${escapeHtml(i.severity)}">${escapeHtml(i.severity)}</span> <span class="lb-muted">${escapeHtml(i.type)}</span></td>
  <td class="ttl">${escapeHtml(i.title)}</td>
  <td><span class="lb-badge lb-badge--${escapeHtml(i.status)}">${escapeHtml(i.status)}</span></td>
  <td>${i.assignee_agent ? escapeHtml(i.assignee_agent) : `<span class="lb-muted">—</span>`}</td>
  <td>${change}</td>
</tr>
<tr class="detail" hidden><td colspan="7"><div class="detail-inner">${full ? itemSections(full, { full: false }) : ""}
<div><a class="lb-btn lb-btn--outline lb-btn--sm plain" href="/queue/${encodeURIComponent(i.id)}">Open full item →</a></div>
</div></td></tr>`;
      })
      .join("\n");

    const body = `<header>
  <h1 class="lb-title">Loopback queue${project ? ` — ${escapeHtml(project)}` : ""}</h1>
  <span class="lb-muted">${result.total} item${result.total === 1 ? "" : "s"}${project ? "" : " · all projects"}</span>
  <div class="bar">
    <button class="lb-btn lb-btn--outline lb-btn--sm" id="theme">Theme</button>
  </div>
</header>
<p class="lb-muted">Something wrong or clumsy on <em>this</em> page? Pin it — feedback about Loopback
files to the <code class="lb-mono">loopback</code> project, the same loop everything else uses.
Click a row for a quick read, or open the id to comment and change status.</p>
<div class="counts">${summary}</div>
<table class="lb-table">
  <thead><tr><th>id</th><th>project</th><th>sev / type</th><th>title</th><th>status</th><th>assignee</th><th>change</th></tr></thead>
  <tbody>
${rows || `<tr><td colspan="7" class="lb-muted">Queue is empty.</td></tr>`}
  </tbody>
</table>`;
    res.type("html").send(
      pageShell(req, `Loopback queue${project ? ` — ${project}` : ""}`, body),
    );
  });

  /**
   * Full item view — deep-linkable, and the surface where a human triages:
   * read every captured detail, add a comment, move the status. Paste the URL
   * to an agent or a teammate and they land on the same thing.
   */
  app.get("/queue/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) {
      res
        .status(404)
        .type("html")
        .send(
          pageShell(
            req,
            "Not found",
            `<header><h1 class="lb-title">Item not found</h1></header>
<p class="lb-muted"><code class="lb-mono">${escapeHtml(req.params.id)}</code> is not in this queue.</p>
<p><a class="lb-btn lb-btn--outline lb-btn--sm plain" href="/queue">← Back to the queue</a></p>`,
          ),
        );
      return;
    }
    const flash = typeof req.query.done === "string" ? req.query.done : "";
    const meta = (label: string, value: string): string =>
      `<div class="kv"><span class="lb-label">${escapeHtml(label)}</span><div>${value}</div></div>`;

    const body = `<header>
  <a class="lb-btn lb-btn--ghost lb-btn--sm plain" href="/queue">← Queue</a>
  <span class="lb-badge lb-badge--${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
  <div class="bar">
    <button class="lb-btn lb-btn--outline lb-btn--sm" id="theme">Theme</button>
  </div>
</header>
<h1 class="lb-title" style="margin:.5rem 0">${escapeHtml(item.title)}</h1>
<div class="lb-muted"><code class="lb-mono">${escapeHtml(item.id)}</code></div>
${flash ? `<div class="flash lb-badge lb-badge--fixed">${escapeHtml(flash)}</div>` : ""}
<div class="lb-card meta">
  ${meta("Project", escapeHtml(item.project))}
  ${meta("Severity / type", `<span class="lb-sev lb-sev--${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span> <span class="lb-muted">${escapeHtml(item.type)}</span>`)}
  ${meta("Source / reporter", `${escapeHtml(item.source)} · ${escapeHtml(item.reporter)}`)}
  ${meta("Assignee", item.assignee_agent ? escapeHtml(item.assignee_agent) : `<span class="lb-muted">unclaimed</span>`)}
  ${meta("Route", item.route ? `<code class="lb-mono">${escapeHtml(item.route)}</code>` : `<span class="lb-muted">—</span>`)}
  ${meta("Created", `<span class="lb-muted">${escapeHtml(item.created_at)}</span>`)}
  ${meta("Updated", `<span class="lb-muted">${escapeHtml(item.updated_at)}</span>`)}
  ${item.url ? meta("URL", `<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>`) : ""}
</div>
<div class="detail-inner">${itemSections(item, { full: true })}</div>
<div class="actions-grid">
  <div class="lb-card">
    <form class="act" method="post" action="/queue/${encodeURIComponent(item.id)}/comment">
      <label class="lb-label" for="c-body">Add a comment</label>
      <textarea class="lb-textarea" id="c-body" name="body" required
                placeholder="What you noticed, decided, or want the agent to know"></textarea>
      <div class="inline">
        <input class="lb-input" name="author" value="dj" aria-label="Author">
        <button class="lb-btn lb-btn--sm" type="submit">Comment</button>
      </div>
    </form>
  </div>
  <div class="lb-card">
    <form class="act" method="post" action="/queue/${encodeURIComponent(item.id)}/status">
      <label class="lb-label" for="s-status">Change status</label>
      <select class="lb-select" id="s-status" name="status">
        ${STATUSES.map((s) => `<option value="${s}"${s === item.status ? " selected" : ""}>${s}</option>`).join("")}
      </select>
      <input class="lb-input" name="note" placeholder="Why (recorded on the trail)">
      <div class="inline">
        <input class="lb-input" name="author" value="dj" aria-label="Author">
        <button class="lb-btn lb-btn--sm lb-btn--secondary" type="submit">Update</button>
      </div>
    </form>
  </div>
</div>`;
    res.type("html").send(pageShell(req, `${item.title} — Loopback`, body));
  });

  /** Human triage: append to the trail. Same-origin only (see sameOriginOnly). */
  app.post("/queue/:id/comment", (req, res) => {
    if (!sameOriginOnly(req, res)) return;
    const { body, author } = req.body as { body?: string; author?: string };
    const text = (body ?? "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "A comment body is required." });
      return;
    }
    const updated = store.addComment(
      req.params.id,
      (author ?? "").trim() || "human",
      text,
    );
    if (!updated) {
      res.status(404).json({ ok: false, error: `Feedback '${req.params.id}' not found.` });
      return;
    }
    res.redirect(303, `/queue/${encodeURIComponent(req.params.id)}?done=Comment+added`);
  });

  /** Human triage: move the status. Same-origin only (see sameOriginOnly). */
  app.post("/queue/:id/status", (req, res) => {
    if (!sameOriginOnly(req, res)) return;
    const { status, note, author } = req.body as {
      status?: string;
      note?: string;
      author?: string;
    };
    if (!status || !(STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({
        ok: false,
        error: `Invalid status '${status ?? ""}'.`,
        valid: STATUSES,
      });
      return;
    }
    const who = (author ?? "").trim() || "human";
    const updated =
      status === "verified" || status === "wontfix"
        ? store.resolve(req.params.id, status, (note ?? "").trim() || undefined)
        : store.updateStatus(
            req.params.id,
            status as FeedbackItem["status"],
            (note ?? "").trim() || undefined,
            who,
          );
    if (!updated) {
      res.status(404).json({ ok: false, error: `Feedback '${req.params.id}' not found.` });
      return;
    }
    res.redirect(
      303,
      `/queue/${encodeURIComponent(req.params.id)}?done=Status+is+now+${encodeURIComponent(status)}`,
    );
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
