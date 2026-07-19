# Changelog

All notable changes to Loopback are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

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
