# Agent instructions

<!-- loopback:queue:begin -->
## Working the Loopback queue

Loopback is the feedback bus for this repo. Real product usage — pinned UI
feedback, backend failures with response bodies, UX papercuts, feedback on AI
features with their run metadata — lands in one queue. Your job is to close
loops: fix what real usage surfaced, and write the outcome back so the reporter
sees the pin turn green.

Project slug for this repo: **`loopback`**.

### The loop

Work one item at a time, most severe first:

1. `loopback_list_feedback(project="loopback", status="open")` — see what
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
   resolution="verified", note=...)`. Use `wontfix` with a reason when
   intentionally not fixing. Resolving flips the reporter's pin green — do not
   claim it until it is true.

### Filing feedback (agents report too)

- Over MCP: `loopback_submit_feedback(project="loopback", type=ui|backend|usage|ux,
  title=..., body=..., severity=p0-p3, reporter="agent", ...)`.
- Over HTTP (hooks, CI, automation without MCP):
  `POST http://127.0.0.1:7077/ingest` with the same JSON fields.
- For LLM/automation output, set `type="usage"` and put run metadata in
  `extra.context` (`{"run_id": ..., "model": ..., "trace_url": ...}`) so the
  next agent can chase the run, not just the symptom.
<!-- loopback:queue:end -->
