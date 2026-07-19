# Changelog

All notable changes to Loopback are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Fixed
- **E2E hermeticity**: `scripts/e2e.mjs` previously spawned its bus on the
  hub's default port — with a central instance already running, the spawn died
  on EADDRINUSE and the suite silently ran against (and wrote test items into)
  the live `~/.loopback/loopback.db`. The suite now uses dedicated ports
  (7177/5273, overridable), injects its endpoint into the demo page via
  `LOOPBACK_ENDPOINT`, and hard-aborts if the endpoint it reaches is not a
  fresh instance. (fb_mrsdza3z)

## [0.3.1] — 2026-07-20

Hardening from the first real-world dogfood run (widget injected at runtime on
a production-grade Next.js 16 App Router site). Each fix closed a queue item
end-to-end: filed → claimed → fixed → verified on the live page → resolved.

### Fixed
- **Widget unreadable on `color-scheme: dark` hosts**: the host page's
  color-scheme inherited into the shadow root, so UA dark-mode control colors
  produced white-on-white buttons/inputs. The widget UI now pins
  `color-scheme: light` and explicit control colors. (fb_mrsdh5kz)
- **Stale pins after SPA navigation**: client-side route changes left the
  previous route's pins rendered for up to one 10s poll tick. The widget now
  hooks `history.pushState`/`replaceState` + `popstate` and refreshes
  immediately; scroll/resize pin re-renders are rAF-throttled. (fb_mrsdrgpo)
- **Brittle selectors on class-only DOMs**: the generator now includes up to
  two semantic class tokens per path segment (state/utility classes filtered
  via stop-list) before falling back to `nth-of-type`, and exposes
  `window.__loopback._cssPath` for tests and browser-driving agents.
  (fb_mrsdrgq9)

### Added
- E2E regression coverage for all three: dark-scheme control colors,
  semantic-class selector output, and instant pin refresh across
  `pushState`/`popstate` navigations.

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
