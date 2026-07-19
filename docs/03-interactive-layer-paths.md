# The Interactive Layer: Three Paths, One Choice

*Synthesis of this whole thread — landscape → build-vs-borrow memo → working Loopback bus — now refocused through your three inspirations. Pick a path; each is fully executable from here.*

---

## What the inspirations actually teach

The three references converge on one product shape, and each contributes a different proof:

**Claude Design (Anthropic Labs)** proves the *interaction*: comments live **on the artifact itself**, spatially anchored — you point at the thing, not describe it. The AI acts on the comment and the revision appears where you pointed. Closed product, artifact-scoped; a pattern to copy, not a tool to adopt.

**Vercel Toolbar** proves the *workflow*: a floating toolbar injected into the running app, pinned comments with screenshots and metadata, a resolve lifecycle, teammates commenting without tooling knowledge. But it's locked to Vercel-hosted previews, and — telling detail — there's an **open community feature request asking Vercel to sync comments to agents for "AI feedback loops."** The workflow exists; the agent loop doesn't. That's precisely your gap, unfilled even by the inspiration.

**make-pages-interactive (Paras Chopra)** proves the *loop*, end to end, in ~300 lines: inject `feedback.js` into HTML → highlight/click/comment → comments land in a local `inbox.jsonl` → Claude reads the inbox, edits the page → the page **auto-reloads with a walkthrough of what changed**. MIT, stdlib-only, static-HTML folders, Claude Code only. Tiny, but the full circle — including the underrated last step: *the reporter sees the fix land where they commented.*

One more data point from scanning for prior art: **DOM-Review**, a 2-star MIT Chrome extension (Feb 2026), independently reinvents "click element → comment → agent reads it via Chrome DevTools MCP" — but localhost-only, per-origin, no persistent queue, no cross-project view. Multiple people are circling this. Nobody has shipped the whole thing.

**The synthesis:** spatially-anchored comments (Claude Design) + injected toolbar workflow (Vercel) + agent-closes-the-loop-visibly (make-pages-interactive) — running on **your** bus, so it spans all projects and all three agents. The backend for this already exists: Loopback v0.1.0, tested, with `POST /ingest` waiting for exactly this producer.

---

## The paths

### Path 1 — Build the Loopback Toolbar *(the flagship)*

A single `<script>` tag you drop into any web app (dev **or** deployed). It renders a Vercel-style floating toolbar; toggling comment mode makes every element clickable, Claude-Design-style — click, type a note, and it captures selector, route, URL, viewport, recent console lines, failing network calls, and a screenshot, then POSTs to Loopback's `/ingest`. Pins persist on the page and **show live status from the bus**: open → claimed by claude-code → fixed (with commit link) → verified. The make-pages-interactive trick — highlight what changed on reload — becomes the closing act of every loop.

- **What it takes:** ~1–2 focused sessions. Vanilla JS overlay (~5–10KB, shadow-DOM so it never fights your app's CSS), a `GET /feedback?route=` addition to Loopback for pin hydration, CORS on `/ingest`.
- **Coverage:** every web project, any framework, dev and prod (token-gate the widget in prod). Mobile stays on Sentry/PostHog rails, as decided in the memo.
- **Your four priorities:** cost H · ship-fast M (days, not hours) · cross-agent H (agents consume via the MCP server that's already passing tests) · control H (fully yours, MIT-able — and notably, this is the piece the market keeps asking for; it could even become a public project).
- **Risk:** you own overlay edge cases (z-index, iframes, CSP on hardened prod sites). Mitigable, known territory.

### Path 2 — Fork the pattern *(fast seed, same destination)*

Start from the working OSS code instead of a blank file: take **make-pages-interactive**'s `feedback.js` (selection/highlight/comment UX + reload-walkthrough) and **DOM-Review**'s element-comment model (both MIT), swap their storage (`inbox.jsonl` / DOM-embedded JSON) for Loopback `/ingest`, and generalize from static-HTML folders to any dev server. Ship a **localhost-first** toolbar in roughly one session; harden toward deployed apps as Phase 2.

- **Priorities:** cost H · ship-fast H (working demo fastest) · cross-agent H (same bus) · control H.
- **Risk/cost of the shortcut:** both seeds are hobby-grade (1 commit / 18 commits); you'll rewrite most of it on the way to production quality — the seed buys you the first demo, not the destination. Static-HTML and localhost assumptions need unwinding.
- **Honest framing:** Paths 1 and 2 are the same road; 2 just starts the car downhill. If the seed code fights us, we fall back to 1 with nothing lost.

### Path 3 — Borrow the surfaces, glue only *(no UI build)*

Use existing comment surfaces where they natively fit and only write glue: **Vercel Toolbar comments** on your Vercel-hosted projects' previews; **DOM-Review** extension for localhost work; **Jam** (MCP on free tier) for reporting on arbitrary/deployed sites; small ingestors pull what's pullable into Loopback.

- **Priorities:** cost H · ship-fast H (today) · cross-agent M · control L–M.
- **Why it leaks:** Vercel comments have **no public API** (that community request is still open) — the flagship surface can't reach your bus programmatically; DOM-Review is localhost/per-origin; Jam is proprietary capture. Three different UX-es for reporters, no on-page status pins anywhere, and your best projects' feedback stays siloed in Vercel. This is the "live with the fragmentation" option — legitimate as a stopgap, unsatisfying as the destination this thread has been driving toward.

---

## Side-by-side

| | 1 · Build toolbar | 2 · Fork seeds | 3 · Borrow + glue |
|---|:--:|:--:|:--:|
| Time to first demo | days | ~1 session | hours |
| Works on any project (incl. non-Vercel, deployed) | ✓ | eventually | ✗ |
| One consistent UX + on-page status pins | ✓ | ✓ | ✗ |
| All 3 agents via the tested bus | ✓ | ✓ | partial |
| Control / self-host / MIT-able asset | ✓ | ✓ | ✗ |
| Rework risk | low | medium (rewrite seed) | — |
| Long-term fit with everything decided in this thread | **best** | best (same endpoint) | stopgap |

## Recommendation

**Path 2 rolling into Path 1** — start from the MIT seeds to get a clickable localhost demo on one pilot repo fast, then harden into the full any-app toolbar. It honors all four of your priorities, it's the only route to the one-surface-everywhere experience the inspirations point at, and the bus half is already built and tested. Path 3 remains available as garnish later (a Jam ingestor is cheap) rather than as the foundation.

Whichever you pick, my first deliverable is the same shape: a runnable demo against Loopback on a sample page, then wiring into your pilot repo.
