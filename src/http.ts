/**
 * HTTP surface: stateless MCP (/mcp), widget ingestion (/ingest), pin hydration
 * (GET /feedback), the human queue views (/queue, /queue/:id), the embeddable
 * widget (/widget.js), and /health.
 *
 * TRUST MODEL — the boundary is not "localhost", it is "any page open in the
 * operator's browser", because a loopback port is reachable from every one of
 * them. So CORS is granted to exactly the three routes the widget needs from a
 * foreign origin (/ingest, /feedback, /widget.js) and nowhere else; /feedback
 * cross-origin returns the pin projection only; and everything that reads full
 * context or changes state — including /mcp, which carries all nine tools —
 * requires an origin pinned at startup from the bind config.
 *
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
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A URL safe to put in href=. Escaping is not enough: `javascript:` survives it
 * intact, and anyone who can file an item (i.e. any page, via /ingest) controls
 * `url` and `pr_url`. One click on the queue would then run script on the hub's
 * own origin, where it can read and rewrite everything. Non-http(s) values are
 * rendered as inert text instead.
 */
function safeHref(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** Renders a URL as a link when it is safe, and as plain code when it is not. */
function linkOrText(raw: string, label?: string): string {
  const href = safeHref(raw);
  return href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(label ?? raw)}</a>`
    : `<code class="lb-mono">${escapeHtml(raw)}</code>`;
}

/**
 * The fields a cross-origin caller may read. The widget renders pins from
 * exactly these; everything omitted (body, console, network, extra) is where
 * captured secrets live — response bodies routinely contain auth headers.
 */
function pinProjection(item: FeedbackItem): Record<string, unknown> {
  return {
    id: item.id,
    project: item.project,
    route: item.route,
    title: item.title,
    type: item.type,
    severity: item.severity,
    status: item.status,
    assignee_agent: item.assignee_agent,
    dom_selector: item.dom_selector,
    links: { pr_url: item.links.pr_url },
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

const STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "fixed",
  "verified",
  "wontfix",
] as const;

/** Config the app needs to know about its own identity on the network. */
export interface HttpOptions {
  /** Bind host, used to pin which origins are trusted. */
  host?: string;
  /** Bind port, same. */
  port?: number;
}

/**
 * Origins trusted to read full-fidelity data and to make changes.
 *
 * Pinned at startup from the bind config rather than derived from the request's
 * Host header. Host is attacker-influenced: a domain that resolves to 127.0.0.1
 * (DNS rebinding) arrives with Host AND Origin both set to that domain, so a
 * "does Origin equal my own Host" test passes for a site that is not us.
 */
function trustedOrigins(opts: HttpOptions): Set<string> {
  const port = opts.port ?? 7077;
  const bind = opts.host ?? "127.0.0.1";
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  // An explicit LAN/proxy bind is also legitimately "us".
  if (!["127.0.0.1", "localhost", "0.0.0.0", "::"].includes(bind)) hosts.push(bind);
  return new Set(hosts.map((h) => `http://${h}:${port}`));
}

