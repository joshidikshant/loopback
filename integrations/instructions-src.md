# The Loopback queue playbook — canonical source

This file is the **one source of truth** for how a coding agent works the
Loopback feedback queue. Nothing else defines the loop; everything else renders
it:

| Rendering | Mechanism | Who reads it |
|---|---|---|
| `AGENTS.md` § "Working the Loopback queue" | written by `loopback-mcp-server init` | Codex + Gemini CLI natively; Claude Code via the `@AGENTS.md` import in CLAUDE.md |
| `.claude/skills/loopback/SKILL.md` | installed by `init` (and by the Claude Code plugin) | Claude Code |
| `.agents/skills/loopback/SKILL.md` | installed by `init` | Codex |
| `.gemini/commands/loopback.toml` | installed by `init` | Gemini CLI (`/loopback`) |

`init` reads the block between the playbook markers below at run time and
substitutes `{{PROJECT}}` with the repo's slug. Edit **here first**; the skill
body (`skills/loopback/SKILL.md`) mirrors this text and must be updated with it.

<!-- playbook:begin -->
Loopback is the feedback bus for this repo. Real product usage — pinned UI
feedback, backend failures with response bodies, UX papercuts, feedback on AI
features with their run metadata — lands in one queue. Your job is to close
loops: fix what real usage surfaced, and write the outcome back so the reporter
sees the pin turn green.

Project slug for this repo: **`{{PROJECT}}`**.

### The loop

Work one item at a time, most severe first:

1. `loopback_list_feedback(project="{{PROJECT}}", status="open")` — see what
   users actually hit. Check `triaged` too if the open queue is empty.
2. `loopback_claim_feedback(id, agent=<your name>)` — claim as your own agent
   name: `claude-code`, `codex`, `gemini`, or your CLI's name. If the claim is
   rejected, another agent holds it — pick a different item. Never force-claim
   (`force=true`) without first stating why in a `loopback_add_comment`.
3. `loopback_get_feedback(id)` — read ALL captured context before touching
   code. A pin is an anchor, not a scope: a pin on a form button often carries
   the backend root cause. Specifically read:
   - `network` and `extra.failed_responses` — failing calls with up to 2KB of
     response body (error codes, hints, stack fragments);
   - `console` and `repro_steps`;
   - `extra.context` — `run_id` / `model` / `trace_url` when the feedback is on
     an AI or automation feature. Chase the trace, not just the DOM.
4. Comment your root-cause diagnosis via `loopback_add_comment` **before**
   fixing — it is the audit trail that makes the queue trustworthy.
5. Fix it in this repo. Smallest change that addresses what was reported.
6. `loopback_link_change(id, repo, branch, commit, pr_url, diff_summary)` — the
   fix must be traceable from the feedback item.
7. `loopback_update_status(id, status="fixed", note=...)`.
8. Verify for real, don't assume: UI issues → drive the running app with your
   browser tool/MCP; backend or logic → run the tests or hit the endpoint;
   usage/metric issues → check the metric or replay.
9. Only after verification: `loopback_resolve_feedback(id,
   resolution="verified", note=..., agent=<your name>)`. **Pass `agent`** — this
   is the write that turns the reporter's pin full green, and without it the
   trail records the default `"agent"` instead of you. Use `wontfix` with a
   reason when intentionally not fixing. Resolving flips the reporter's pin
   green — do not claim it until it is true.

### Attachments — reference vs asset

Items can carry files, and the two intents mean different things to you:

- **`reference`** — context for the fix (a screenshot, a spec, an error dump).
  Read it, do not ship it.
- **`asset`** — a **deliverable**. The reporter is handing you a file that
  belongs in the repo. `loopback_get_feedback` gives you an absolute `path` and
  a `target_path`: copy the file to that path and commit it as part of the fix.
  An asset with no `target_path` is a question for the reporter, not a guess.

Both appear in the default `loopback_get_feedback` response under
`## Attachments`. If an item has an asset and you close it without placing the
file, the loop is not closed.

### Filing feedback (agents report too)

- Over MCP: `loopback_submit_feedback(project="{{PROJECT}}", type=ui|backend|usage|ux,
  title=..., body=..., severity=p0-p3, reporter="agent", ...)`.
- Over HTTP (hooks, CI, automation without MCP):
  `POST http://127.0.0.1:7077/ingest` with the same JSON fields.
- For LLM/automation output, set `type="usage"` and put run metadata in
  `extra.context` (`{"run_id": ..., "model": ..., "trace_url": ...}`) so the
  next agent can chase the run, not just the symptom.
<!-- playbook:end -->

---

**For humans:** the same queue is visible at
`http://127.0.0.1:7077/queue?project=<slug>` while the central instance runs
with `--http`, and every page with the widget shows it as status pins.
