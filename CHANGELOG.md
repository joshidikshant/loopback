# Changelog

All notable changes to Loopback are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

## [0.6.0] — 2026-07-20

Human triage: the queue stops being read-only for people.

### Added
- **`GET /queue/:id` — a deep-linkable item view.** Every captured detail on
  one page: metadata, report, repro steps, failing requests with their response
  bodies, full network and console history, AI run context, captured
  environment, linked change, and the complete comment trail. Paste the URL to
  a teammate or an agent and they land on exactly the same thing. Queue rows
  link to it; the inline expansion stays for a quick read.
- **Human triage actions** — add a comment and change status directly from the
  item view, as plain HTML form posts that work without JavaScript. Filing was
  already possible from the widget; commenting and moving an item previously
  required an agent or `curl`.
- E2E coverage for the detail view: full context renders, a human comment lands
  on the trail, and the security guard below actually holds.

### Security
- **State-changing triage endpoints are same-origin only.** The server is
  unauthenticated with deliberately wide-open CORS, because the capture widget
  must `POST /ingest` from whatever origin the host app runs on. That trade is
  fine for append-only intake, but must not extend to rewriting an item's
  status or audit trail — otherwise any page you merely visit could quietly
  edit your queue. `/queue/:id/comment` and `/queue/:id/status` now reject
  cross-origin submissions (browsers always attach `Origin` to a cross-origin
  POST) while local tooling that sends no `Origin` keeps working. `/ingest`
  stays open by design; E2E asserts both halves.

## [0.5.0] — 2026-07-20

**Loopback Design System v0** — one token set behind both surfaces, in vanilla
CSS speaking shadcn/ui's contract, plus a published shadcn registry. No React,
no Tailwind, no build step added.

### Added
- **`design/tokens.css`** — shadcn's semantic variables verbatim (oklch,
  `.dark` class, multiplicative radius scale) plus Loopback's `--lb-*` domain
  tokens for feedback status and severity. **`design/components.css`** —
  vanilla recipes (`lb-btn` with variants, `lb-badge`, `lb-card`, `lb-table`,
  `lb-input`, `lb-pin`) using only tokens, so the stylesheet themes itself from
  a host project's palette. Rationale: [design/README.md](design/README.md).
- **Published shadcn registry** (`registry.json` → `public/r/*.json`):
  `loopback-theme` (status/severity tokens that add to a consumer's theme
  rather than replacing it — the CLI also emits `@theme inline` mappings, so
  `bg-lb-verified` works as a utility) and `loopback-widget` (the capture
  widget itself). Installable from a static URL with no auth, and discoverable
  by the **shadcn MCP** via a `@loopback` namespace in `components.json`.
  Verified by installing both into a scratch consumer project.
- **`/queue` item detail** — rows expand in place to the report, captured
  context (failing requests with response bodies, run metadata, console),
  linked change, and the full comment trail; plus a `GET /feedback/:id`
  endpoint. Closes fb_mrsuxhpm. The page also gained a theme toggle that
  resolves before first paint.
- **`registry-gate`** (`npm run registry-gate`, wired into CI) — validates the
  manifest structurally, asserts the built registry is byte-in-sync with the
  source it ships, and catches non-root-relative `target` mistakes.

### Fixed
- **The widget could be restyled by its host page.** Custom properties pierce
  shadow boundaries and `all: initial` does not reset them; worse, a *normal*
  outer-document rule targeting the host element beats `:host` regardless of
  specificity, so `#loopback-widget-host{…}` or even `div{color-scheme:dark}`
  could override the widget — the same mechanism behind the original
  white-on-white bug. Tokens now live on an internal `.lb-root` wrapper that
  the outer page cannot select. E2E asserts ≥4.5:1 contrast under a hostile
  host stylesheet.
- **The widget built its UI with `innerHTML`**, interpolating host-page data
  (context keys, request URLs, reporter-authored titles) into markup. The
  shell, capture form, and pin list are now built with DOM calls and
  `textContent`.
- Widget dark mode: it follows the viewer's `prefers-color-scheme` rather than
  forcing light, and pin colours come from CSS classes instead of inline
  styles, so the status palette lives in exactly one place.

### Added (self-integration, from the previous pass)
- **Loopback is now its own reference integration.** `/queue` embeds the
  capture widget (`data-project=loopback`, endpoint derived from the request
  host so it works on localhost, a LAN `--host` bind, or behind a proxy) — you
  can pin feedback about Loopback on Loopback's own page. The repo is also
  self-onboarded with its own `init`, so any agent opening it finds AGENTS.md,
  both SKILL.md installs, and all three MCP configs. (fb_mrsusvxf)

### Fixed
- **`init` leaked a machine path when the server lives inside the onboarded
  repo**: self-onboarding wrote an absolute `/Users/<name>/…` path into
  `.mcp.json` — unusable by other clones and about to be committed publicly.
  It now emits a repo-relative `./dist/index.js` in that case (absolute stays
  correct for external consuming repos, `npx github:` for ephemeral runs), and
  the init gate asserts the committed configs carry no home directory.
  (fb_mrsuu878)

### Known gaps
- `/queue` has no item detail view: comments, links, and captured context are
  only readable through `loopback_get_feedback`. Needs `GET /feedback/:id` +
  expandable rows. Filed as fb_mrsuxhpm (triaged) — through the widget, on the
  queue page itself.

## [0.4.0] — 2026-07-20

The surfaces release: the queue is explicitly cross-surface, with the flag,
docs, and snippets to prove it. Driven by round two of real-world dogfooding
(contact-form hero scenario + surface audit).

### Added
- **`--host` / `LOOPBACK_HOST`** for the `--http` hub (default stays
  `127.0.0.1`): opt-in LAN binding so physical iOS/Android devices can load
  the widget and POST `/ingest`. The server warns loudly that there is no
  auth; trusted networks only. (fb_mrseejl6)
- **`docs/05-surface-compatibility.md`** — the tiered surface matrix (web,
  extensions, Electron/Tauri, WebViews, native macOS/Windows, mobile
  simulator/device/production, CLI/CI, agents) with native `POST /ingest`
  snippets for Swift, Kotlin, C#, and shell, plus a README "Where it works"
  section.

### Fixed
- **`/queue` change column ignored commit-only links** — items linked with a
  commit but no PR showed "—"; now falls back to the short SHA. (fb_mrseejkq)
- **Demo page dark-on-dark in dark-preferring browsers** — same class as the
  `/queue` bug; demo now declares `color-scheme: light` + explicit background.
  (fb_mrseejln)
- **`/queue` unreadable in dark-preferring browsers**: the triage page set dark
  text but no background/color-scheme, so a dark UA canvas swallowed the rows.
  It now declares `color-scheme: light` + an explicit background — the same
  discipline the widget's shadow UI got in 0.3.1. (fb_mrse2fdk)
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
