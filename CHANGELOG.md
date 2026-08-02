# Changelog

All notable changes to Loopback are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

## [0.9.3] — accuracy pass: a red CI nobody was watching, and docs nothing checked

### Fixed — CI had been red for six days, and three releases shipped on top of it
`ci.yml` failed on **sixteen consecutive runs**, from 2026-07-27 (`f7dfa27`)
through 2026-08-02. Last green was `623aa05`. 0.9.0, 0.9.1 and 0.9.2 were all
published inside that window, so all three shipped two real WCAG 1.4.4/1.4.10
failures as product defects, not just a red badge.

The a11y gate had **never passed on CI at all**: it was added in `d2ca476` and
pushed in a batch with 27 other commits, so its first run was already red.

The bug was real and one line. `Updated` rendered `item.updated_at` as a bare
ISO timestamp with no `break-all`, while every other value in that card
(project, source/reporter, assignee, route) had one. An ISO string is a single
24-char token with no break opportunity, so at 200% text zoom it set a 236px
min-content floor that the section's `min-w-0` could not shrink. On macOS that
lands at 301px and passes a 320px viewport; on CI's Linux font metrics it
measures ~325px — exactly the `{"s":325,"c":320}` in every failing run, and why
it never reproduced locally. Now clears 320px with 40px of headroom.

### Added — `release-preflight`: publishing requires a green, pushed, tagged commit
The gates verify the source. `verify:release` deliberately runs *after* a
publish, against published artifacts, where npm's immutability means it can only
report damage. Nothing ever asked the question in between, which is how a red
`main` stayed publishable three times.

`release-preflight` runs as `prepublishOnly`: clean tree, commit pushed, a
completed successful `ci.yml` run for that exact sha, and a `v<version>` tag
pointing at it. It **fails closed** — an unreachable GitHub is a refusal, not a
pass, since "unknown" is the state that let the last three releases through.
`LOOPBACK_ALLOW_RED_CI=1` is the explicit, auditable override.

Two traps found by running it rather than reading it: the GitHub API matches
`head_sha` on the full 40-char sha only, so an abbreviated sha returns an empty
run list — indistinguishable from "never tested"; and a fail-closed gate sails
through a canary that only checks for a non-zero exit, so the sweep asserts
**both** directions against two immutable commits (`10a1c6d` red must fail,
`623aa05` green must pass).

Tags `v0.9.0`, `v0.9.1` and `v0.9.2` were created retroactively. Tag discipline
had stopped exactly when public publishing began: everything from v0.3.0 to
v0.8.0 is tagged, and the only three versions that ever reached npm were not.

### Added — `docs-facts-gate`: the numbers in the docs are re-derived from the code
Every structural gate was green while the docs drifted, because none of them
ever read a *claim*. Everything that had rotted was a hand-typed figure:

- the widget was quoted **four** ways — 46KB/15KB, 57KB/19KB, 57,183 B, ~29KB —
  against a real 59,443 B, and two separate commits each claimed to have
  "corrected the widget size" while fixing one occurrence out of two;
- "The MCP bus — 10 tools" sat above a 9-row table, missing
  `loopback_update_feedback`, which the 0.8.0 entry below announced;
- the HTTP surface table omitted all three attachment endpoints;
- the shadcn section documented two registry items and shipped three;
- the repo map claimed `init` writes `.claude-plugin/` (it does not) and that
  `init-gate` re-renders it (it asserts a version), and omitted `.github/` and
  `.impeccable/`.

Measuring it exposed a smaller error inside the bigger one: "19,751 B gzipped on
the wire" was measured with the `gzip(1)` CLI, but the server serves `gzipSync`
at zlib's default level — 19,770 B. Three plausible numbers for one file, so the
gate measures it the way `src/http.ts` actually produces it.

### Fixed — the README's shadcn section was mangled, on GitHub and on npm
A sentence cut off mid-clause, a contradictory replacement pasted over it, and
an orphan `free).` fragment. Live on `main` and in the published 0.9.2 readme,
which is why this needed a release rather than a docs commit.

### Fixed — `link-gate`: the link check had never checked a link
The CI step had been green since the day it was added while scanning **zero**
links, for two independent reasons: `linkinator README.md docs integrations`
silently ignores every path after the first, and `--skip "127.0.0.1|…"` matched
the root linkinator serves the files from, so the crawl never started. That one
pattern took the scan from 24 links to 0, and "Successfully scanned 0 links"
exits 0. The gate now asserts a **minimum link count per target**, because the
failure was never a broken link — it was an empty crawl.

### Added — `init-gate` covers the seam between the two canonical sources
Every parity check ran from one canonical source down to its renderings.
Nothing compared the two canonical sources to *each other*, and
`integrations/instructions-src.md` says outright that the skill body "mirrors
this text and must be updated with it" — a manual sync, and the last drift class
with no check. They are deliberately not byte-identical, so the invariant is the
loop: both must drive the same tools in the same order.

### Fixed — smaller corrections
- `docs/05-surface-compatibility.md` stated three different LAN-auth realities
  in one document; the bearer token shipped, so the "next security milestone"
  text is gone.
