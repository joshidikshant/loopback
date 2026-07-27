# Roadmap — pending items

Updated 2026-07-27, after five Impeccable `audit` passes with remediation
between each. Everything here is **open**. Shipped work lives in the CHANGELOG.

## Where the score went

| Pass | Score | What it mostly found |
|---|---|---|
| 1 | 11/20 | Real defects, concentrated in the widget |
| 2 | 14/20 | Remediation held; the new a11y gate was thin |
| 3 | **13/20** | The gate I added was decorative in three places |
| 4 | 14/20 | Two more gates false-greening; a thesis bypass |
| 5 | 14/20 | The a11y gate was non-hermetic; three stacked measurement bugs |

**The score is not climbing, and that is the honest result.** Passes 3–5 spent
most of their findings auditing the *verification* rather than the code — and
were right to. Five separate times, a gate reported green on something it could
not actually see:

- `impeccable detect` exits 0 having scanned nothing
- `registry-gate`'s theme check could not distinguish `:root` from `.dark`
- `a11y-gate` counted a vendor stylesheet as our reduced-motion rule
- `a11y-gate` measured a foreign database because it served the demo without
  rewriting the endpoint
- the `components.css` colour check skipped every rule it was written to protect,
  because they are all one-liners

Each of those was fixed and then mutation-tested. That is the durable outcome of
this exercise; the number is not.

**What a 20/20 would require** is not more of this loop. Four of the five
dimensions are held down by things that are genuine scope decisions, not
oversights — listed below.

---

## Open — real, and worth doing

### P1

- **Attachments have no agent-facing surface.** `itemMarkdown` (the DEFAULT MCP
  response format) drops them entirely, and no SKILL.md or AGENTS.md mentions
  them. The dashboard promises "an agent copies it to the target path and
  commits it" — nothing tells an agent that. A full store/HTTP/dashboard feature
  is invisible to the consumers it was built for.
- **The widget's `.tip` fails SC 1.4.13.** It is `pointer-events:none`, has no
  dismiss that leaves focus in place, and sits `position:fixed` over host
  content, so the "does not obscure" exception does not apply.

### P2

- **`--host 0.0.0.0` still has no authentication.** Documented and warned about,
  but the mode is promoted for phone testing. A bearer token is the next real
  security milestone.
- **`itemMarkdown` vs `structuredContent` drift.** Two representations of an
  item maintained by hand; nothing asserts they carry the same fields.
- **Widget bundle is 46KB raw.** 15KB gzipped and the hub now compresses, so
  this is not urgent — but it is 4.6× the original sketch.

### P3

- Repro steps are still hardcoded `repro_steps: []` in the widget (see B1 below).
- `next-themes` remains a dependency whose `useTheme()` is inert here.
- `design/components.css` is published but has no in-repo consumer — it exists
  for external adopters only. Reasonable, but worth stating in its header.

---

## Deliberate — not defects, and not being changed without a reason

These recur in audits. Each is a decision with a rationale:

- **No pagination.** The queue has 22 items. Revisit past ~500.
- **No confirm on status change.** Transitions are plain UPDATEs with no guard
  and the Select stays enabled — nothing is irreversible, so a modal on the
  highest-frequency action is friction with no payoff.
- **`text-[11px]`** is the shared `.lb-label` token, which the widget renders
  identically. Tailwind has no 11px step.
- **44×44 not pursued for in-row table controls.** 24×24 (SC 2.5.8, AA) is met
  everywhere; 44px targets exist on the filter strip and phone cards. The audit
  rubric's top band is "WCAG AA fully met", not AAA.
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
| `registry-gate` | stale published registry; theme drift **per block**; a published recipe missing variables it consumes | ✅ |
| `dashboard-gate` | committed build drifting from source | ✅ |
| `widget-token-gate` | the widget's inlined token copy drifting; status colours colliding; literal colours in `components.css` | ✅ |
| `impeccable-gate` | design anti-patterns; **canary-verified** because the detector exits 0 on an empty scan | ✅ |
| `a11y-gate` | contrast (both themes, hovered rows, alpha-composited), target size, accessible names, landmarks, route titles, reduced motion, widget labels and keyboard operation — **hermeticity-guarded** | ✅ |

Every one has had both failure paths verified by deliberately breaking it. That
discipline is the thing worth keeping from this exercise.
