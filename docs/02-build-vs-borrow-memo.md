# Build vs. Borrow: The Feedback Layer for Your Coding Agents

*Decision memo. Scored against your stated priorities — low cost, ship fast, works across all your agents, and control/self-host — and your portfolio: React/Next, other web, backend/APIs, and mobile. Companion to the Loopback spec.*

---

## Bottom line (read this first)

**Borrow ~90%, build ~10%.** Every mature tool in this space is a *single slice* of the loop and — critically for you — *mostly web-only*. Your portfolio includes mobile and backend, and only two tools (Sentry, PostHog) reach those. So no off-the-shelf product gives you *one* feedback surface across web + mobile + backend + all three agents.

The move: **borrow the hard parts** — agent-vision, error capture, usage/replay — as free, MCP-native, mostly-open-source tools, and **build one thin thing**: the Loopback "feedback bus" that unifies them into a single project-tagged, write-back queue every agent shares. That single build is what satisfies all four of your priorities at once; nothing on the market does.

**The one trap:** build/deploy any MCP layer as **stdio or streamable HTTP, never SSE**. SSE is deprecated in Claude Code and unsupported in Codex — it's the only thing that would break true agent-agnosticism.

---

## How I scored it (your weights)

You picked all four priorities, so I weight them equally. Scores are H / M / L.

- **Cost** — free / open-source / generous free tier = H.
- **Ship-fast** — near-zero setup, works with your existing agents today = H.
- **Cross-agent** — MCP-native and works across **Claude Code + Codex + Gemini CLI** = H.
- **Control** — open-source *and* realistically self-hostable = H.

Plus two coverage checks that decide fit: **which feedback type** (UI / backend / usage / UX) and **which stacks** (React/Next, other web, backend, **mobile**).

---

## The decision, one line per use case

| # | Your use case | Best borrow | Build? | Why |
|---|---|---|---|---|
| A | Click a live **web UI**, agent edits the code | stagewise | No (optional) | Nice for web UI; but web-only, no mobile, and its bridge to *your* three agents is weak (mid-pivot to its own IDE). Low-stakes add-on. |
| B | Agent **sees & verifies** the running app (console/network/DOM/perf) | **Chrome DevTools MCP** (+ Playwright MCP) | **No — borrow** | Free, Apache-2.0, local, explicitly supports all 3 agents. Zero reason to build. Web-only (mobile = viewport emulation). |
| C | **Production errors → agent fix** (backend + web + **mobile**) | **Sentry MCP + Seer** | No — borrow | Only mature option with first-class mobile (iOS/Android/RN/Flutter) and an autofix that "sends fixes to Claude." Cost + self-host caveats below. |
| D | **Real usage + session replay + surveys → agent** (web + **mobile**) | **PostHog MCP** | **No — borrow** | Uniquely covers usage + web *and* mobile replay + qualitative surveys, MCP-native, MIT-ish, huge free tier. Best all-round fit. |
| E | **Human-reported bug → agent** (one click → full repro) | Jam.dev *or* Formbricks | No — borrow | Jam = fastest (MCP on free tier, all agents) but proprietary/web. Formbricks = OSS/self-host (has RN mobile) but no MCP → you bridge it. |
| F | **One inbox across ALL projects & stacks**, human + machine, that any agent reads **and writes fixes back to** | — nothing does this — | **BUILD** | The only gap. Small (weekend Phase-0). This is the thin Loopback bus. Justified precisely by *your* mix: mobile + cross-agent + control. |

---

## Weighted scorecard (against your four priorities)

