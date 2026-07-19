# The Technical Path — Decided, Built, and Verified

*Companion to the build-vs-borrow memo. This is the concrete "how": what to install, what was built, and the exact wiring. The Loopback Phase-0 server described here is **already built and passing its end-to-end tests** — see the attached zip.*

---

## 1. The path in one picture

```
                     BORROW (install, ~$0)                          BUILD (done: Phase-0)
┌──────────────────────────────────────────────────────┐   ┌────────────────────────────────┐
│ chrome-devtools-mcp   → agent sees the running app   │   │ loopback-mcp-server            │
│ @playwright/mcp       → agent drives & verifies UI   │   │  · TypeScript + official SDK   │
│ Sentry MCP (+Seer)    → prod errors incl. MOBILE     │──►│  · node:sqlite (no native deps)│
│ PostHog MCP           → usage/replay/surveys, MOBILE │   │  · stdio + streamable HTTP     │
│ (optional) stagewise / Jam → click-to-context        │   │  · 9 tools, atomic claims      │
└──────────────────────────────────────────────────────┘   │  · POST /ingest for widgets    │
                                                           └────────────────────────────────┘
                     all of the above speak MCP → Claude Code, Codex, Gemini CLI
```

## 2. Stack decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** + official `@modelcontextprotocol/sdk` (v1.29) | First-party SDK, best-documented `registerTool`/Zod path; agents generate/maintain TS well |
| Storage | **`node:sqlite`** (built into Node ≥22.13) | Zero native dependencies — `better-sqlite3` failed its native build even in a clean sandbox, which proves the point: nothing to compile means nothing to break on your machines |
| Validation | **Zod v4** raw shapes per tool | Runtime validation + typed handlers; malformed agent calls get actionable errors |
| Transports | **stdio** (default) + **stateless streamable HTTP** | The exact intersection all three agents support. **SSE deliberately omitted** — deprecated in Claude Code, absent in Codex |
| HTTP shape | Fresh server+transport per request, JSON responses, bound to 127.0.0.1 | Stateless = no session bugs, trivially restartable, DNS-rebinding-safe |
| Concurrency | **Atomic claim** via guarded SQL UPDATE | Two agents can't grab the same item; `force=true` is an explicit takeover |
| Widget path | Plain **`POST /ingest`** (non-MCP JSON) | The future capture widget/CI hooks need a dumb HTTP endpoint, not an MCP handshake — it exists from day one |
| Tool design | 9 `loopback_*` snake_case tools, markdown+`structuredContent` responses, pagination, 25k char truncation | Per MCP best practices; service prefix avoids collisions with your other MCP servers |

## 3. What was built and verified (in this session)

`loopback-mcp-server v0.1.0` — full Phase-0, compiled clean, then **tested with a real MCP client**, not just unit calls:

- ✅ 9 tools registered and callable over **stdio**
- ✅ Full loop: submit → list(filtered) → **claim** → comment → link_change → fixed → **resolve(verified)** → get(full trail) → stats
- ✅ Conflict test: second agent's claim **blocked** and told who holds it
- ✅ Not-found errors are actionable (tell the agent what to do next)
- ✅ **HTTP transport**: MCP `initialize` + `tools/list` (9 tools) served at `POST /mcp`
- ✅ **`/ingest`** accepts a widget-style payload; rejects bad payloads with field-level errors
- ✅ `--help`, env/flag config, WAL-mode SQLite at `~/.loopback/loopback.db`

Layout: `src/{index,server,store,schemas,format,http,types,smoke-test}.ts` — ~1,100 lines total. Small enough to own completely.

## 4. Borrow-side: exact installs (one-liners)

**Claude Code**
```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add playwright     -- npx -y @playwright/mcp@latest
claude mcp add --transport http sentry  https://mcp.sentry.dev/mcp     # OAuth on first use
claude mcp add --transport http posthog https://mcp.posthog.com/mcp    # or: npx @posthog/wizard mcp add
claude mcp add loopback       -- node /ABS/PATH/loopback-mcp-server/dist/index.js
```

**Codex** (`~/.codex/config.toml`)
```toml
[mcp_servers.chrome-devtools]
command = "npx"; args = ["-y", "chrome-devtools-mcp@latest"]
[mcp_servers.playwright]
command = "npx"; args = ["-y", "@playwright/mcp@latest"]
[mcp_servers.loopback]
command = "node"; args = ["/ABS/PATH/loopback-mcp-server/dist/index.js"]
# sentry/posthog: add as streamable HTTP servers per Codex MCP docs
```

**Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": {
    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] },
    "playwright":      { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "loopback":        { "command": "node", "args": ["/ABS/PATH/loopback-mcp-server/dist/index.js"] }
} }
```

Sentry/PostHog SDKs go into the apps themselves (their normal installs — that's what reaches **mobile**); their MCPs then expose the captured data to the agents.

## 5. Your rollout (3 steps)

1. **Today (~30 min):** unzip, `npm install && npm run build && npm run smoke`, add the config blocks above to one pilot repo. Tell each agent: *"Work the Loopback queue for project `<slug>`."*
2. **This week:** wire Chrome DevTools/Playwright MCPs (agent self-verification) and file feedback via `loopback_submit_feedback` or `curl /ingest` as you use your apps.
3. **Next:** Phase 1 widget (a ~5KB snippet POSTing to `/ingest`), then scheduled Sentry/PostHog ingestors. The memo's Path-B swaps (GlitchTip, self-host) remain open — the bus hides them from the agents.

## 6. Known limits (Phase-0, by design)

Single-writer local SQLite (fine solo; move to `--http` + one shared instance when a second machine appears) · no auth on HTTP (loopback-bound only — add a bearer token before exposing beyond localhost) · screenshots are paths/URLs, not stored blobs (Phase 1) · no dashboard (the agents and `loopback_get_stats` are the UI for now) · `node:sqlite` still prints an "experimental" warning on Node 22 (silent on Node 24; API is stable-tracked).