- `docs/ROADMAP.md` was stale on its own date, the npm version and the canary
  count, and claimed "Open: **Nothing**" while CI was red.
- CHANGELOG dated 0.9.1 to the version-bump commit (2026-07-27) rather than its
  actual npm publish (2026-08-01) and registry listing (2026-08-02).
- `integrations/claude.md` labelled an npm install "zero-install from GitHub".
- `server.json` had `websiteUrl: null`, so the registry entry carried no link.
- README overstated capture: buffers hold 30 console lines and 30 network calls,
  but a filed report carries the most recent **15 of each**.
- `dashboard/tsconfig.tsbuildinfo`, tsc's incremental cache, was tracked.
- Added `CONTRIBUTING.md`, `SECURITY.md` and issue/PR templates — community
  health was 42%.

### Fixed — the hub exited 0 on a taken port
A second `--http --port <taken>` printed its success banner and exited **0**,
having served nothing: express's listen callback fires even when the bind failed
(with `address() === null`), and an unhandled `error` on the underlying server
is not a throw. For a tool people habitually start in a second terminal, silence
is the worst possible outcome. Now exits 1, names the port, suggests the next
free one and `lsof`, and suppresses the banner it was about to contradict.
Found in passing by an agent designing an unrelated check.

### Added — release verification covers what it always claimed to
`npm run verify:release` went from 24 checks to **63**, closing the audit
remainder:

- **The hub actually starts.** The section has been titled "npm → init → hub →
  MCP" since it was written and never made an HTTP request. It now serves
  `/widget.js`, `/queue`, the hashed dashboard assets (read out of the served
  shell, so they cannot go stale), and `POST /ingest`, asserting on CONTENT —
  a stub `widget.js` answers 200 with perfectly valid empty JavaScript, so only
  content can catch a `files`-whitelist miss. Canaried by stubbing the widget
  inside the installed tree: `200, 7 B`, exactly one check red.
- **The plugin channel is fetched from GitHub**, the ref adopters actually
  clone — previously the only channel read from the developer's own tree.
- **The registry listing is launched, not just compared.** `Package.transport`
  is `anyOf(stdio|streamable-http|sse)`, so a wrong transport is schema-VALID
  and `mcp-publisher validate` cannot reject it.
- **The documented npx onboarding path** is exercised against the published
  package, not just the local-bin variant.
- **All nine files `init` writes** are checked, not the five the loop carried
  under a comment claiming it covered every one.
- **Diagnostics:** the child's stderr is captured and the line that *names* the
  failure is preferred over a blind tail (which was returning `code: '` from a
  serialised Error). The cold handshake is guarded, so a dead install is one red
  check instead of a lost run that skipped two whole channels.

Two of these were caught being decorative by their own canaries before landing —
a port-collision mutation that fell through to a branch whose message still
matched, and a collision probe pointed at a `0.0.0.0` hub from a `127.0.0.1`
client, which never collided at all.

The canary sweep ends this release at **28** checks (20 before the gates above),
and every gate added here is canaried in both directions where it can refuse.

## [0.9.2] — 2026-08-02

Ships the `init` fix below to adopters. 0.9.1 still writes a git-clone MCP
config, so source being correct changed nothing until this release.

### Added — `npm run bump <version>`
A release moves SIX hand-typed fields across five files (package.json,
`SERVER_VERSION`, server.json's version *and* every `packages[].version`, the
plugin manifest, and the marketplace entry). The gates enforce that they agree,
so a partial bump fails CI — but a *forgotten* bump fails later and worse:
`npm publish` refuses with "cannot publish over the previously published
versions" after the notes are written and the commit is pushed. That happened
on this release. The command edits only; build, gates and publish stay manual.

### Fixed — `init` handed every adopter a git-clone MCP config
`serverCommand()` emitted `npx -y github:joshidikshant/loopback` on any
EPHEMERAL run — which is precisely how the README documents onboarding
(`npx loopback-mcp-server init`). Every adopter following it got `.mcp.json`,
`.codex/config.toml` and `.gemini/settings.json` pointing at a **git clone that
runs a full `tsc` build on every cold MCP start**. That was the right call when
nothing was published; it became wrong the moment `loopback-mcp-server` shipped
to npm, and it survived because no gate could reach the branch. Now
`npx -y loopback-mcp-server`, unpinned so adopters get fixes without re-running
init. The four docs handing out the same stale command are corrected too.

Found by an adversarial audit that *reproduced* it rather than arguing it, and
gated twice over:

- `init-gate` runs the CLI from an `_npx`-shaped fixture — the only path that
  reaches the branch. A first version invoked the normal `dist/index.js` and
  **passed with the git spec restored**; the canary caught it.
- Its guard-the-guard then had the same disease: it searched raw text for
  `"npx"` while the temp dir was named `loopback-npx-…`, so an absolute path in
  a `node <path>` command satisfied it. Now asserts the parsed `command` field.