| Tool | Cost | Ship-fast | Cross-agent (all 3?) | Control / self-host | Role in the loop | Verdict |
|---|:--:|:--:|:--:|:--:|---|---|
| **Chrome DevTools MCP** | H | H | ✓ H | H (Apache, local) | Agent sees/debugs running web app | **Borrow — core** |
| **Playwright MCP** | H | H | ✓ H | H (Apache, local) | Agent drives/verifies UI, E2E | **Borrow — core** |
| **PostHog (MCP)** | H | H | ✓ H | M (self-host unsupported at scale) | Usage + web/mobile replay + surveys | **Borrow — core** |
| **Sentry (MCP + Seer)** | M (Seer $40/contrib) | H | ✓ H* | L–M (FSL; heavy self-host) | Errors → autofix; **mobile** | **Borrow — core** |
| **Jam.dev** | H (MCP on free) | H | ✓ H | L (proprietary/cloud) | Human bug reports → agent | Borrow — optional |
| **stagewise** | H | M–H | ~ L (BYOK, not your 3) | H (AGPL, local) | Click web UI → code edit | Borrow — optional |
| **Tidewave** | H | M | ✓ H | H (runs in your app) | Backend runtime/DB/logs → agent | Borrow *if* Elixir/Rails |
| **Formbricks** | H | M | ✗ (API/webhook) | H (AGPL, self-host) | OSS human surveys (web+RN) | Borrow *if* control-first |
| **GlitchTip** | H | M | ✗ (no MCP) | H (MIT, light self-host) | OSS errors (Sentry-compatible) | Borrow *if* control-first |
| **Frontman** | H | M | ~ (own-agent framing) | H (OSS, dev-only) | Web runtime context → agent | Verify / skip |
| **Onlook** | M | L–M | ✗ (no MCP yet) | M (heavy self-host) | Figma-like React design → code | Skip for this purpose |
| **BrowserTools MCP** | — | — | — | — | (deprecated) | **Skip — dead** |
| **▶ Loopback (build)** | H (~$0) | M (weekend v0) | ✓ H (you own it) | H (fully yours) | Unifies all of the above | **BUILD** |

\* Sentry names Claude Code explicitly; Codex/Gemini connect via generic MCP (unverified first-party, but MCP-compatible).

---

## Coverage grid — this is why you can't just borrow

| Tool | Feedback type | React/Next | Other web | Backend | **Mobile** |
|---|---|:--:|:--:|:--:|:--:|
| Chrome DevTools MCP | UX / debug / perf | ✓ | ✓ | ~ (via network) | ✗ (emulation only) |
| Playwright MCP | UX / interaction | ✓ | ✓ | ~ (via network) | ✗ (emulation; exp. Android) |
| stagewise | UI / frontend | ✓ | ~ (weak Svelte/Astro) | ✗ | ✗ |
| Onlook | UI / design | ✓ | ✗ | ✗ | ✗ |
| Sentry + Seer | Backend / crash | ✓ | ✓ | ✓ | **✓ (iOS/Android/RN/Flutter)** |
| PostHog | Usage / UX | ✓ | ✓ | ✓ (events) | **✓ (replay iOS/Android/RN/Flutter)** |
| Jam.dev | Human bug report | ✓ | ✓ | ~ (network) | ✗ (web capture) |
| Tidewave | Backend runtime | ~ | ~ | ✓ (Elixir/Rails) | ✗ |
| Formbricks | Human survey | ✓ | ✓ | ✗ | ✓ (React Native) |

**Read the mobile column top to bottom.** Everything that lets an agent *see* or *edit* your UI stops at the browser. Only Sentry and PostHog cross into native mobile — and they cover errors and usage, not "click this button, fix it." For a portfolio that includes mobile, a single consistent feedback surface can only come from a layer *you* put on top. That's the strategic case for the one build.

---

## The one thing to build — and why it's justified *for you*

**Loopback** = a small MCP server + a tiny capture widget that normalizes every signal (a Sentry error, a PostHog replay, a survey response, a bug you file, a UI note) into one schema, tags it to a project, and exposes it to any agent with `list / get / claim / update_status / link_change`. Details are in the spec I sent; this memo is the evidence that it's the right — and only — build.

It's the only option that scores **H on all four of your priorities simultaneously**:

- **Cost:** ~$0 — SQLite + a local MCP process.
- **Ship-fast:** Phase-0 is a weekend; you borrow everything underneath it.
- **Cross-agent:** you build it to the safe transport intersection (stdio + streamable HTTP), so Claude Code, Codex, and Gemini all read/write the same queue.
- **Control:** you own the data and the schema; it can sit entirely on your machine.

And it's the only thing that spans your **whole portfolio** — web *and* mobile *and* backend — because it sits *above* the capture tools rather than being one of them.

---

## Two ways to assemble it

**Path A — Ship-fast (recommended to start).** Borrow the managed/OSS-hosted substrate, build only the bus.