export function createHttpApp(
  makeServer: () => McpServer,
  store: LoopbackStore,
  options: HttpOptions = {},
): express.Express {
  const TRUSTED = trustedOrigins(options);

  /** True when the caller is us, or non-browser tooling that sends no Origin. */
  const isTrusted = (req: express.Request): boolean => {
    const origin = req.get("origin");
    return !origin || TRUSTED.has(origin);
  };

  /**
   * Guard for everything that can read secrets or change state.
   *
   * CORS has to stay open for `POST /ingest` — the widget reports from whatever
   * origin the host app runs on, and that is an append-only intake. It must not
   * extend one inch further: `/mcp` exposes all nine tools, so leaving it open
   * let any page in the operator's browser read every project's queue and
   * silently resolve items. Browsers always attach Origin cross-origin, so this
   * rejects foreign pages while local tooling (curl, MCP clients) still works.
   */
  const requireTrustedOrigin = (
    req: express.Request,
    res: express.Response,
  ): boolean => {
    if (isTrusted(req)) return true;
    res.status(403).json({
      ok: false,
      error: "Cross-origin requests are not allowed on this endpoint.",
      hint: "Use the /queue UI on this origin, an MCP client, or a local script. POST /ingest is the cross-origin entry point.",
    });
    return false;
  };

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
  .tile { display: inline-block; border-radius: 999px; transition: opacity .12s, box-shadow .12s; }
  .tile:hover { opacity: .85; text-decoration: none; }
  .tile.on { box-shadow: 0 0 0 2px var(--ring); border-radius: 999px; }
  .tile:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 999px; }
  .filters { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: .25rem 0 1rem; font-size: .8125rem; }
  .chip { border: 1px solid var(--border); border-radius: 999px; padding: .1rem .5rem; font-size: .75rem; }
  .chip:hover { background: var(--accent); text-decoration: none; }
  td a.f { text-decoration: none; }
  td a.f:hover { text-decoration: underline; text-underline-offset: 2px; }
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

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Triage actions post as plain HTML forms so they work without JavaScript.
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  // CORS is granted to exactly the routes the widget needs from a foreign
  // origin, and nowhere else. `/mcp`, `/feedback/:id` and the `/queue` pages
  // are deliberately not on this list.
  const CORS_ROUTES = new Set(["/ingest", "/feedback", "/widget.js"]);
  app.use((req, res, next) => {
    const open = CORS_ROUTES.has(req.path);
    if (open) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(open ? 204 : 403);
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
    const result = store.list(filters);
    if (!isTrusted(req)) {
      // A foreign origin (i.e. the widget on a host app) gets only what pins
      // need. `extra` in particular carries captured response bodies, which
      // routinely include auth headers.
      res.json({ ...result, items: result.items.map(pinProjection) });
      return;
    }
    res.json(result);
  });

  /**
   * Human triage view — the cross-project queue, built on the Loopback design
   * system. Rows expand in place for a quick read; the id links to the full
   * item view, which is where a human can actually act on it.
   */
  app.get("/queue", (req, res) => {
    const q = (k: string): string | undefined =>
      typeof req.query[k] === "string" && req.query[k] ? (req.query[k] as string) : undefined;
    const project = q("project");
    const status = q("status");
    const type = q("type");
    const severity = q("severity");
    const assignee = q("assignee_agent");

    // Counts come from the project scope WITHOUT the status filter, so the
    // tiles stay navigable once you have filtered — otherwise clicking "open"
    // hides every other tile and you are stuck.
    const scope = store.list({ project, type, severity, assignee_agent: assignee, limit: 1000, offset: 0 });
    const counts = new Map<string, number>();
    for (const i of scope.items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);

    const LIMIT = 100;
    const result = store.list({
      project, status, type, severity, assignee_agent: assignee, limit: LIMIT, offset: 0,
    });

    /** Preserve the other filters when toggling one of them. */
    const href = (patch: Record<string, string | undefined>): string => {
      const merged: Record<string, string | undefined> = {
        project, status, type, severity, assignee_agent: assignee, ...patch,
      };
      const qs = Object.entries(merged)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      return qs ? `/queue?${qs}` : "/queue";
    };

    const tiles = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => {
        const on = status === s;
        // Clicking an active tile clears it — the tile is the toggle.
        return `<a class="tile plain${on ? " on" : ""}" href="${href({ status: on ? undefined : s })}"
          aria-pressed="${on}" title="${on ? "Clear this filter" : `Show only ${escapeHtml(s)}`}"
          ><span class="lb-badge lb-badge--${escapeHtml(s)}">${n} ${escapeHtml(s)}</span></a>`;
      })
      .join(" ");

    const active = [
      status && ["status", status] as const,
      type && ["type", type] as const,
      severity && ["severity", severity] as const,
      project && ["project", project] as const,
      assignee && ["assignee", assignee] as const,
    ].filter(Boolean) as (readonly [string, string])[];
    const activeChips = active.length
      ? `<div class="filters"><span class="lb-muted">Filtered by</span>` +
        active
          .map(
            ([k, v]) =>
              `<a class="chip plain" href="${href({ [k === "assignee" ? "assignee_agent" : k]: undefined })}"
                title="Remove this filter">${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong> ✕</a>`,
          )
          .join("") +
        `<a class="chip plain" href="/queue" title="Clear everything">clear all</a></div>`
      : "";

    const summary = tiles + activeChips;

    const rows = result.items
      .map((i) => {
        const change = i.links.pr_url
          ? linkOrText(i.links.pr_url, "PR")
          : i.links.commit
            ? `<code class="lb-mono">${escapeHtml(i.links.commit.slice(0, 9))}</code>`
            : `<span class="lb-muted">—</span>`;
        const full = store.get(i.id);
        return `<tr class="row" data-id="${escapeHtml(i.id)}" tabindex="0" aria-expanded="false">
  <td><span class="chev" aria-hidden="true">▸</span> <a class="plain" href="/queue/${encodeURIComponent(i.id)}"><code class="lb-mono">${escapeHtml(i.id)}</code></a></td>
  <td><a class="plain f" href="${href({ project: i.project })}" title="Only ${escapeHtml(i.project)}">${escapeHtml(i.project)}</a></td>
  <td><a class="plain f" href="${href({ severity: i.severity })}" title="Only ${escapeHtml(i.severity)}"><span class="lb-sev lb-sev--${escapeHtml(i.severity)}">${escapeHtml(i.severity)}</span></a>
      <a class="plain f lb-muted" href="${href({ type: i.type })}" title="Only ${escapeHtml(i.type)}">${escapeHtml(i.type)}</a></td>
  <td class="ttl">${escapeHtml(i.title)}</td>
  <td><a class="plain f" href="${href({ status: i.status })}" title="Only ${escapeHtml(i.status)}"><span class="lb-badge lb-badge--${escapeHtml(i.status)}">${escapeHtml(i.status)}</span></a></td>
  <td>${i.assignee_agent ? `<a class="plain f" href="${href({ assignee_agent: i.assignee_agent })}">${escapeHtml(i.assignee_agent)}</a>` : `<span class="lb-muted">—</span>`}</td>
  <td>${change}</td>
</tr>
<tr class="detail" hidden><td colspan="7"><div class="detail-inner">${full ? itemSections(full, { full: false }) : ""}
<div><a class="lb-btn lb-btn--outline lb-btn--sm plain" href="/queue/${encodeURIComponent(i.id)}">Open full item →</a></div>
</div></td></tr>`;
      })
      .join("\n");

    const body = `<header>
  <h1 class="lb-title">Loopback queue${project ? ` — ${escapeHtml(project)}` : ""}</h1>
  <span class="lb-muted">${result.total} item${result.total === 1 ? "" : "s"}${
    result.total > result.count ? ` · showing first ${result.count}` : ""
  }${project ? "" : " · all projects"}</span>
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
  ${item.url ? meta("URL", linkOrText(item.url)) : ""}
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

  /** Human triage: append to the trail. Trusted origins only. */
  app.post("/queue/:id/comment", (req, res) => {
    if (!requireTrustedOrigin(req, res)) return;
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

  /** Human triage: move the status. Trusted origins only. */
  app.post("/queue/:id/status", (req, res) => {
    if (!requireTrustedOrigin(req, res)) return;
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
    if (!requireTrustedOrigin(req, res)) return;
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
