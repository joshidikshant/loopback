# Claude Code × Loopback

Claude Code reads the canonical **AGENTS.md** section through the `@AGENTS.md`
import that `init` places in `CLAUDE.md`, and triggers the **loopback skill**
from `.claude/skills/loopback/SKILL.md`. Register the MCP server once per
machine (recommended) or per project.

## Once per machine (pick one)

**A — user-scope MCP registration:**

```bash
# local checkout (fast startup):
claude mcp add --scope user loopback -- node /ABS/PATH/loopback/dist/index.js
# or zero-install from GitHub:
claude mcp add --scope user loopback -- npx -y github:joshidikshant/loopback
```

**B — the plugin** (bundles the skill + MCP registration in one install):

```bash
claude plugin marketplace add joshidikshant/loopback
claude plugin install loopback@loopback
```

**HTTP variant** — when the central instance is already running with `--http`
(see `keep-alive.md`), point Claude at it instead of spawning a process:

```bash
claude mcp add --scope user --transport http loopback http://127.0.0.1:7077/mcp
```

Either way, stdio spawns and the HTTP instance share the same
`~/.loopback/loopback.db` — one queue.

## Per project (2 minutes)

```bash
npx loopback-mcp-server init --project <slug> --write
```

writes for Claude: the `@AGENTS.md` import in `CLAUDE.md`, the skill at
`.claude/skills/loopback/SKILL.md` (slug embedded), and `.mcp.json`
(project-scope MCP; skip if you registered user-scope).

## Use

Say **"work the feedback queue"** (or anything about user-reported issues) —
the skill triggers. Or be explicit: *"Work the Loopback queue for project
`<slug>`."*