> Chrome DevTools MCP + Playwright MCP (agent vision/verify) · Sentry MCP + Seer (errors incl. mobile) · PostHog MCP (usage + replay + surveys, incl. mobile) · optional stagewise (web UI) / Jam (bug capture) · **Loopback bus** on top.
> Cost: $0 to start; Sentry Seer ~$40/mo when you want autofix; PostHog/Sentry paid only past the free tiers.
> You're running the full loop this week.

**Path B — Maximal control (all-OSS / self-host).** Same shape, swap the SaaS for self-hostable OSS; accept a bit more building.

> Chrome DevTools/Playwright MCP (already OSS/local) · **GlitchTip** (MIT errors, self-host) instead of Sentry — you build a thin GlitchTip→MCP bridge and lose Seer's autofix · **PostHog self-host** (hobby scale) or **Formbricks** (AGPL surveys) for usage/feedback — Formbricks needs an API→MCP bridge · **Loopback bus** on top.
> Cost: ~$0 + your infra. Trade-off: you build 1–2 small bridges and forgo turnkey autofix.

Given you weighted *ship-fast* and *control* equally, the pragmatic answer is **start on Path A, and migrate individual slices to Path B** (e.g., Sentry→GlitchTip) later if a project's data-residency or cost demands it. Because everything is behind the Loopback bus, swapping a source underneath doesn't change how your agents consume feedback.

---

## Cost picture (solo / early-stage)

- **Free indefinitely:** Chrome DevTools MCP, Playwright MCP (Apache, local) · PostHog free tier (1M events, 5k web + 2.5k mobile replays/mo, surveys) · Sentry free tier (5k errors, 1 user) · Jam free tier (incl. MCP) · GlitchTip/Formbricks self-host.
- **First dollars, only when you want them:** Sentry **Seer $40/active-contributor/mo** (autofix); PostHog/Sentry usage past free tiers; stagewise Pro $20/mo (or BYOK/local models for $0).
- **Loopback:** ~$0 to run.

Your cost floor for the *entire* loop is effectively **zero**, rising only as you opt into autofix or exceed free tiers.

---

## Risks & caveats (so the scores are honest)

- **stagewise is mid-pivot** from an MCP toolbar (that bridged Cursor/Windsurf/Copilot) to its own agentic IDE; I could **not** confirm a clean bridge to Claude Code / Codex / Gemini CLI. Treat it as an optional web-UI convenience, not a pillar.
- **Sentry Seer isn't self-hostable** and Sentry's license is source-available (FSL), not permissive OSS — a partial tension with your control priority. GlitchTip is the pure-OSS escape hatch but has no AI/MCP.
- **PostHog self-host is "officially unsupported"** at real scale in 2026 and its MCP is cloud-only — so "control" for usage data is partial unless you stay hobby-scale.
- **Codex/Gemini first-party support** is explicitly documented for DevTools MCP, Playwright MCP, PostHog, and Jam; for **Sentry** it's Claude-first with generic-MCP for the others. All work via MCP, but first-party polish varies.
- **Onlook / BrowserTools:** Onlook has no MCP and isn't production-hardened for this job; BrowserTools is officially dead. Both excluded from the recommendation.

Confidence: high on licenses, transports, mobile coverage, and free-tier facts (each cross-checked with sources); medium on exact paid pricing and on stagewise's post-pivot agent bridges (flagged above).

---

## What I'd do

1. **This week:** wire Chrome DevTools MCP + Playwright MCP + PostHog MCP + Sentry MCP into one project across Claude Code (they're all `npx`/one-line installs). You'll immediately feel the loop close on your web + mobile app.
2. **Next:** build **Loopback Phase-0** (stdio + HTTP MCP, SQLite, `list/get/claim/update/link`) and point all three agents at it. Now every signal above lands in one queue that any agent can action and write back to.
3. **Later, per project:** swap in Path-B OSS (GlitchTip, PostHog self-host, Formbricks) wherever control/cost demands — transparently, because the bus hides the source.

Net: you **borrow every hard capability for ~$0** and **build one small, fully-owned bus** that unifies them across all your stacks and all three agents. That's the combination none of the existing products give you — and the only one that honors all four of your priorities at once.
