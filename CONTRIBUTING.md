# Contributing

One rule governs everything below: **a gate that cannot fail is decorative.**
Twenty audit passes on this repo found the same defect nine separate times — a
check reporting green on something it could not see. So a passing suite is not
evidence here. Evidence is a check that has been *shown* to fail when the thing
it guards breaks.

Loopback is solo-maintained and pre-1.0. Issues and PRs are welcome; expect a
human on their own schedule, not a rota.

## Prerequisites

Node **≥ 22.13** (`package.json` → `engines`). The store is built-in
`node:sqlite`, so there is nothing native to compile and no toolchain to
install.

```bash
npm ci
npm ci --prefix dashboard   # dashboard/ is its own package with its own lockfile
npm run build
```

That is exactly what CI installs (`.github/workflows/ci.yml`). The dashboard
install matters even if you never touch React: `dashboard-gate` rebuilds
`dashboard/src` and compares it against the committed output in
`public/dashboard/`, and it cannot do that without those dependencies.

## The gate suite

`ci.yml` runs all of these on every pull request and every push to `main`. The
commands below are the ones CI actually invokes; each also has an
`npm run <name>` alias in `package.json`.

| Command | What it guards |
|---|---|
| `npm run build` | `tsc` |
| `npm run smoke` | a real MCP client over stdio — every tool, the full loop, the atomic-claim conflict, and the coupled registry-identity fields (`mcpName` = `server.json` name, the 100-char description cap) |
| `node scripts/init-gate.mjs` | `init` renders for all three agents, byte-idempotently, without clobbering a file a human has taken over |
| `node scripts/registry-gate.mjs` | the published shadcn registry still resolves and installs, and its theme still matches `design/tokens.css` |
| `node scripts/dashboard-gate.mjs` | the committed dashboard build has not drifted from `dashboard/src` |
| `node scripts/widget-token-gate.mjs` | the widget's *inlined* token copy still equals `design/tokens.css` — it ships as one file and cannot `@import` them, so it is the one surface that can drift silently |
| `node scripts/impeccable-gate.mjs` | design anti-patterns in the shipped UI |
| `node scripts/docs-facts-gate.mjs` | the numbers the docs assert, re-measured against the code |
| `node scripts/e2e.mjs` | Playwright: pin capture → 500-body and run-context assertions → an agent over MCP-HTTP → green pins; also the LAN auth split in both directions and the ingest rate limit |
| `node scripts/a11y-gate.mjs` | contrast, target size, accessible names, landmarks and motion, measured in a real browser |

Two more run in their own workflows, because they are slow or externally paced:

| Command | What it guards | When |
|---|---|---|
| `node scripts/link-gate.mjs` | every link in `README.md`, `docs/` and `integrations/` resolves — **and that the crawl was not empty**, which is how its predecessor stayed green for weeks while scanning zero links | `readme-checks.yml`: on changes to those paths, and weekly |
| `npm run canary` | that every gate above fails when its subject breaks | `canary.yml`: on changes to what it mutates, weekly, and on demand |

## A gate that cannot fail is decorative

`scripts/canary-all.mjs` makes that claim executable instead of asserting it in
a checklist. For each gate it applies **one surgical mutation** to the thing
that gate protects, runs the gate, and requires a non-zero exit. A gate that
still passes with its subject broken is reported as decorative and the sweep
fails.

The sweep is built to resist passing for the wrong reason, the same way the
gates are:

- every mutation is reverted in a `finally`, including on SIGINT, so a run
  cannot leave the tree dirty;
- a "mutation" that changed nothing is itself a failure — that is how a moved
  anchor gets caught instead of quietly recording a false pass;
- a mutation that breaks `tsc` is a failure too, because then the gate would
  fail for the wrong reason and prove nothing;
- fail-closed gates carry the complement (`expect: 0`), asserting the gate
  still passes on a healthy subject — a gate that refuses everything would
  otherwise sail through its own canary.

Two consequences for a pull request:

**A new gate needs a canary case** in `scripts/canary-all.mjs`: the gate's
command, one mutation to what it guards, and the build it needs. Without one,
the gate is an unverified claim.

**A new number in the docs needs a check** in `scripts/docs-facts-gate.mjs`.
Every figure that had drifted in this repo was hand-typed and read by no gate:
the widget's size was quoted four different ways across four files, and "10
tools" sat above a nine-row table for two releases. That gate re-measures the
widget's size, the tool count, the HTTP routes and the registry items. It
deliberately checks nothing with more than one correct answer, so prose stays
out — and it reads `README.md`, `docs/ROADMAP.md` and `design/README.md`, so put
a measurable claim where a gate can see it.

## Publishing

`scripts/release-preflight.mjs` is wired as `prepublishOnly`, so `npm publish`
enforces it rather than trusting anyone to remember. It refuses a dirty tree
(the tarball would not be the commit CI tested), a commit that is on no remote
branch (nothing has tested it), a run still in flight, and any `ci.yml`
conclusion that is not `success`.

It **fails closed**: no `gh`, no auth, or no network is a refusal, not a pass —
an unknown CI result is exactly the state that let 0.9.0, 0.9.1 and 0.9.2 all
ship on top of a red `main`. The override is explicit and auditable —
`LOOPBACK_ALLOW_RED_CI=1` — and it prints a warning telling you to say so in the
release notes.

## Where things live

The repo map is in the [README](README.md#repo-map); it is not repeated here so
it cannot drift.

## Canonical sources — edit these, never the renderings

`init` renders one playbook into every agent's native mechanism, so a number of
files in this tree are generated. Editing a rendering gets reverted by the next
`init` run, and `init-gate` fails in CI before that.

[`integrations/instructions-src.md`](integrations/instructions-src.md) is the
one source of truth for how an agent works the queue; its own header carries the
rendering table. `init` reads the block between the `playbook:begin` /
`playbook:end` markers and substitutes `{{PROJECT}}` with the repo's slug. It
renders into:

- `AGENTS.md` § "Working the Loopback queue" — canonical for Codex and Gemini
  CLI, which read it natively; Claude Code reaches it through the `@AGENTS.md`
  import in `CLAUDE.md`
- `.claude/skills/loopback/SKILL.md` (Claude Code, also installed by the plugin)
- `.agents/skills/loopback/SKILL.md` (Codex)
- `.gemini/commands/loopback.toml` (Gemini CLI's `/loopback`)

[`skills/loopback/SKILL.md`](skills/loopback/SKILL.md) is the canonical skill
every adopter gets. It mirrors the playbook text and must be updated with it;
`plugin/skills/loopback/SKILL.md` is the plugin's own copy, and `init-gate`
asserts both match.

Because this repo onboards *itself*, its root `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md` and agent dot-directories are those renderings — working proof the
command produces what it claims. `init-gate` re-renders them on every CI run and
fails on any drift.

## Filing what you find

Loopback is its own reference integration. With the hub running, the widget is
embedded on `/queue` under `data-project=loopback`, and every defect in this
repo's history was filed and closed through its own queue — see [Giving feedback
*about* Loopback](README.md#giving-feedback-about-loopback). GitHub issues are
for anything a stranger should see. Anything exploitable goes to
[SECURITY.md](SECURITY.md) instead.
