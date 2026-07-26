# Roadmap — pending items

Generated 2026-07-26 from an Impeccable `audit` pass (5 dimensions, 50 agents,
34 findings confirmed / 11 refuted) plus in-browser measurement of the running
hub. Everything here is **open**. Shipped work lives in the CHANGELOG.

**Audit Health Score: 11/20 — Acceptable (significant work needed)**

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2/4 | The widget capture form — the product's only human data-entry surface — has no programmatically labelled input |
| 2 | Performance | 2/4 | `renderPins` forces synchronous layout per pin on every scroll frame of the **host** page |
| 3 | Theming | 3/4 | `tokens.css` is not actually the single source: the widget carries a hand-copied duplicate that has already drifted |
| 4 | Responsive | 2/4 | 24% of the queue table is visible at 375px; the title column starts past the right edge |
| 5 | Implementation integrity | 2/4 | `--lb-fixed` and `--lb-verified` are byte-identical, so the pin turns green one step before it has earned it |

A note on where the weight sits: the dashboard came out of the shadcn pass in
good shape. **Most of what follows is in the widget**, which never got the same
treatment because it is vanilla JS in a shadow DOM and was excluded from the
component work. That exclusion was correct for shadcn and wrong for
accessibility — the widget is the surface real users touch.

---

## P0 — blocking

None. Nothing here prevents task completion for a sighted mouse user.

## P1 — fix before release

### 1. The widget capture form has no accessible names
`widget/loopback-widget.js:462-466`. `field()` appends a `<label>` and the
control as **siblings**, and the label has no `for`. Four of five controls
announce as unnamed; the fifth borrows its name from a placeholder that
disappears on first keystroke. Clicking a label also does not focus its control.
WCAG 1.3.1 / 3.3.2 / 4.1.2, all Level A.
→ Give each control an id and set `label.htmlFor`. A shadow root is its own id
scope, so host-page collisions are impossible. Separately, `:495-513` use
`<label>` for decorative notes ("✓ AI/automation context attached") — those
label nothing and should be `<div>`.

### 2. Widget toasts are never announced, including the only validation error
`widget/loopback-widget.js:388-399`. `toast()` appends a bare `<div>` with no
`role`, no `aria-live`, and there is no live region anywhere in the widget
(a grep of all 776 lines finds three ARIA attributes total). "Add a short title
first" is silent, `.f-title` is never marked `aria-invalid`, and focus never
moves — a screen-reader user submitting a 2-character title gets no feedback at
all and no way to discover why. WCAG 4.1.3 (AA) / 3.3.1 (A).

### 3. Pin mode is pointer-only
`widget/loopback-widget.js:405-444`. Picking an element to pin is driven by
`mousemove`/`click`, so any page content that is not itself focusable cannot be
pinned without a mouse. The product's core gesture is unavailable to keyboard
users.

### 4. The audit trail misattributes every human write
`dashboard/src/views/ItemDetail.tsx:53` — `const AUTHOR = "dj"`. Every comment,
edit, status change and attachment is recorded as "dj" regardless of who
performed it. The trail is Loopback's trust mechanism; in a tool other teams
run, an audit log that names the wrong person is worse than no log.
→ Needs a real identity source. Even a locally-stored name prompt beats a
constant.

### 5. Severity text fails WCAG AA (measured, not inferred)
`design/tokens.css:69,71,124` via `severityClass`. Measured in-browser with
transitions disabled and colours resolved through canvas:

| Theme | Token | Measured | Needs | Computed fix |
|---|---|---|---|---|
| Light | `--lb-p1` | 3.20:1 | 4.5:1 | L 0.666 → 0.579 |
| Light | `--lb-p3` | 2.58:1 | 4.5:1 | L 0.708 → 0.568 |
| Dark | `--lb-p3` | 4.18:1 | 4.5:1 | L 0.556 → 0.574 |

**This one is not a token tweak.** Light `p3` needs L≈0.568 and `p2` already
sits at 0.556 — compliant values make them visually identical. Four severity
levels cannot all clear 4.5:1 on white *and* stay separable by lightness alone.
The scale needs a second axis (weight, glyph, or an explicit label) before the
colours can be corrected. Decide the encoding first.

### 6. Evidence fields are typed and never rendered
`dashboard/src/lib/api.ts:46,55,58,62`. `resolution`, `network`, `url` and
`created_at` are on `Item` with **zero** render sites in the dashboard
(`grep -c resolution ItemDetail.tsx` → 0). The agent's view of an item is richer
than the human's. Most costly: `created_at` means **queue age is invisible** —
the single most operational fact in a triage queue.

---

## P2 — significant

### Product integrity
- **`--lb-fixed` and `--lb-verified` are byte-identical** in both themes
  (`design/tokens.css:60/62`, `114/116`). Loopback's thesis is "the pin turns
  green when an agent *verifies* the fix" — but it already turned green at
  `fixed`, when the agent merely claimed it. The one distinction the product is
  built on is not expressed by the colour system that carries it.
