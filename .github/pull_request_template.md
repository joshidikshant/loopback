## What this changes

<!-- One or two lines. Link the issue, or the queue item id if it came in that way. -->

## Why

<!-- What broke, or what was missing. Evidence beats description. -->

## Checks

- [ ] `npm run build` and `npm run smoke` pass locally
- [ ] the gates this change touches pass — the list is in CONTRIBUTING.md
- [ ] a new gate comes with its canary case in `scripts/canary-all.mjs`, so it is
      proven to fail when its subject breaks
- [ ] a new number in the docs comes with a check in `scripts/docs-facts-gate.mjs`
- [ ] no generated file was hand-edited — playbook changes go into
      `integrations/instructions-src.md` and `skills/loopback/SKILL.md` first

Delete a line that does not apply rather than leaving it unticked.
