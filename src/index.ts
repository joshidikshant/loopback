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
  loopback-mcp-server --http --host 0.0.0.0   # LAN devices (phones) — NO auth; trusted networks only
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
    const app = createHttpApp(() => buildServer(store), store);
    app.listen(port, host, () => {
      console.error(
        `loopback-mcp-server v${SERVER_VERSION} on http://${host}:${port}/mcp  (db: ${dbPath})`,
      );
      if (host !== "127.0.0.1" && host !== "localhost") {
        console.error(
          `⚠ bound to ${host}: Loopback has NO authentication — anyone on this network can read/write the queue. ` +
            `Intended for device testing on trusted networks only; put a token-gated reverse proxy in front for anything more.`,
        );
      }
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