- **"This view is linkable" is false.** `dashboard/src/views/QueueList.tsx:45-50`
  — `writeFilters` serialises the filters but the search term `q` is separate
  state and never reaches the URL. Copy a URL while searching and the search is
  lost. The table caption asserts the guarantee anyway.
- **`adpushup.svg` ships as the worked example** in the attachment placeholder
  (`ItemDetail.tsx:459`) — a specific employer's asset name in an MIT tool.

### Design system
- **The widget re-declares the entire token set as literals**
  (`widget/loopback-widget.js:246-274`) and its dark theme has **already
  drifted** from `design/tokens.css` in three values (`--border` 15% vs 10%,
  `--input` 20% vs 15%, surface 0.205 vs 0.145). The dashboard and the registry
  each have a parity gate; the widget has none. Add one.
- **No `color-scheme` is declared anywhere**, so form controls, scrollbars and
  focus rings keep light-mode UA styling in dark mode.
- The widget uses **status tokens for non-status meaning** (`:317`), inverting
  the semantics the rest of the system relies on.

### Accessibility
- `run()` disables the focused control on every write
  (`ItemDetail.tsx:155-165`), throwing focus to `<body>` mid-task.
- No `main` landmark; SPA route changes update neither page title nor focus
  (`App.tsx:20-23`).
- Queue search, filtering and loading produce no status message.
- The widget form has no role or name, no Escape handler, and never restores
  focus on close.
- In-row filter controls have no descriptive name and expose no pressed state.
- Widget pins are unfocusable `<div>`s with click handlers.
- The FAB's accessible name is frozen and contradicts its visible label once
  pin mode is active.

### Responsive
- **The queue table has no mobile treatment.** 1334px intrinsic width; at 375px
  the title column starts at x=361 — off-screen. The page itself does not
  overflow (shadcn's `overflow-x-auto` container contains it correctly), but a
  phone user sees ids and nothing readable. Zero breakpoints in `QueueList.tsx`.
  → Needs a card layout under `sm:`, not a wider table.
- **42 interactive targets under 44×44px.** Worst: type filter 10×16, severity
  filter 14×16, row ids 130×16. SC 2.5.8 outright failures.
- Widget form inputs are 13px → iOS focus zoom on a fixed-position panel.
- Title cells inherit `whitespace-nowrap`, which is what makes the table wider
  than it needs to be.

### Performance
- **`renderPins` thrashes layout on every scroll frame of the host page**
  (`widget/loopback-widget.js:688-728`): a `querySelector` +
  `getBoundingClientRect` read interleaved with an `appendChild` write per pin,
  and a full teardown/rebuild of every pin element each frame. This runs on the
  *host application's* scroll thread — a guest widget degrading its host.

---

## P3 — polish

- **`prefers-reduced-motion` is honoured nowhere in either surface.** The pin
  pulse (`lbpulse`, 1.1s × 3) and the tip transition run unguarded. *(An earlier
  in-browser probe of mine reported this as present — that was a false positive
  from an injected third-party stylesheet, not Loopback's own CSS.)*
- The console monkey-patch `JSON.stringify`s every argument of every call.
- Detail page has one heading and it disappears in edit mode.
- Theme toggle never exposes which theme is active.
- Long unbreakable URLs overflow the failed-request and linked-change sections.
- `w-[220px]` on the id column is inert — measures 146px at every width.
- Search input's `w-56` in a wrapper without `min-w-0` forces page-level growth.
- Widget pins are 22×22 — two pixels under the target-size minimum.
- Element picker previews via `mousemove` only.
- Two of five writes discard the hub's error message.
- Orphaned doc comment in `src/http.ts:31-36` describes a token-inlining
  pipeline that no longer exists.

---

## Carried over (not from this audit)

- **B1 — structured repro steps.** The widget hardcodes `repro_steps: []`
  (`widget/loopback-widget.js:557`); the field is captured nowhere. ~20 lines.
- **B2 — auto-derived journey** from the captured route/console trail. ~40 lines.
- **B3 — multi-pin grouping.** Deferred.
- **B4 — session recording.** Won't build; borrow PostHog (doc 02).
- Freeze or delete the unused shadcn registry entry.
- `resolve()` should take an author param, same root cause as P1-4.
- `next-themes` is a dependency whose `useTheme()` is inert here — the Toaster
  tracks theme via inline custom properties instead. Remove or wire it.
- Housekeeping: `claude mcp remove loopback -s project` (duplicate scope).

---

## Suggested sequence

1. **`/impeccable harden`** — P1 items 1-3 and the P2 accessibility block. All
   in the widget, one surface, one pass.
2. **Decide the severity encoding** (P1-5). Blocks the contrast fix; it is a
   design call, not a code change.
3. **`/impeccable adapt`** — the mobile queue. Card layout under `sm:`, and the
   touch-target sweep.
4. **`/impeccable optimize`** — `renderPins`. It degrades the host app, so it
   outranks its P2 label for anyone embedding Loopback.
5. **Token parity gate for the widget** — the drift is already real and will
   keep widening.
6. **`/impeccable polish`** — the P3 list, last.

Re-run `/impeccable audit` after each to see the score move.
