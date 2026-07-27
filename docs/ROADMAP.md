# Roadmap — pending items

Updated 2026-07-27, after twenty Impeccable `audit` passes with remediation
between each. Everything here is **open**. Shipped work lives in the CHANGELOG.

## Where the score went

| Pass | Score | What it mostly found |
|---|---|---|
| 1 | 11/20 | Real defects, concentrated in the widget |
| 2 | 14/20 | Remediation held; the new a11y gate was thin |
| 3 | 13/20 | The gate I added was decorative in three places |
| 4 | 14/20 | Two more gates false-greening; a thesis bypass |
| 5 | 14/20 | The a11y gate was non-hermetic; three stacked measurement bugs |
| 6 | 14/20 | A path traversal and a dead cache, both introduced in pass 5's fixes |
| 7–18 | 14 → 16 | Grinding: mostly verification that overstated its coverage |
| 19 | 16/20 | Performance reached 4/4; four gates still could not see |
| 20 | **19/20** | Implementation Integrity: two agent-facing docs had drifted |

### What the passes were actually finding

The dominant finding across all twenty passes was not broken UI. It was
**verification reporting green on something it could not see** — nine separate
times:

- `impeccable detect` exits 0 having scanned nothing
- `registry-gate`'s theme check could not distinguish `:root` from `.dark`
- `registry-gate` then called every theme-invariant token "absent" because it
  compared blocks instead of modelling the cascade
- `a11y-gate` counted a vendor stylesheet as our reduced-motion rule
- `a11y-gate` measured a foreign database because it served the demo without
  rewriting the endpoint
- `a11y-gate`'s contrast dedupe keyed on the element's own (transparent)
  background, collapsing different composited surfaces into one measurement
- `a11y-gate` probed reduced motion on a page where it had already injected
  `animation: none !important`, so the assertion read identically with the rule
  deleted
- the `components.css` colour check skipped every rule it was written to
  protect, because they are all one-liners
- `@theme inline` had no gate at all: a class naming a real token that
  `index.css` does not map emits zero CSS and builds green

Every one was fixed and then **mutation-tested in both directions**. Several
fixes were themselves caught being decorative on the pass after they landed —
including two in pass 20's own remediation, where the first viewport set chosen
to prove the widget's height clamp passed with the clamp reverted, and the
first attachment-parity canary was a no-op because the test item had no
attachment. That loop is the durable output of this exercise.

## The one open dimension

**Implementation Integrity — 3/4.** Remaining gap is listed under P2 below
(`--host 0.0.0.0` ships with no authentication). The other four dimensions
score 4/4, measured rather than asserted:

| Dimension | Score | Evidence |
|---|---|---|
| Accessibility | 4/4 | Contrast in both themes incl. every hovered row and alpha-composited surface; focus indicators driven by real Tab; 24×24 everywhere and 44×44 on every touch viewport; `h1 → 6×h2` with no skips; landmarks, route titles and focus moves; 200% zoom at 320/375/640/700; reduced motion with an intentional still state in both layers |
| Performance | 4/4 | Lean list projections, async JSON gzip, pre-gzipped hashed assets with ETag/304, read-pass/write-pass pin rendering with a negative cache |
| Theming | 4/4 | One token system across three surfaces, parity gated in both directions, `@theme` mapping gated, orphan and literal-colour detection, `color-scheme` published |
| Responsive | 4/4 | 0 sub-44px targets on touch viewports, no horizontal scroll at any width, widget clamped and measured at 320×480 / 568×320 / 375×812 |

---

## Open — real, and worth doing

### P1

- **The widget's `.tip` sits `position: fixed` over host content.** Dismissible
  (Escape), hoverable and persistent are all implemented, so SC 1.4.13 is met —
  but the "does not obscure" exception still does not apply, and no gate
  measures what it covers on a host page.

### P2

- **`--host 0.0.0.0` still has no authentication.** Documented and warned
  about, but the mode is promoted for phone testing. A bearer token is the next
  real security milestone, and it is the only thing keeping Implementation
  Integrity off 4/4.
- **Widget bundle is 46KB raw.** 15KB gzipped and the hub now compresses, so
  this is not urgent — but it is 4.6× the original sketch.

### P3

- Repro steps are still hardcoded `repro_steps: []` in the widget (see B1).
- `design/components.css` is published but has no in-repo consumer — it exists
  for external adopters only. Worth stating in its header.

---

## Deliberate — not defects, and not being changed without a reason

These recur in audits. Each is a decision with a rationale:

- **No pagination.** The queue has 22 items. Revisit past ~500.
- **No confirm on status change.** Transitions are plain UPDATEs with no guard
  and the Select stays enabled — nothing is irreversible, so a modal on the
  highest-frequency action is friction with no payoff.
- **`text-[11px]`** is the shared `.lb-label` token, which the widget renders
  identically. Tailwind has no 11px step.
- **44×44 not enforced for in-row table controls on desktop pointers.** Measured
  0 sub-44px targets at 375×812 and 768×1024; the 15 that remain at 1280×800 are
  desktop-only, where SC 2.5.8 (AA) requires 24×24 and is met.
- **No `aria-modal` on the capture form.** We neither trap focus nor can mark a
  host page inert. Claiming modality without enforcing it is worse than not
  claiming it.
- **The widget is vanilla JS in a shadow DOM.** It is injected into arbitrary
  pages; React is not available to it.

---

## Carried over (predates the audits)

- **B1 — structured repro steps.** `widget/loopback-widget.js` hardcodes
  `repro_steps: []`; the field is captured nowhere. ~20 lines.
- **B2 — auto-derived journey** from the captured route/console trail. ~40 lines.
- **B3 — multi-pin grouping.** Deferred.
- **B4 — session recording.** Won't build; borrow PostHog (doc 02).
- Housekeeping: `claude mcp remove loopback -s project` (duplicate scope).

---

## The gates, and what each is defended against

Six gates plus `smoke` and `e2e` — eight CI verification steps.

| Gate | Guards against | Verified by breaking |
|---|---|---|
| `init-gate` | init rendering drift, non-idempotent merges | ✅ |
| `registry-gate` | stale published registry; theme drift per block, resolved the way a browser resolves it; a published recipe missing variables it consumes | ✅ |
| `dashboard-gate` | committed build drifting from source | ✅ |
| `widget-token-gate` | the widget's inlined token copy drifting; status colours colliding; literal colours in `components.css`; **`lb-*` utilities `@theme` never mapped** | ✅ |
| `impeccable-gate` | design anti-patterns; **canary-verified** because the detector exits 0 on an empty scan | ✅ |
| `a11y-gate` | contrast (both themes, hovered rows, alpha-composited), target size, accessible names, landmarks, route titles, reduced motion in both layers, widget labels/keyboard/**responsive** — hermeticity-guarded | ✅ |
| `smoke` | MCP contract; **`itemMarkdown` dropping a field `structuredContent` carries** | ✅ |
| `e2e` | the full human→bus→agent→human loop; **assets reaching the agent-facing rendering** | ✅ |

Every one has had both failure paths verified by deliberately breaking it. That
discipline is the thing worth keeping from this exercise.
