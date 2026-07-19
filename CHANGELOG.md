# Changelog

All notable changes to Loopback are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

## [0.3.0] — 2026-07-20

The hub release: Loopback becomes a standalone cross-project, cross-agent
product with a two-minute onboarding path.

### Added
- **`init` subcommand** (`loopback-mcp-server init --project <slug> [--agents
  claude,codex,gemini] [--write]`): renders the one canonical queue playbook
  into every agent's native mechanism — AGENTS.md canonical section, CLAUDE.md
  + GEMINI.md `@AGENTS.md` imports, the same SKILL.md installed to
  `.claude/skills/` and `.agents/skills/`, MCP registration in `.mcp.json`,
  `.gemini/settings.json` (incl. `context.fileName`), and project-scoped
  `.codex/config.toml`, plus a `/loopback` Gemini command. Non-destructive,
  marker-based, byte-idempotent merges; dry-run by default.
- **Integration kit** (`integrations/`): canonical `instructions-src.md`,
  per-agent pages (claude/codex/gemini as equal citizens), widget embed
  template, and keep-alive recipes (pm2 / launchd / systemd).
- **Canonical skill** (`skills/loopback/SKILL.md`) with a triggering-oriented
  description; installed natively for both Claude Code and Codex.
- **Claude Code plugin** (`plugin/`) bundling the skill + MCP registration; the
  repo doubles as its marketplace (`claude plugin marketplace add
  joshidikshant/loopback`). Both manifests pass `claude plugin validate
  --strict`.
- **Visible loop closure in the widget**: status changes announce themselves on
  the open page — toast, pulsing pin, 🔔 tab-title flash (adapted from
  make-pages-interactive, MIT) — plus a `window.__loopback` page API
  (`pins`, `refresh()`, `project`, `endpoint`, `version`; adapted from
  DOM-Review, MIT).
- **CI** (GitHub Actions): build + smoke + init gate, and a Playwright E2E job.
- **Init gate** (`scripts/init-gate.mjs` / `npm run init-gate`): asserts all
  three agents' renderings, slug embedding, frontmatter validity, byte-level
  idempotence, merge preservation of user content, and `--agents` subsetting.

### Changed
- README rewritten as the product front door (hub model, screenshot,
  install-once-per-machine, 2-minute project integration, design decisions).
- `--help` now documents the hub model, all six HTTP endpoints, and `init`.

## [0.2.0] — 2026-07-20

### Added
- **Capture widget** (`widget/loopback-widget.js`): vanilla-JS, shadow-DOM toolbar
  with element-pinned comments, console/network ring buffers, failed-response
  capture, `data-loopback-context` run metadata, and live status pins hydrated
  from the bus.
- `GET /feedback` and `GET /widget.js` on the HTTP surface for pin hydration and
  one-tag embedding.
- Demo app (`demo/`) with an intentionally broken contact form and an AI-answer
  block for exercising the full loop.
- Playwright end-to-end test (`scripts/e2e.mjs`) covering widget capture →
  ingest → agent fix over MCP streamable HTTP → verified pins.

## [0.1.0] — 2026-07-20

### Added
- Loopback MCP bus: nine `loopback_*` tools (submit, list, get, claim, update
  status, comment, link change, resolve, stats) over **stdio** and **stateless
  streamable HTTP** using the official `@modelcontextprotocol/sdk`.
- `node:sqlite` (WAL) storage at `~/.loopback/loopback.db` — zero native deps.
- Atomic claims via guarded UPDATE; conflicts name the holding agent.
- `POST /ingest` plain-JSON entry point for widgets, CI hooks, and ingestors.
- Smoke test driving a real MCP client over stdio (`npm run smoke`).
