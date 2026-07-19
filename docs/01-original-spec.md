# Loopback — The Interactive Feedback Layer for Your Coding Agents

*Architecture spec / build blueprint. "Loopback" is a working name (a nod to the feedback loop). Swap it for whatever you like.*

---

## 1. The problem you're actually describing

You run projects across Claude Code, Cowork, Codex, and Gemini. Each agent can write and refactor code, but the loop back from **real usage** is missing. When you notice something — a clumsy UI, a slow endpoint, a confusing flow, a bug a user hit — there's no clean channel that carries that observation, with its context, back to whichever agent is working that repo. Today you re-describe it by hand, screenshot by screenshot, prompt by prompt.

The missing layer is a **feedback bus**: one inbox for feedback across all your projects, where every item arrives with enough context (screenshot, route, console/network, repro, severity) that an agent can pick it up, fix the code, and write the outcome back — without you playing courier.

The key realization: **you don't need to build the hard parts.** Browser-vision, session replay, and error capture are solved and already speak MCP. You only need to build the thin bus that unifies them and exposes one agent-facing interface.

---

## 2. Design principles

1. **MCP-first = agent-agnostic.** Claude Code, Codex, and Gemini CLI all speak the Model Context Protocol. Build the bus as one MCP server and every agent can read and write it. Write once, use everywhere — this is exactly the "connects to all the projects" property you want.
2. **Buy the substrate, build the bus.** Adopt best-in-class capture (below). Build only the aggregation + agent interface + write-back.
3. **Project-tagged by default.** Every feedback item is bound to a repo/project so the right agent gets the right work.
4. **Human + machine feedback, unified.** A note you type, a click you make on the live UI, a Sentry error, and a PostHog replay all land in the same schema.
5. **Close the loop, don't just open it.** The agent writes status and the fix (commit/PR) back onto the item, and verification is part of the loop — not a separate ritual.
6. **Local-first, self-hostable.** Start as a local SQLite-backed MCP server. No SaaS lock-in; graduate to a shared service only if/when you collaborate.

---

## 3. What to adopt vs. what to build

