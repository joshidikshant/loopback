# Roadmap

Updated 2026-07-27. Open work lives here; shipped work — including the 21-pass
audit arc that took the suite from 11/20 to 20/20 — lives in the
[CHANGELOG](../CHANGELOG.md).

## Open

**Nothing.** Every P1–P3 shipped or moved to Deliberate with a measured
rationale. The one remaining button is DJ's: `npm publish` (0.9.0 is cut, the
tarball is proven by installing and running it from a clean directory).

## Next milestones (unscheduled, demand-driven)

- **B3 — multi-pin grouping.** Deferred until real usage demands it.
- **B4 — session recording.** Won't build; bridge PostHog (doc 02).
- Housekeeping (DJ-local): `claude mcp remove loopback -s project`.

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