### Added — `npm run verify:release`
Post-publish verification of all three channels, by using them: installs the
published tarball into a clean directory, renders `init` from it, **runs the
MCP command init actually wrote** (not a path the script composes — the audit
reproduced a false green there too), confirms the MCP Registry listing resolves
to the shipped version, and runs the plugin's registered command from an empty
directory. Tools are checked by NAME, not count, so a rename cannot hide.

Deliberately not a per-push gate: it needs the network and tests published
artifacts, so on a PR it would pass while the branch is broken. Sweep is 19.

### Fixed — the plugin channel was two releases stale
A structural review found the Claude Code plugin shipping a **fourth** copy of
the skill playbook that nothing rendered, so it silently kept the
pre-attachments version while the other three were fixed. Alongside it, two
version fields still read `0.8.0` after two published releases, and the plugin
told Claude Code to install via `npx github:joshidikshant/loopback` — a git
clone that runs a full `tsc` build on every cold start — when the package is on
npm.

- `plugin/skills/loopback/SKILL.md` synced from the canonical template.
- `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
  now track `package.json`.
- `plugin/.mcp.json` installs `loopback-mcp-server` from npm.
- `init-gate` gained five assertions covering all of it, canaried three ways;
  the sweep is 18 checks. The npm release touches none of these files, which is
  exactly why they rotted.

### Removed
`fv-probe.mjs` — a one-off Playwright scratch file from pass 6, referenced by
nothing.

### Changed — the repo map documents the whole tree
The six root dot-directories are `init` output (the repo onboards itself, and
`init-gate` re-renders them each CI run), but nothing said so, which read as
clutter. The map now covers them, `public/`, `assets/`, and the two root
manifests that do different jobs — `registry.json` for shadcn, `server.json`
for the MCP Registry. Also corrected the widget size, still quoted as
46KB/15KB against a measured 57KB/19KB.

## [0.9.1] — 2026-08-01 — published to npm; listed on the MCP Registry 2026-08-02

### Added — MCP Registry identity (`mcpName` + `server.json`)
The official MCP Registry proves package ownership by fetching the **published**
npm version metadata and requiring its `mcpName` to equal `server.json`'s
`name`. 0.9.0 shipped without the field, and npm versions are immutable — so
this is a new version rather than a fix. Registry submission (and everything
that ingests from it downstream) was blocked on it.

- `package.json` declares `"mcpName": "io.github.joshidikshant/loopback"`.
  GitHub-based authentication requires the `io.github.<username>/` prefix.
- `server.json` is the registry manifest (schema `2025-12-11`), kept in the
  repo and deliberately **out** of the npm tarball — the registry reads it from
  the source, the package only needs to carry `mcpName`.

### Added — gated, because the registry hard-fails on drift
Publication now depends on four hand-typed version fields and two name fields
agreeing (`package.json` version + `mcpName`, `SERVER_VERSION`, `server.json`
version + `packages[].version` + `packages[].identifier`). A mismatch is not a
retry — an immutable version number is spent. The smoke test asserts all of it,
including that the name matches the GitHub-auth pattern, and three drifts are
canaried: a foreign `mcpName`, a stale package version, and a wrong npm
identifier. The sweep is 16 checks.

## [0.9.0] — 2026-07-27 — published to npm

First published release (`npm i loopback-mcp-server`). The tarball is proven,
not assumed: CI-adjacent checks install the packed artifact into a clean
directory and run `init`, the hub, the dashboard, the widget and the intake
from it — which is how a missing `integrations/` and a stale canonical skill
template were caught before anyone else could.

### Added — the intake has a backstop
On a token-protected (non-loopback) bind, `POST /ingest` rate-limits at 60
reports/minute per IP with a 429. Loopback binds are untouched — the OS
already decides who can reach the port.

### Added — the repo eats its own init output
`init-gate` now renders `init` for this repo's own slug and requires the
result to match the repo's installed `.claude/skills/loopback/SKILL.md` and
`AGENTS.md` queue block byte for byte. The canonical template had drifted from
the installed copy for a full session — adopters would have onboarded with a
playbook missing the attachments contract — and 25 assertions stayed green,
because none compared the two.

### Changed — the canary sweep moved to its own workflow
15 mutation checks re-running e2e/a11y (~10 min) verify the gates, and gates
change rarely: the sweep now triggers on changes to what it mutates or
asserts, weekly as a drift backstop, and on demand — not on every push.

### The audit arc (passes 1–21, for the record)
11/20 → 20/20 across 21 Impeccable audit passes. The dominant defect the
whole way was never broken UI — it was verification reporting green on
something it could not see, nine separate gates' worth (a detector that exits
0 scanning nothing; a theme check that could not tell `:root` from `.dark`; a
contrast dedupe keyed on transparent backgrounds; a reduced-motion probe
measuring its own injected stylesheet; an unguarded `@theme` hop…). Each was
fixed, then mutation-tested in both directions, and the discipline was made
executable as `npm run canary` — which caught a real regression on its first
run.

### Added — the widget captures how, not just what (widget v0.10.0)
- **Repro steps.** A labelled "one per line" textarea in the capture form;
  leading `1.` / `2)` numbering is stripped because every downstream renderer
  numbers the list itself. The field existed in the store, MCP and dashboard
  from day one and was captured nowhere.
- **Route journey.** The widget records the routes visited before the report
  (routes only — a trail, not surveillance; capped at 15) and attaches them as
  `extra.journey`. `loopback_get_feedback` renders it as `## Route journey` so
  agents see the path, not just the crash site. Back/forward navigation now
  flows through the same debounced guard as pin refresh — popstate previously
  bypassed both.
