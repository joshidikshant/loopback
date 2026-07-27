# Roadmap

Updated 2026-07-27. Open work lives here; shipped work — including the 21-pass
audit arc that took the suite from 11/20 to 20/20 — lives in the
[CHANGELOG](../CHANGELOG.md).

## Open

**One, and it needs DJ's npm OTP:** publish **0.9.1**, which adds the `mcpName`
field the MCP Registry requires to prove ownership. 0.9.0 shipped without it
and npm versions are immutable, so registry submission is gated behind this
release. Everything is staged and gated; see "Publishing to the MCP Registry"
in the README.

Otherwise: every P1–P3 shipped or moved to Deliberate with a measured
rationale, and **v0.9.0 is published** — `npm i loopback-mcp-server` (252.7 kB,
32 files, MIT). Verified cold from the registry in a clean directory: install →
`init` renders all five files with the slug threaded through → the generated
`.mcp.json` path resolves and boots a live hub → dashboard, widget and intake
all serve. The README's install instructions are now true on any machine.

## Next milestones (unscheduled, demand-driven)

- **B3 — multi-pin grouping.** Deferred until real usage demands it.
- **B4 — session recording.** Won't build; bridge PostHog (doc 02).
- ~~Housekeeping: `claude mcp remove loopback -s project`~~ — **withdrawn,
  nothing to remove.** The "duplicate" is deliberate layering: the user-scope
  entry (absolute path in `~/.claude.json`) is what makes the hub reachable
  from every other project on this machine, and the repo's committed
  `.mcp.json` is the product — init ships it and the repo dogfoods it. Inside
  the repo the project entry wins; removing it via `claude mcp remove` would
  edit a shipped file.

## Deliberate — decisions, not defects

- **No pagination.** The queue has ~22 items. Revisit past ~500.
- **No confirm on status change.** Plain UPDATEs, nothing irreversible — a
  modal on the highest-frequency action is friction with no payoff.
- **`text-[11px]`** is the shared `.lb-label` token; Tailwind has no 11px step.
- **44×44 not enforced for desktop-pointer table controls.** 0 sub-44px
  targets on touch viewports; desktop needs 24×24 (SC 2.5.8 AA) and has it.
- **No `aria-modal` on the capture form.** We neither trap focus nor can mark
  a host page inert; claiming modality without enforcing it is worse.
- **The widget is vanilla JS in a shadow DOM** — injected into arbitrary
  pages; React is not available to it.
- **Widget stays unminified:** 57,183 B raw / 18,945 B gzipped on the wire,
  304 on repeats. Readable source is worth more to an auditing adopter than
  ~10KB of minifier savings. Revisit if adopters name first-load cost.

## Verification

Six gates + `smoke` + `e2e` in CI on every push; `npm run canary` (own
workflow: path-triggered + weekly) proves all 15 checks fail when their
subject breaks. Every gate's failure path is mutation-verified — the full
history and the nine false-green findings are in the CHANGELOG.
