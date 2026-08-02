#!/usr/bin/env node
/**
 * Loopback MCP server entry point.
 *
 * Transports:
 *   default      stdio  (for Claude Code / Codex / Gemini CLI local config)
 *   --http       streamable HTTP on 127.0.0.1 (POST /mcp) + POST /ingest + GET /health
 *
 * Options:
 *   --db <path>     SQLite file (default: $LOOPBACK_DB or ~/.loopback/loopback.db)
 *   --port <n>      HTTP port (default: $LOOPBACK_HTTP_PORT or 7077)
 *   --help          usage
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LoopbackStore } from "./store.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { createHttpApp } from "./http.js";
import { runInit } from "./init.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const USAGE = `loopback-mcp-server v${SERVER_VERSION} — feedback bus for coding agents (MCP)

One instance serves ALL projects: every item is tagged with a project slug and
lands in one shared SQLite DB (~/.loopback/loopback.db), whether the server is
spawned per-agent over stdio or kept alive once with --http.

Usage:
  loopback-mcp-server                 # stdio transport (default; for agent config files)
  loopback-mcp-server --http          # streamable HTTP on 127.0.0.1:7077 (the hub mode; required for widgets)
  loopback-mcp-server --http --port 8090
  loopback-mcp-server --http --host 0.0.0.0   # LAN devices (phones) — prints a token; set LOOPBACK_TOKEN to pin it
  loopback-mcp-server --db /path/to/loopback.db
  loopback-mcp-server init --project <slug> [--agents claude,codex,gemini] [--write]
                                      # onboard the current repo (AGENTS.md, skills, MCP configs ×3)

Environment:
  LOOPBACK_DB          SQLite path (default ~/.loopback/loopback.db)
  LOOPBACK_HTTP_PORT   HTTP port for --http (default 7077)
  LOOPBACK_HOST        Bind address for --http (default 127.0.0.1)

HTTP endpoints (with --http):
  POST /mcp        MCP streamable HTTP (stateless JSON; GET/DELETE → 405)
  POST /ingest     Plain JSON feedback ingestion (capture widget / hooks / CI)
  GET  /feedback   List/filter items (widget pin hydration)
  GET  /queue      Human triage table (?project=<slug>)
  GET  /widget.js  The embeddable capture widget
  GET  /health     Liveness check
`;

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    await runInit(process.argv.slice(3));
    return;
  }
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(USAGE);
    return;
  }

  const dbPath =
    argValue("--db") ??
    process.env.LOOPBACK_DB ??
    join(homedir(), ".loopback", "loopback.db");
  const store = new LoopbackStore(dbPath);

  if (hasFlag("--http")) {
    const port = Number(
      argValue("--port") ?? process.env.LOOPBACK_HTTP_PORT ?? 7077,
    );
    const host = argValue("--host") ?? process.env.LOOPBACK_HOST ?? "127.0.0.1";
    // A token only exists on a non-loopback bind. On 127.0.0.1 it would protect
    // nothing the OS does not already protect, and every local MCP client,
    // script and browser tab would have to carry it.
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const token = isLocal
      ? undefined
      : (process.env.LOOPBACK_TOKEN ?? randomBytes(24).toString("hex"));
    const app = createHttpApp(() => buildServer(store), store, { host, port, token });
    const httpServer = app.listen(port, host, () => {
      // The callback fires even when the bind FAILED, with address() === null,
      // so an unguarded banner announced a healthy server moments before the
      // error handler below exited 1 — the two lines contradicted each other.
      if (httpServer.address() === null) return;
      console.error(
        `loopback-mcp-server v${SERVER_VERSION} on http://${host}:${port}/mcp  (db: ${dbPath})`,
      );
      if (token) {
        console.error(
          `\n  Open the queue on this machine or a phone on the same network:\n` +
            `    http://${host === "0.0.0.0" ? "<this-machine-ip>" : host}:${port}/queue?token=${token}\n\n` +
            `  The token is accepted once from the URL and then kept in a cookie.\n` +
            `  Tools and scripts send it as: Authorization: Bearer ${token}\n` +
            `  Set LOOPBACK_TOKEN to pin it across restarts.\n`,
        );
      }
      if (!isLocal) {
        console.error(
          `⚠ bound to ${host}: reachable by anyone on this network. Reads and writes require the token above, but POST /ingest and the pins projection stay open by design so the widget can report. Trusted networks only.` +
            `Intended for device testing on trusted networks only; put a token-gated reverse proxy in front for anything more.`,
        );
      }
    });
    // Without this the process exits 0 on a taken port, having printed its
    // success banner and served nothing: express's listen callback still fires
    // (with address() === null), and an unhandled 'error' on the underlying
    // server is not a throw. Measured — a second `--http --port 7077` looked
    // exactly like a clean start. Silence on a port collision is the worst
    // outcome for a tool people run in a second terminal.
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `Port ${port} is already in use — another Loopback (or something else) is on it.\n` +
            `  Use a different port:  loopback-mcp-server --http --port ${port + 1}\n` +
            `  Or find the process :  lsof -i :${port}`,
        );
      } else {
        console.error(`Could not listen on ${host}:${port} — ${err.message}`);
      }
      process.exit(1);
    });
    return;
  }

  const server = buildServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio: log to stderr only — stdout carries the protocol.
  console.error(
    `loopback-mcp-server v${SERVER_VERSION} ready on stdio (db: ${dbPath})`,
  );
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
