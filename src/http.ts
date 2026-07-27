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
 * context or changes state — including /mcp, which carries all ten tools —
 * requires an origin pinned at startup from the bind config.
 *
 * SSE is deliberately not offered (deprecated in Claude Code, unsupported in Codex).
 */

import express from "express";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, extname, resolve, sep } from "node:path";
import { gzip, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoopbackStore } from "./store.js";
import type { FeedbackItem } from "./types.js";
import { httpListSchema, submitSchema, updateSchema } from "./schemas.js";
import { SERVER_VERSION } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The design system, read from disk once and inlined into the queue page.
 * One source of truth shared with `design/` and the published shadcn registry;
 * inlining keeps the page a single request with no asset pipeline.
 */

/**
 * Origin this request came in on, so the queue page's own widget talks back to
 * the same instance whether that's 127.0.0.1, a LAN IP (--host), or a proxy.
 */
function selfOrigin(req: express.Request): string {
  const host = req.get("host") ?? "127.0.0.1:7077";
  return `${req.protocol}://${host}`;
}

/**
 * The fields a cross-origin caller may read. The widget renders pins from
 * exactly these; everything omitted (body, console, network, extra) is where
 * captured secrets live — response bodies routinely contain auth headers.
 */
/**
 * What a LIST caller needs, which is far less than a full item.
 *
 * The queue table reads eleven scalar fields. It was handed full-fidelity items
 * — measured at 16.6MB for `limit=1000`, the limit the dashboard actually asks
 * for — because `pinProjection` was only applied to untrusted origins, and a
 * same-origin GET sends no Origin header, so `isTrusted` is true for the very
 * caller that needs the least. gzip fixed the wire and nothing else: the
 * JSON.parse cost and the retained heap were untouched.
 *
 * `body` stays because the queue searches it client-side. `console`, `network`,
 * `repro_steps`, `extra` and `comments` — the bulk, and the parts carrying up
 * to 2KB of captured response body each — do not.
 */
