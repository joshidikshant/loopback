# loopback-mcp-server

**A project-tagged feedback bus + interactive capture widget for coding agents.** Pin feedback on the live app (Claude-Design-style anchored comments, Vercel-toolbar-style workflow); the pin auto-captures the *functional* context — failed requests with response bodies, console trail, LLM run metadata — and lands in one queue that **Claude Code, Codex, and Gemini CLI** can all claim, fix, and write back to. Pins turn green on the page when the agent's fix is verified.

Zero external services. One SQLite file. Two transports (stdio + streamable HTTP — deliberately no SSE, which Claude Code deprecates and Codex doesn't support).

```
pin on live app / Sentry / PostHog / hooks  →  loopback queue  →  any agent: list → claim → fix → link → resolve
        ▲                                                                                        │
        └───────────────── pin turns green on the page (status write-back) ◄─────────────────────┘
```

## The widget (one tag, any web app)

```html
<script src="http://127.0.0.1:7077/widget.js"
        data-project="my-app"
        data-endpoint="http://127.0.0.1:7077"></script>
```

- **A pin is an anchor, not a scope.** Pin the contact form: the payload carries the failing `POST /api/contact` (status + response body) and console lines — so "frontend looks fine, backend is broken" is diagnosable from one pin. Type is auto-guessed (backend when failed requests exist).
- **AI/automation feedback**: wrap AI features with `data-loopback-context='{"run_id":"...","model":"...","trace_url":"..."}'` — pins inside pick it up into `extra.context`, so feedback on an LLM output arrives with its run.
- **Live status pins**: pins hydrate from the bus and poll — amber (open) → blue (claimed) → green (fixed/verified, with agent name + PR link).
- Humans triage at **`/queue`**; agents work the same items over MCP. Same queue, both loops.

Try it: `npm run build && node dist/index.js --http` + `node demo/serve.mjs` → open http://127.0.0.1:5173 (a contact form with a deliberately broken backend + a wrong AI answer).

## Requirements

Node **≥ 22.13** (uses the built-in `node:sqlite` — no native dependencies).

## Install & run

```bash
npm install
npm run build

node dist/index.js --help     # usage
node dist/index.js            # stdio (what agent configs launch)
node dist/index.js --http     # HTTP on 127.0.0.1:7077 (/mcp, /ingest, /health)
```

Database defaults to `~/.loopback/loopback.db` (override: `--db` or `LOOPBACK_DB`). Point every project's agents at the **same DB** to get one queue across all your repos.

## Wire it into your agents

Use an **absolute path** to `dist/index.js` in all three.

**Claude Code** — `claude mcp add loopback -- node /ABS/PATH/loopback-mcp-server/dist/index.js`, or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "loopback": {
      "command": "node",
      "args": ["/ABS/PATH/loopback-mcp-server/dist/index.js"]
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.loopback]
command = "node"
args = ["/ABS/PATH/loopback-mcp-server/dist/index.js"]
```

**Gemini CLI** — `~/.gemini/settings.json` (or project `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "loopback": {
      "command": "node",
      "args": ["/ABS/PATH/loopback-mcp-server/dist/index.js"]
    }
  }
}
```

**HTTP variant** (one long-running server, many clients): run `node dist/index.js --http`, then register `http://127.0.0.1:7077/mcp` — Claude Code: `claude mcp add --transport http loopback http://127.0.0.1:7077/mcp`; Gemini: `"httpUrl": "http://127.0.0.1:7077/mcp"`; Codex: streamable HTTP server entry per Codex MCP docs.

## Tools (9)

| Tool | What it does |
|---|---|
| `loopback_submit_feedback` | File a feedback item (project, type ui/backend/usage/ux, severity, repro, console, network, replay…) |
| `loopback_list_feedback` | Filter + paginate the queue (project/status/type/severity/source/assignee) |
| `loopback_get_feedback` | Full item: context, linked change, comment trail |
| `loopback_claim_feedback` | Atomic claim for an agent; blocks double-work (force to take over) |
| `loopback_update_status` | open → triaged → in_progress → fixed → verified \| wontfix (+audit note) |
| `loopback_add_comment` | Append to the discussion/audit trail |
| `loopback_link_change` | Attach repo/branch/commit/PR/diff summary of the fix |
| `loopback_resolve_feedback` | Close as verified (confirmed) or wontfix |
| `loopback_get_stats` | Queue counts by project and status |

### The agent loop

Tell any agent: *"Work the Loopback queue for project X."* It will:

1. `loopback_list_feedback(project="X", status="open")`
2. `loopback_claim_feedback(id, agent="claude-code")`
3. `loopback_get_feedback(id)` → make the fix in the repo
4. `loopback_link_change(id, commit, pr_url, diff_summary)`
5. `loopback_update_status(id, "fixed")` → verify (browser MCP / tests / metric) → `loopback_resolve_feedback(id, "verified")`

## HTTP ingestion (for capture widgets & hooks)

`POST /ingest` accepts the same schema as `loopback_submit_feedback` — this is where a floating in-app feedback button, a CI hook, or a cron job polling Sentry/PostHog drops items:

```bash
curl -X POST http://127.0.0.1:7077/ingest -H 'Content-Type: application/json' -d '{
  "project": "shop-web", "type": "ui", "severity": "p1",
  "title": "Pay button dead on mobile Safari",
  "route": "/checkout",
  "console": ["TypeError: undefined is not a function at pay.ts:42"],
  "network": [{"url": "/api/pay", "method": "POST", "status": 500, "ms": 2100}],
  "repro_steps": ["Open /checkout on iOS Safari", "Tap Pay"]
}'
```

## Test

```bash
npm run build && npm run smoke                                # MCP loop over stdio
LOOPBACK_E2E_CHROMIUM=$(which chromium) node scripts/e2e.mjs  # full browser E2E (needs playwright)
```

`smoke` drives the full MCP loop as a real client. `e2e.mjs` goes further: a real browser submits the broken contact form, pins feedback via the widget (asserting the 500 response body and LLM run context were captured), an agent claims/fixes/resolves over MCP-HTTP, and the reloaded page must show the green verified pin.

## Companions (borrow, don't build)

Loopback is the thin bus; pair it with the mature capture/vision layers, all MCP-native:

- **chrome-devtools-mcp** / **@playwright/mcp** — let the agent *see and verify* the running web app
- **Sentry MCP + Seer** — production errors (incl. iOS/Android/RN/Flutter) → agent fix
- **PostHog MCP** — analytics, session replay (web + mobile), surveys → agent context

## Roadmap

- ~~Phase 1: embeddable capture widget~~ ✅ shipped (v0.2.0)
- **Phase 2**: scheduled ingestors (Sentry/PostHog → queue), screenshots as stored blobs, auth token for non-localhost `/ingest`
- **Phase 3**: richer `/queue` triage dashboard, interaction-recording mode (capture a whole flow, not just a moment)

MIT.
