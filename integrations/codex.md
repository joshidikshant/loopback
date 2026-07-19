# Codex × Loopback

Codex reads the canonical **AGENTS.md** natively and supports **SKILL.md
skills** natively — `init` installs the same skill body Claude gets, at Codex's
paths. Register the MCP server once globally, or per repo.

## Once per machine

`~/.codex/config.toml`:

```toml
[mcp_servers.loopback]
command = "node"
args = ["/ABS/PATH/loopback/dist/index.js"]
# or zero-install:  command = "npx"  /  args = ["-y", "github:joshidikshant/loopback"]
```

**HTTP variant** — point at the long-running central instance instead:

```toml
[mcp_servers.loopback]
url = "http://127.0.0.1:7077/mcp"
```

**Skill, machine-wide (optional):** copy `skills/loopback/SKILL.md` from this
repo to `~/.agents/skills/loopback/SKILL.md` to make the skill available in
every project without running `init`.

## Per project (2 minutes)

```bash
npx loopback-mcp-server init --project <slug> --write
```

writes for Codex: the AGENTS.md queue section (read natively), the skill at
`.agents/skills/loopback/SKILL.md`, and a project-scoped `.codex/config.toml`
with the MCP entry. Codex loads project-scoped config **only after you trust
the repo** in Codex — if you skip trust, use the global config above instead
(`init` prints that block too).

## Use

Say **"work the feedback queue"** — AGENTS.md and the skill both carry the
loop. Explicit trigger: `$loopback` or *"Work the Loopback queue for project
`<slug>`."*