| Layer | Feedback type | Adopt (don't build) | Build |
|---|---|---|---|
| Live UI → code | UI / design | **stagewise** (open source; click live element, bridges to agents) | — |
| Browser runtime the agent can see | UX / whole app | **Chrome DevTools MCP** (official) or Playwright MCP | — |
| Production errors → fix | Backend | **Sentry MCP + Seer/Autofix** | — |
| Real usage, replays, surveys | Usage | **PostHog MCP** (analytics + session replay + surveys) | — |
| **The unifying inbox + agent interface** | all four | — | **Loopback (this spec)** |

The bottom row is the only thing that doesn't exist off-the-shelf. That's your build.

---

## 4. Architecture overview

```
   CAPTURE                     THE BUS                    AGENTS
 ┌───────────────┐        ┌──────────────────┐      ┌────────────────┐
 │ In-app widget │──┐     │  Loopback store  │      │  Claude Code   │
 │ (real usage)  │  │     │  (SQLite/Postgres)│◄────►│  Codex         │
 ├───────────────┤  │     │                  │ MCP  │  Gemini        │
 │ stagewise     │──┼────►│  normalize +     │      └────────────────┘
 │ (dev UI click)│  │     │  tag by project  │              │
 ├───────────────┤  │     │                  │       fix + write-back
 │ Sentry MCP    │──┤     │  Loopback MCP    │◄─────────────┘
 │ PostHog MCP   │──┘     │  server (tools)  │
 └───────────────┘        └──────────────────┘
                                   ▲
                          ┌────────┴────────┐
                          │  Web dashboard  │  (optional, read/triage)
                          └─────────────────┘
```

**Components**

- **Capture surfaces.** (a) A tiny embeddable widget for feedback on real/live usage — a floating button that grabs a screenshot, the current route, DOM selector, and recent console/network, plus your typed note. (b) **stagewise** for dev-time "click the element, describe the change." (c) Auto-ingestors that poll **Sentry** and **PostHog** MCPs and drop qualifying errors/replays/survey responses into the bus.
- **The store.** A small service that normalizes everything into one schema (§6) and tags each item with a project. Start with SQLite; a single file, zero ops.
- **The Loopback MCP server.** The agent-facing interface (§5). This is what makes it agent-agnostic.
- **Agents.** Connect each agent to the Loopback MCP server. They list open feedback for their repo, claim an item, fix it, and write status + the diff/PR back.
- **Optional dashboard.** A read/triage web view. Nice-to-have; the MCP + your editor already cover the core loop.

---

## 5. The MCP contract (the heart of it)

Expose these tools from the Loopback MCP server. Any agent can call them.

```
list_feedback(project?, status?, type?, severity?, limit=20)
    → [{ id, project, type, severity, title, status, route, created_at }]

get_feedback(id)
    → full item: body, screenshot_url, dom_selector, console[], network[],
      repro_steps[], route, reporter, replay_url, links{}, comments[]

claim_feedback(id, agent)         # atomic; prevents two agents grabbing the same item
    → { id, status: "in_progress", assignee_agent }

update_status(id, status, note?)  # open | triaged | in_progress | fixed | verified | wontfix
    → { id, status }

add_comment(id, author, body)     # threaded discussion / agent reasoning trail
    → { id, comment_id }

link_change(id, { repo, branch, commit?, pr_url?, diff_summary })
    → { id, links }                # attach the fix so the loop is auditable

resolve_feedback(id, resolution)  # closes the item with a short outcome
    → { id, status: "verified" | "wontfix" }
```

**Resources** (for agents that prefer read-only context pulls):

```
feedback://{project}/open          # the open queue for a repo
feedback://{project}/{id}          # a single item, fully hydrated
```

A typical agent turn: `list_feedback(project="appbroda", status="open")` → `claim_feedback(id, "claude-code")` → read `get_feedback(id)` → make the change → `link_change(...)` → `update_status(id, "fixed")`.

---

## 6. Data model (one schema for everything)

```json
{
  "id": "fb_01H...",
  "project": "appbroda-web",
  "created_at": "2026-07-19T10:20:00Z",
  "source": "widget | stagewise | sentry | posthog | manual",
  "reporter": "human | system",
  "type": "ui | backend | usage | ux",
  "severity": "p0 | p1 | p2 | p3",
  "title": "Checkout button dead on mobile Safari",
  "body": "Tapping 'Pay' does nothing; no spinner, no error toast.",
  "route": "/checkout",
  "url": "https://app.example.com/checkout",
  "dom_selector": "button[data-testid='pay']",
  "screenshot_url": "loopback://blobs/fb_01H.png",
  "console": ["TypeError: undefined is not a function at pay.ts:42"],
  "network": [{ "url": "/api/pay", "status": 500, "ms": 2100 }],
  "repro_steps": ["Open /checkout on iOS Safari", "Tap Pay"],
  "replay_url": "https://posthog.com/replay/abc",
  "status": "open",
  "assignee_agent": null,
  "links": { "commit": null, "pr_url": null },
  "comments": []
}
```

The four `type` values map 1:1 to the four feedback dimensions you named — UI, backend, usage, UX — so you can slice the queue by exactly the axis you care about.

---

## 7. The loop, end to end

1. **Capture.** You (or a real user) hit the widget, or you click an element via stagewise; or Sentry/PostHog auto-drops an item. Context is attached automatically.
2. **Normalize + tag.** The bus writes one schema-conformant item, bound to the project.
3. **Pull.** In the repo, you tell the agent "work the open Loopback queue." It calls `list_feedback` + `claim_feedback`.
4. **Fix.** The agent reads full context and edits code. If it needs to *see* the running app to verify, it uses **Chrome DevTools MCP** in the same session.
5. **Write back.** `link_change` (commit/PR) + `update_status("fixed")`.
6. **Verify.** Re-check against the running app (DevTools MCP) or confirm the metric/replay moved (PostHog MCP), then `resolve_feedback`.
7. Repeat. The queue is your single source of "what needs refining," across every project.

---

## 8. Build plan (phased, shippable)

**Phase 0 — MVP (a weekend).** Loopback MCP server (TypeScript, `@modelcontextprotocol/sdk` or FastMCP) + SQLite store + `list/get/claim/update/link` tools. Manual capture only (a `manual` source you POST to, or a CLI `loopback add`). Wire it into Claude Code via `.mcp.json`. You can already run the loop on one project.

**Phase 1 — Capture widget.** A ~5KB embeddable snippet: floating button → screenshot (html2canvas) + route + last N console/network entries + your note → POST to the bus. Now non-dev and live-usage feedback flows in.

**Phase 2 — Multi-project + auto-ingest.** Project registry; poll Sentry MCP and PostHog MCP on a schedule (a scheduled task) and drop qualifying items into the queue with `source: sentry|posthog`.

**Phase 3 — Write-back verification + dashboard.** Add the verify step (DevTools/PostHog checks) and a small read/triage web view. Optionally fold in stagewise as the dev-time capture surface so its clicks land as Loopback items too.

Ship Phase 0 first and use it — it'll tell you what Phases 1–3 actually need.

---

## 9. Tech choices (suggested defaults)

- **MCP server:** TypeScript + `@modelcontextprotocol/sdk` (or Python + FastMCP if you prefer). Runs locally over stdio for editor agents; add an HTTP/SSE transport when you want remote/multi-machine.
- **Store:** SQLite (one file) for Phase 0–2; Postgres if it ever goes multi-user.
- **Blobs (screenshots):** local dir addressed by `loopback://` for MVP; S3/R2 later.
- **Widget:** vanilla JS + html2canvas, framework-agnostic so it drops into any project.
- **Config:** one `.mcp.json` entry per repo pointing every agent at the same server.

---

## 10. Decisions I need from you

1. **Hosting:** local-only (fastest, private) vs. a small always-on service (needed if you want auto-ingest and a shared dashboard). My default: local for Phase 0, service at Phase 2.
2. **Language:** TypeScript or Python for the MCP server? (Default: TypeScript.)
3. **Standalone vs. absorb stagewise:** build the capture widget from scratch, or adopt stagewise as the dev-capture front end and only build the bus behind it? (Default: build the tiny widget; evaluate stagewise in parallel.)
4. **First project:** which repo do we wire up as the Phase-0 guinea pig?

---

*Next: I can scaffold the Phase-0 MCP server as runnable code, or turn §5–§6 into a formal MCP tool schema you can drop straight into an implementation.*