- **The onboarding tip retires.** It sits `position:fixed` over host content,
  so it is now first-run only: a filed report, or an Escape aimed at the
  visible tip, retires it permanently (per host origin). Session dismissal and
  SC 1.4.13 behaviour are unchanged.

### Added — a token for non-loopback binds
`--host 0.0.0.0` used to put every queue and every mutation on the LAN behind
a startup warning. A non-loopback bind now generates a bearer token (or takes
`LOOPBACK_TOKEN`), printed as a `?token=` URL that is swapped into an HttpOnly
cookie on first use and stripped from the URL. `POST /ingest`, `/widget.js`
and the pins projection stay open by design — the widget has nowhere to keep a
secret; everything else, `/mcp` included, refuses with 401. Loopback binds are
unchanged and need no token.

### Added — the verification is itself verified
`npm run canary` (in CI) applies one surgical mutation per gate to the thing
that gate protects and requires the gate to FAIL — 13 checks. Nine separate
times across twenty audit passes, a gate had reported green on something it
could not see; this makes that class of defect a CI failure instead of an
audit finding. It caught one real regression on its first run.

### Fixed — status badges had a real contrast bug in both themes
`design/tokens.css` has always shipped a paired `--lb-*-foreground` for every
status, and inverts the pairing between themes: light mode puts white text on a
dark status colour, dark mode puts near-black on a bright one. The dashboard
ignored all six and hardcoded `text-black/85` / `text-white`, which cannot
follow that inversion — so `open` was near-black on dark orange in light mode,
and `in_progress` was white on bright blue in dark mode. The tokens were never
mapped into `@theme`, so the correct utility did not exist. Both fixed;
`statusClass` now names the paired token.

### Changed — shadcn/ui adoption pass
Audited every hand-rolled control against what shadcn already ships. Adopted
`alert`, `alert-dialog`, `attachment`, `empty`, `label`, `skeleton` and
`tooltip` — **zero new npm dependencies**, since `radix-ui` and
`class-variance-authority` were already present.

- **Detaching an attachment now asks first.** It deletes the blob irreversibly
  and previously fired on a single click of a button with no accessible name.
- **The queue is keyboard-navigable.** Opening an item was a `TableRow`
  `onClick` and nothing else, so it could not be reached without a pointer. The
  id is now a real focusable control.
- **The status "why" note is collected before the control that consumes it.**
  Reading order was the bug: the note sat *below* the Select, so a top-to-bottom
  user committed with an empty note — and `store.updateStatus` only writes a
  trail entry `if (note)`, so those changes landed with no trail at all.
- Nine form controls gained programmatic names (`Label htmlFor` or `aria-label`);
  the app previously had exactly one `aria-label` in total.
- Errors are `Alert` (`role="alert"`) instead of bare paragraphs; loading is
  `Skeleton` instead of the string "Loading…"; the empty state distinguishes
  "no items" from "filters exclude everything".
- Every write shares one in-flight guard, so a slow hub can no longer produce a
  duplicate comment or a double status write.
- Attachment rows use shadcn's purpose-built `Attachment`; the intent pill no
  longer borrows the green "verified" *status* colour to mean "asset".
- The list asked for 500 and then reported 500 as the true total. It now asks
  for the server maximum and says "first N" when it hits the cap. Deliberately
  **not** pagination — the queue has 22 items.
- Removed dead code: `dialog`, `field` and `separator` were installed and never
  imported (−6KB CSS). Synced `select` and `sonner` to upstream, which had
  dropped the `"use client"` directive that a Vite app never needed.

### Added — Impeccable now scans source, and the destructive path has a test
- `scripts/impeccable-gate.mjs` gained `dashboard/src`. Impeccable regex-analyses
  `.tsx` (verified with a probe), so a `border-l-2` in source was previously only
  caught after a rebuild, attributed to a hashed asset nobody can act on.
- e2e now drives the attachment UI and the new confirm dialog for real —
  renders, cancel leaves it in place, confirm detaches. Both assertions were
  verified to fail when deliberately broken. The prior attachment coverage was
  pure HTTP and never looked at the page.