function listProjection(item: FeedbackItem): Record<string, unknown> {
  return {
    id: item.id,
    project: item.project,
    created_at: item.created_at,
    updated_at: item.updated_at,
    source: item.source,
    reporter: item.reporter,
    type: item.type,
    severity: item.severity,
    title: item.title,
    body: item.body,
    route: item.route,
    url: item.url,
    dom_selector: item.dom_selector,
    status: item.status,
    assignee_agent: item.assignee_agent,
    resolution: item.resolution,
    links: item.links,
    // Only the count is rendered; the objects are not.
    attachments: (item.attachments ?? []).map((a) => ({ id: a.id, name: a.name, intent: a.intent })),
    console: [],
    network: [],
    repro_steps: [],
    extra: {},
  };
}

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
   * extend one inch further: `/mcp` exposes all ten tools, so leaving it open
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



  const app = express();

  /**
   * gzip JSON responses too, not just the dashboard bundle.
   *
   * `GET /feedback?limit=1000` measured 16,605,955 bytes uncompressed against
   * 114,610 gzipped — 145x. Items carry console tails, network entries and up
   * to 2KB of captured response body each, so the payload is highly
   * compressible text, and the widget polls this endpoint every 10 seconds from
   * every open page. The compression already existed twelve lines below, scoped
   * to /dashboard/* alone.
   */
  app.use((req, res, next) => {
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return next();
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      // Below ~1KB the header and CPU cost outweigh the saving.
      if (raw.length < 1024) return originalJson(body);
      // ASYNC. gzipSync here blocked the event loop for a measured 273ms on a
      // 1000-item response — the exact scale this middleware exists for — which
      // freezes /ingest and every agent's /mcp call for that window. The
      // dashboard route can stay sync: those files are small and immutable.
      gzip(raw, (err, packed) => {
        if (err) {
          originalJson(body);
          return;
        }
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", String(packed.length));
        res.end(packed);
      });
      return res;
    };
    next();
  });

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
  // Read once and pre-compressed. This is the single asset every host page
  // loads on every navigation — 51,348 B on the wire against 16,874 gzipped,
  // re-read from disk per request, while the dashboard bundle (loaded once, on
  // our own origin) already had both gzip and immutable caching.
  let widgetSource: Buffer | null = null;
  let widgetGzip: Buffer | null = null;
  let widgetEtag = "";
  try {
    widgetSource = readFileSync(join(__dirname, "..", "widget", "loopback-widget.js"));
    widgetGzip = gzipSync(widgetSource);
    widgetEtag = `W/"${randomBytes(8).toString("hex")}"`;
  } catch {
    /* reported per-request below */
  }
  app.get("/widget.js", (req, res) => {
    if (!widgetSource) {
      res.status(404).send("// widget file missing — reinstall loopback-mcp-server");
      return;
    }
    res.type("application/javascript");
    res.setHeader("ETag", widgetEtag);
    // Short max-age, not immutable: unlike the hashed bundle this URL is stable
    // across versions, so a long TTL would pin host pages to a stale widget.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === widgetEtag) {
      res.status(304).end();
      return;
    }
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && widgetGzip) {
      res.setHeader("Content-Encoding", "gzip");
      res.end(widgetGzip);
      return;
    }
    res.end(widgetSource);
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

  /** Correct an item after filing. Trusted origins only; audited by the store. */
  app.patch("/feedback/:id", (req, res) => {
    if (!requireTrustedOrigin(req, res)) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "Invalid edit",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    const { author, ...patch } = parsed.data;
    const item = store.update(req.params.id, patch, author);
    if (!item) {
      res.status(404).json({ ok: false, error: `Feedback '${req.params.id}' not found.` });
      return;
    }
    res.json({ ok: true, item });
  });

  /**
   * Attachment upload. The body IS the file — no multipart, so no new runtime
   * dependency. Metadata rides in the query string.
   *
   *   POST /feedback/:id/attachments?name=logo.svg&intent=asset&target=public/logos/logo.svg
   */
  app.post(
    "/feedback/:id/attachments",
    express.raw({ type: "*/*", limit: "10mb" }),
    (req, res) => {
      if (!requireTrustedOrigin(req, res)) return;
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ ok: false, error: "Empty body — send the file as the request body." });
        return;
      }
      const q = (k: string): string | undefined =>
        typeof req.query[k] === "string" && req.query[k] ? (req.query[k] as string) : undefined;

      const rawName = q("name") ?? "attachment";
      // Never let a filename escape the item's own blob directory.
      const safeName = rawName.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
      const intent = q("intent") === "asset" ? "asset" : "reference";
      const target = q("target");
      if (intent === "asset" && target && (target.startsWith("/") || target.includes(".."))) {
        res.status(400).json({
          ok: false,
          error: "target must be a repo-relative path without '..'",
        });
        return;
      }

      const attId = `att_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      const dir = join(store.blobRoot, req.params.id);
      const fileName = `${attId}-${safeName}`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, fileName), body);
      } catch (error) {
        res.status(500).json({ ok: false, error: `Could not store the file: ${String(error)}` });
        return;
      }

      const item = store.addAttachment(req.params.id, {
        id: attId,
        name: safeName,
        mime: req.get("content-type") ?? "application/octet-stream",
        size: body.length,
        intent,
        target_path: target,
        file: fileName,
      }, q("author") ?? "human");
      if (!item) {
        rmSync(join(dir, fileName), { force: true });
        res.status(404).json({ ok: false, error: `Feedback '${req.params.id}' not found.` });
        return;
      }
      res.status(201).json({ ok: true, id: attId, item });
    },
  );

  /** Serve an attachment. Not CORS-open: attachments can be private. */
  app.get("/blob/:id/:attachmentId", (req, res) => {
    if (!requireTrustedOrigin(req, res)) return;
    const att = store.getAttachment(req.params.id, req.params.attachmentId);
    if (!att) {
      res.status(404).json({ ok: false, error: "Attachment not found." });
      return;
    }
    res.type(att.mime);
    res.setHeader("Content-Disposition", `inline; filename="${att.name.replace(/"/g, "")}"`);
    res.sendFile(join(store.blobRoot, req.params.id, att.file));
  });

  app.delete("/feedback/:id/attachments/:attachmentId", (req, res) => {
    if (!requireTrustedOrigin(req, res)) return;
    const att = store.getAttachment(req.params.id, req.params.attachmentId);
    if (!att || !store.deleteAttachment(req.params.id, req.params.attachmentId, (req.query.author as string) || "human")) {
      res.status(404).json({ ok: false, error: "Attachment not found." });
      return;
    }
    rmSync(join(store.blobRoot, req.params.id, att.file), { force: true });
    res.json({ ok: true });
  });

  /** Pin hydration + programmatic reads: same filters as loopback_list_feedback. */
  app.get("/feedback", (req, res) => {
    const parsed = httpListSchema.safeParse({
      ...req.query,
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
      response_format: "json",
    });
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "Invalid query",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
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
    // Opt-in, not silent. `GET /feedback` is a documented contract and narrowing
    // it by default broke a caller immediately (the e2e reads `network` from
    // here). The dashboard asks for ?view=list because it renders eleven scalar
    // fields; everything else keeps full fidelity.
    if (req.query.view === "list") {
      res.json({ ...result, items: result.items.map(listProjection) });
      return;
    }
    res.json(result);
  });

  /**
   * The dashboard is a built React + shadcn app (source in dashboard/, output
   * committed to public/dashboard) rather than server-rendered HTML: it needs
   * real interaction — filtering, editing, file upload — and hand-rolled
   * template strings were becoming the limit. The build output is committed so
   * `npx loopback-mcp-server` still needs no React, no Tailwind and no build.
   */
  const DASHBOARD_DIR = join(__dirname, "..", "public", "dashboard");

  /**
   * gzip the dashboard bundle. It is ~410KB raw and ~127KB gzipped — a 3.2x
   * difference that goes unnoticed on loopback but not over Wi-Fi, and
   * `--host 0.0.0.0` for phone testing is a documented, promoted mode.
   *
   * Hand-rolled on node:zlib rather than pulling in `compression`: the hub has
   * three runtime dependencies and this is fifteen lines.
   */
  // Compressed once at startup, not per request. The sibling /widget.js path
  // was already fixed this way while this one re-read and re-gzipped a 411KB
  // bundle on every hit — 5.5ms of blocking TTFB — under a comment asserting
  // these files are small. Vite hashes content into the filenames, so a cached
  // entry can never go stale within a process.
  const dashCache = new Map();
  app.use("/dashboard", (req, res, next) => {
    const accepts = String(req.headers["accept-encoding"] ?? "");
    if (!/\bgzip\b/.test(accepts) || !/\.(js|css|html|json|svg|map)$/.test(req.path)) {
      return next();
    }
    // CONTAINMENT. `join(DASHBOARD_DIR, req.path)` alone is a path traversal:
    // `/dashboard/../../package.json` resolved outside the served directory and
    // returned 200 with the repo's own file, gzipped. express.static does this
    // check internally, which is exactly why hand-rolling in front of it is
    // where the hole appeared. Resolve, then require the prefix.
    const file = resolve(DASHBOARD_DIR, "." + req.path);
    const root = resolve(DASHBOARD_DIR);
    if (file !== root && !file.startsWith(root + sep)) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    let body = dashCache.get(file);
    if (!body) {
      try {
        body = gzipSync(readFileSync(file));
      } catch {
        return next(); // missing file, or unreadable — let express.static answer
      }
      dashCache.set(file, body);
    }
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    // Vite hashes content into these filenames, so a given URL's bytes never
    // change. `max-age=0` forced a revalidation round-trip on every load.
    if (req.path.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    res.type(extname(req.path));
    res.end(body);
  });

  app.use("/dashboard", express.static(DASHBOARD_DIR, { index: false }));

  /** /queue and /queue/:id are both the SPA; it routes on the path itself. */
  const serveDashboard = (_req: express.Request, res: express.Response): void => {
    res.sendFile(join(DASHBOARD_DIR, "index.html"), (err) => {
      if (err) {
        res
          .status(503)
          .type("html")
          .send(
            `<h1>Dashboard not built</h1><p>Run <code>npm run dashboard:build</code>, ` +
              `or use the JSON API at <a href="/feedback">/feedback</a>.</p>`,
          );
      }
    });
  };
  app.get("/queue", serveDashboard);
  app.get("/queue/:id", serveDashboard);

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
        // `who` was computed above and handed to updateStatus but NOT to
        // resolve — so the one write that turns a pin green recorded "agent"
        // even when a human clicked it.
        ? store.resolve(req.params.id, status, (note ?? "").trim() || undefined, who)
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
