# Roadmap

Updated 2026-08-02. Open work lives here; shipped work — including the 21-pass
audit arc that took the suite from 11/20 to 20/20 — lives in the
[CHANGELOG](../CHANGELOG.md).

## Open

**Nothing.** 0.9.4 is live on all three channels and verified against the
published artifacts — `npm run verify:release` is 63/63.

Resolved in 0.9.3: `main` had been red for 16 consecutive `ci.yml` runs from
2026-07-27 (last green `623aa05`), with 0.9.0, 0.9.1 and 0.9.2 all published on
top of it. The failing check is fixed and `release-preflight` now refuses a
commit that is not green, pushed and tagged — so a red `main` is no longer
publishable.

Distribution is complete end to end:

| Surface | State |
|---|---|
| GitHub | [joshidikshant/loopback](https://github.com/joshidikshant/loopback) — tagged and released v0.9.0–v0.9.4 |
| npm | `loopback-mcp-server@0.9.4` — cold-verified from the registry |
| MCP Registry | `io.github.joshidikshant/loopback` — status `active`, listing at 0.9.4 (`isLatest`) |

Every P1–P3 shipped or moved to Deliberate with a measured rationale. What the
project needs next is not code: it is an adopter who is not DJ.

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
- **Widget stays unminified:** 59,443 B raw / 19,770 B gzipped on the wire
  (measured the way the server compresses it, `gzipSync` at zlib's default level),
  304 on repeats. Readable source is worth more to an auditing adopter than
  ~10KB of minifier savings. Revisit if adopters name first-load cost.

## Verification

Seven gates + `smoke` + `e2e` in CI on every push; `npm run canary` (own
workflow: path-triggered + weekly) runs 30 checks proving each subject's gate
fails when the subject breaks — `release-preflight` in both directions, since a
gate that refuses everything would otherwise pass its own canary: it blocks a
commit whose CI is red and still clears one whose CI is green. Every gate's
failure path is mutation-verified — the full history and the nine false-green
findings are in the CHANGELOG.

The seventh gate is `docs-facts-gate`, added after this audit: it re-measures
the widget's size, the tool count, the HTTP routes and the registry items
against the code, because every claim that had drifted was a hand-typed number
no gate had ever read. `link-gate` (own workflow) replaced a link check that had
been green since the day it was added while scanning zero links, and now asserts
a minimum link count per target so an empty crawl fails instead of passing.