### Added
- **Impeccable design gate** (`scripts/impeccable-gate.mjs`, wired into CI) —
  runs [Impeccable](https://github.com/pbakaus/impeccable)'s 46-rule detector
  over the shipped UI (`public/dashboard`, `widget/`, `demo/`, `design/`) and
  fails the build on any anti-pattern.
  - It is a script rather than a one-line CI step because **a bare
    `impeccable detect` exits 0 having scanned nothing** — a wrong path or a
    moved directory reports success. The gate existence-checks every target and
    scans a **canary fixture** (`scripts/impeccable/canary.html`) that is
    *required* to trip; if the canary comes back clean the detector is not
    looking, and the gate fails instead of reporting green. Both failure paths
    are verified, not assumed.
  - The detector is a **version-pinned devDependency**, so the rule set changes
    only via a visible dependency bump — CI cannot go red overnight on an
    upstream rule.

### Fixed
- **Side-tab accent border on the comment trail** (`ItemDetail.tsx`) — the
  thick coloured left border Impeccable calls the most recognisable tell of
  AI-generated UI. The trail is a log, so it is now a divided list.
- **Flat type hierarchy in `demo/index.html`** — four sizes within a 1.18 ratio
  read as no hierarchy at all; now three sizes at 12.8 / 16 / 28px.

### Notes
- One finding is suppressed with a stated reason in `.impeccable/config.json`:
  `layout-transition` in `public/dashboard/assets/*.js` is
  [sonner](https://sonner.emilkowal.ski/)'s bundled `transition: height`, not
  Loopback source. The rule stays live everywhere else.

## [0.8.0] — 2026-07-26

The dashboard becomes a real app. Driven entirely by DJ using it on localhost
and hitting three walls, each filed into Loopback's own queue first.

### Added
- **`/queue` is now a React + shadcn application** (source in `dashboard/`,
  installed with the real `shadcn` CLI — Table, Badge, Card, Dialog, Input,
  Select, Textarea, Sonner). It replaces ~300 lines of server-rendered template
  strings that were at their limit once the page needed filtering, editing and
  file upload.
  - **The build output is committed** to `public/dashboard/`, so
    `npx loopback-mcp-server` still needs no React, no Tailwind and no build
    step. The hub just serves files.
  - **One design system, not two.** Tailwind is themed from the existing
    `design/tokens.css` (copied in at build time by `sync:tokens` and mapped
    through `@theme inline`), so the widget, the published shadcn registry and
    the dashboard all render the same status colours from the same source.
  - The widget is untouched and always will be: it injects into arbitrary host
    pages, so it stays one dependency-free file.
- **Filtering that works.** Status tiles are toggles, and project / severity /
  type / assignee cells filter to themselves. Filters compose, live in the URL
  (so every view is linkable), and tile counts are computed from the unfiltered
  scope so choosing one never hides the way back. Plus client-side search over
  title, body and id. (fb_ms1oksb3)
- **Editing.** Title, body, severity, type, project and route can be corrected
  after filing, from the item view or via the new `loopback_update_feedback`
  MCP tool (now ten tools). Every change is recorded as a comment naming the
  old and new value — nothing is rewritten silently. (fb_ms1oksbi)
- **Attachments, with intent.** Files upload from the item view and land in
  `~/.loopback/blobs/<item>/`, beside the DB rather than inside it. Each
  attachment declares why it exists:
  - `reference` — context for the fix (a screenshot, a spec). Never ships.
  - `asset` — a deliverable. The blob store is a transfer buffer; the item
    carries a `target_path` and the agent copies the file into the repo there
    and commits it.
  Agents get an **absolute local path**, so they copy the file rather than
  decoding bytes out of the protocol. Upload takes no new runtime dependency:
  the file is the request body and metadata rides in the query string.
  (fb_ms1oksbz)
- **`dashboard-gate`** (in CI): asserts the committed build exists, is
  **rebuilt-and-compared fresh** against its source (timestamps lie after a
  `git checkout`), carries the shared tokens, and stays under 800KB.

### Changed
- `GET /feedback` accepts `limit` up to 1000. The MCP tool stays capped at 100 —
  that limit protects an agent's context window, which is not a constraint a
  browser table shares. Query errors now say which field was rejected instead
  of a bare "Invalid query".
- Removed ~300 lines of now-dead server-rendering helpers (`pageShell`,
  `itemSections`, `escapeHtml`, `safeHref`, `linkOrText`, `designCss`).

## [0.7.1] — 2026-07-26

MCP Inspector pass. Ran the official Inspector against the server, which
surfaced one silent-failure bug and one missing half of the tool contract.

### Fixed
- **A mistyped tool argument was silently dropped instead of rejected.** Zod
  strips unknown keys by default, so `loopback_submit_feedback(..., sevrity:
  "p0")` filed a **p2** and reported success — the agent believes it filed a
  critical item. Reproduced through the Inspector. Tool inputs are now strict
  objects: the call fails with `unrecognized_keys` and files nothing.
  `POST /ingest` deliberately stays permissive, because an older hub must not
  reject a newer widget's payload — different contract, different rule. Both
  halves are asserted.

### Added
- **`outputSchema` on all nine tools.** Previously zero were declared while
  every tool returned `structuredContent` — legal per spec, but it left clients
  unable to validate and gave agents no way to discover that `extra` carries
  `failed_responses` and `context`, the fields the playbook tells them to read.
  The schema now documents that explicitly. Verified conformance across the
  cases that break output contracts: items with every optional unset, with and
  without comments, `has_more` true and false, empty stats, resolved items, the
  25k truncation path, and error results.
- Tools now publish `additionalProperties: false`, so a client can catch a
  mistyped argument before the call is made.

### Changed
- `npm run smoke` and `npm run e2e` build first. A stale `dist/` let a gate pass
  green against code that no longer compiled — it happened while making this
  change.

## [0.7.0] — 2026-07-20

Tier A of the v0.6.0 review: the five defects that would each have broken the
first real session. Found by a 13-agent adversarial review, then reproduced by
hand before being fixed.

### Security
- **`POST /mcp` was an unauthenticated cross-origin read/write channel to every
  project.** CORS was `*` on every route, and the same-origin guard added in
  0.6.0 covered only the two HTML triage forms — leaving the endpoint that
  carries all nine tools wide open. Reproduced: a foreign origin read the whole
  queue (including a captured `Bearer` token) and silently resolved an item.
  Now: CORS is granted to `/ingest`, `/feedback` and `/widget.js` only;
  everything else requires an origin **pinned at startup from the bind config**
  rather than derived from the caller-supplied `Host` header (which DNS
  rebinding controls). `POST /ingest` stays open — that is how widgets report.
- **Cross-origin reads are now the pin projection only** (id, status, title,
  assignee, selector, PR link). `extra` — which holds captured response bodies,
  routinely containing auth headers — is never served cross-origin.
- **Stored XSS via `javascript:` URLs.** `url` and `pr_url` were interpolated
  into `href=` unvalidated, so anyone who could file an item could plant a link
  that ran script on the hub's own origin — past the CSRF guard — on one click.
  Non-http(s) URLs now render as inert text; `escapeHtml` also escapes `'`.

### Fixed
- **The widget no longer destroys what you typed.** `form.remove()` ran before
  the failure toast, with no draft persistence, so an unreachable hub (the
  default state when nothing keeps it alive) silently ate the report on Send.
  The form now stays mounted, Send re-enables, and a rejected payload reports
  which field the bus refused.
- **Pins landed offset by the host page's layout.** Absolutely-positioned pins
  resolve against the nearest positioned ancestor, so on a centred layout
  (`body{position:relative;margin:0 auto}` — most real sites) every pin drifted
  by the auto margin; measured 284px off on the demo page once it was made
  representative. Pins are now `position:fixed` in viewport coordinates.
- **The default MCP response hid the product's differentiator.** `itemMarkdown`
  dropped `extra` entirely, so `failed_responses` (the captured backend error
  body) and `extra.context` (LLM run metadata) — the two fields the agent
  playbook explicitly tells agents to read — were invisible unless an agent
  happened to ask for JSON. Both now render.
- **No SQLite busy timeout.** The architecture expects concurrent writers (the
  hub serving widgets while agents spawn stdio instances against the same
  file); with the default of 0 a collision threw `SQLITE_BUSY` instantly and
  surfaced to the reporter as "can't reach Loopback". Now 5s.

### Testing
- The demo fixture is now a centred, positioned layout, so the existing pin
  assertion is meaningful; verified by regressing the fix and watching the gate
  fail (dx=284, dy=48). New assertions cover draft survival under an
  unreachable hub, the `/mcp` origin guard, and cross-origin `extra` stripping —
  all in the existing e2e, no new gate.

## [0.6.0] — 2026-07-20

Human triage: the queue stops being read-only for people.

### Added
- **`GET /queue/:id` — a deep-linkable item view.** Every captured detail on
  one page: metadata, report, repro steps, failing requests with their response
  bodies, full network and console history, AI run context, captured
  environment, linked change, and the complete comment trail. Paste the URL to
  a teammate or an agent and they land on exactly the same thing. Queue rows
  link to it; the inline expansion stays for a quick read.
- **Human triage actions** — add a comment and change status directly from the
  item view, as plain HTML form posts that work without JavaScript. Filing was
  already possible from the widget; commenting and moving an item previously
  required an agent or `curl`.
- E2E coverage for the detail view: full context renders, a human comment lands
  on the trail, and the security guard below actually holds.

### Security
- **State-changing triage endpoints are same-origin only.** The server is
  unauthenticated with deliberately wide-open CORS, because the capture widget
  must `POST /ingest` from whatever origin the host app runs on. That trade is
  fine for append-only intake, but must not extend to rewriting an item's
  status or audit trail — otherwise any page you merely visit could quietly
  edit your queue. `/queue/:id/comment` and `/queue/:id/status` now reject
  cross-origin submissions (browsers always attach `Origin` to a cross-origin
  POST) while local tooling that sends no `Origin` keeps working. `/ingest`
  stays open by design; E2E asserts both halves.

## [0.5.0] — 2026-07-20

**Loopback Design System v0** — one token set behind both surfaces, in vanilla
CSS speaking shadcn/ui's contract, plus a published shadcn registry. No React,
no Tailwind, no build step added.

### Added
- **`design/tokens.css`** — shadcn's semantic variables verbatim (oklch,
  `.dark` class, multiplicative radius scale) plus Loopback's `--lb-*` domain
  tokens for feedback status and severity. **`design/components.css`** —
  vanilla recipes (`lb-btn` with variants, `lb-badge`, `lb-card`, `lb-table`,
  `lb-input`, `lb-pin`) using only tokens, so the stylesheet themes itself from
  a host project's palette. Rationale: [design/README.md](design/README.md).
- **Published shadcn registry** (`registry.json` → `public/r/*.json`):
  `loopback-theme` (status/severity tokens that add to a consumer's theme
  rather than replacing it — the CLI also emits `@theme inline` mappings, so
  `bg-lb-verified` works as a utility) and `loopback-widget` (the capture
  widget itself). Installable from a static URL with no auth, and discoverable
  by the **shadcn MCP** via a `@loopback` namespace in `components.json`.
  Verified by installing both into a scratch consumer project.
- **`/queue` item detail** — rows expand in place to the report, captured
  context (failing requests with response bodies, run metadata, console),
  linked change, and the full comment trail; plus a `GET /feedback/:id`
  endpoint. Closes fb_mrsuxhpm. The page also gained a theme toggle that
  resolves before first paint.
- **`registry-gate`** (`npm run registry-gate`, wired into CI) — validates the
  manifest structurally, asserts the built registry is byte-in-sync with the
  source it ships, and catches non-root-relative `target` mistakes.

### Fixed
- **The widget could be restyled by its host page.** Custom properties pierce
  shadow boundaries and `all: initial` does not reset them; worse, a *normal*
  outer-document rule targeting the host element beats `:host` regardless of
  specificity, so `#loopback-widget-host{…}` or even `div{color-scheme:dark}`
  could override the widget — the same mechanism behind the original
  white-on-white bug. Tokens now live on an internal `.lb-root` wrapper that
  the outer page cannot select. E2E asserts ≥4.5:1 contrast under a hostile
  host stylesheet.
- **The widget built its UI with `innerHTML`**, interpolating host-page data
  (context keys, request URLs, reporter-authored titles) into markup. The
  shell, capture form, and pin list are now built with DOM calls and
  `textContent`.
- Widget dark mode: it follows the viewer's `prefers-color-scheme` rather than
  forcing light, and pin colours come from CSS classes instead of inline
  styles, so the status palette lives in exactly one place.

### Added (self-integration, from the previous pass)
- **Loopback is now its own reference integration.** `/queue` embeds the
  capture widget (`data-project=loopback`, endpoint derived from the request
  host so it works on localhost, a LAN `--host` bind, or behind a proxy) — you
  can pin feedback about Loopback on Loopback's own page. The repo is also
  self-onboarded with its own `init`, so any agent opening it finds AGENTS.md,
  both SKILL.md installs, and all three MCP configs. (fb_mrsusvxf)

### Fixed
- **`init` leaked a machine path when the server lives inside the onboarded
  repo**: self-onboarding wrote an absolute `/Users/<name>/…` path into
  `.mcp.json` — unusable by other clones and about to be committed publicly.
  It now emits a repo-relative `./dist/index.js` in that case (absolute stays
  correct for external consuming repos, `npx github:` for ephemeral runs), and
  the init gate asserts the committed configs carry no home directory.
  (fb_mrsuu878)

### Known gaps
- `/queue` has no item detail view: comments, links, and captured context are
  only readable through `loopback_get_feedback`. Needs `GET /feedback/:id` +
  expandable rows. Filed as fb_mrsuxhpm (triaged) — through the widget, on the
  queue page itself.

## [0.4.0] — 2026-07-20

The surfaces release: the queue is explicitly cross-surface, with the flag,
docs, and snippets to prove it. Driven by round two of real-world dogfooding
(contact-form hero scenario + surface audit).

### Added
- **`--host` / `LOOPBACK_HOST`** for the `--http` hub (default stays
  `127.0.0.1`): opt-in LAN binding so physical iOS/Android devices can load
  the widget and POST `/ingest`. The server warns loudly that there is no
  auth; trusted networks only. (fb_mrseejl6)
- **`docs/05-surface-compatibility.md`** — the tiered surface matrix (web,
  extensions, Electron/Tauri, WebViews, native macOS/Windows, mobile
  simulator/device/production, CLI/CI, agents) with native `POST /ingest`
  snippets for Swift, Kotlin, C#, and shell, plus a README "Where it works"
  section.

### Fixed
- **`/queue` change column ignored commit-only links** — items linked with a
  commit but no PR showed "—"; now falls back to the short SHA. (fb_mrseejkq)
- **Demo page dark-on-dark in dark-preferring browsers** — same class as the
  `/queue` bug; demo now declares `color-scheme: light` + explicit background.
  (fb_mrseejln)
- **`/queue` unreadable in dark-preferring browsers**: the triage page set dark
  text but no background/color-scheme, so a dark UA canvas swallowed the rows.
  It now declares `color-scheme: light` + an explicit background — the same
  discipline the widget's shadow UI got in 0.3.1. (fb_mrse2fdk)
- **E2E hermeticity**: `scripts/e2e.mjs` previously spawned its bus on the
  hub's default port — with a central instance already running, the spawn died
  on EADDRINUSE and the suite silently ran against (and wrote test items into)
  the live `~/.loopback/loopback.db`. The suite now uses dedicated ports
  (7177/5273, overridable), injects its endpoint into the demo page via
  `LOOPBACK_ENDPOINT`, and hard-aborts if the endpoint it reaches is not a
  fresh instance. (fb_mrsdza3z)

## [0.3.1] — 2026-07-20

Hardening from the first real-world dogfood run (widget injected at runtime on
a production-grade Next.js 16 App Router site). Each fix closed a queue item
end-to-end: filed → claimed → fixed → verified on the live page → resolved.

### Fixed
- **Widget unreadable on `color-scheme: dark` hosts**: the host page's
  color-scheme inherited into the shadow root, so UA dark-mode control colors
  produced white-on-white buttons/inputs. The widget UI now pins
  `color-scheme: light` and explicit control colors. (fb_mrsdh5kz)
- **Stale pins after SPA navigation**: client-side route changes left the
  previous route's pins rendered for up to one 10s poll tick. The widget now
  hooks `history.pushState`/`replaceState` + `popstate` and refreshes
  immediately; scroll/resize pin re-renders are rAF-throttled. (fb_mrsdrgpo)
- **Brittle selectors on class-only DOMs**: the generator now includes up to
  two semantic class tokens per path segment (state/utility classes filtered
  via stop-list) before falling back to `nth-of-type`, and exposes
  `window.__loopback._cssPath` for tests and browser-driving agents.
  (fb_mrsdrgq9)

### Added
- E2E regression coverage for all three: dark-scheme control colors,
  semantic-class selector output, and instant pin refresh across
  `pushState`/`popstate` navigations.

## [0.3.0] — 2026-07-20

The hub release: Loopback becomes a standalone cross-project, cross-agent
product with a two-minute onboarding path.

### Added
- **`init` subcommand** (`loopback-mcp-server init --project <slug> [--agents
  claude,codex,gemini] [--write]`): renders the one canonical queue playbook
  into every agent's native mechanism — AGENTS.md canonical section, CLAUDE.md
  + GEMINI.md `@AGENTS.md` imports, the same SKILL.md installed to
  `.claude/skills/` and `.agents/skills/`, MCP registration in `.mcp.json`,
  `.gemini/settings.json` (incl. `context.fileName`), and project-scoped
  `.codex/config.toml`, plus a `/loopback` Gemini command. Non-destructive,
  marker-based, byte-idempotent merges; dry-run by default.
- **Integration kit** (`integrations/`): canonical `instructions-src.md`,
  per-agent pages (claude/codex/gemini as equal citizens), widget embed
  template, and keep-alive recipes (pm2 / launchd / systemd).
- **Canonical skill** (`skills/loopback/SKILL.md`) with a triggering-oriented
  description; installed natively for both Claude Code and Codex.
- **Claude Code plugin** (`plugin/`) bundling the skill + MCP registration; the
  repo doubles as its marketplace (`claude plugin marketplace add
  joshidikshant/loopback`). Both manifests pass `claude plugin validate
  --strict`.
- **Visible loop closure in the widget**: status changes announce themselves on
  the open page — toast, pulsing pin, 🔔 tab-title flash (adapted from
  make-pages-interactive, MIT) — plus a `window.__loopback` page API
  (`pins`, `refresh()`, `project`, `endpoint`, `version`; adapted from
  DOM-Review, MIT).
- **CI** (GitHub Actions): build + smoke + init gate, and a Playwright E2E job.
- **Init gate** (`scripts/init-gate.mjs` / `npm run init-gate`): asserts all
  three agents' renderings, slug embedding, frontmatter validity, byte-level
  idempotence, merge preservation of user content, and `--agents` subsetting.

### Changed
- README rewritten as the product front door (hub model, screenshot,
  install-once-per-machine, 2-minute project integration, design decisions).
- `--help` now documents the hub model, all six HTTP endpoints, and `init`.

## [0.2.0] — 2026-07-20

### Added
- **Capture widget** (`widget/loopback-widget.js`): vanilla-JS, shadow-DOM toolbar
  with element-pinned comments, console/network ring buffers, failed-response
  capture, `data-loopback-context` run metadata, and live status pins hydrated
  from the bus.
- `GET /feedback` and `GET /widget.js` on the HTTP surface for pin hydration and
  one-tag embedding.
- Demo app (`demo/`) with an intentionally broken contact form and an AI-answer
  block for exercising the full loop.
- Playwright end-to-end test (`scripts/e2e.mjs`) covering widget capture →
  ingest → agent fix over MCP streamable HTTP → verified pins.

## [0.1.0] — 2026-07-20

### Added
- Loopback MCP bus: nine `loopback_*` tools (submit, list, get, claim, update
  status, comment, link change, resolve, stats) over **stdio** and **stateless
  streamable HTTP** using the official `@modelcontextprotocol/sdk`.
- `node:sqlite` (WAL) storage at `~/.loopback/loopback.db` — zero native deps.
- Atomic claims via guarded UPDATE; conflicts name the holding agent.
- `POST /ingest` plain-JSON entry point for widgets, CI hooks, and ingestors.
- Smoke test driving a real MCP client over stdio (`npm run smoke`).
