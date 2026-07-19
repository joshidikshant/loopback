# Gemini CLI × Loopback

Gemini CLI reads the canonical **AGENTS.md** once `context.fileName` includes
it (and imports it from `GEMINI.md` via `@AGENTS.md` — both are set up by
`init`). Gemini has no SKILL.md system; its renderings are the AGENTS.md
section plus an optional `/loopback` custom command.

## Once per machine

`~/.gemini/settings.json`:

```json
{
  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] },
  "mcpServers": {
    "loopback": {
      "command": "node",
      "args": ["/ABS/PATH/loopback/dist/index.js"]
    }
  }
}
```

Zero-install alternative: `"command": "npx", "args": ["-y", "github:joshidikshant/loopback"]`.

**HTTP variant** — point at the long-running central instance instead:

```json
{ "mcpServers": { "loopback": { "httpUrl": "http://127.0.0.1:7077/mcp" } } }
```

## Per project (2 minutes)

```bash
npx loopback-mcp-server init --project <slug> --write
```

writes for Gemini: the AGENTS.md queue section, a `GEMINI.md` importing it,
`.gemini/settings.json` (merges `context.fileName` **and** the `mcpServers`
entry, preserving anything already there), and `.gemini/commands/loopback.toml`
so `/loopback` works.

## Use

Say **"work the feedback queue"** (AGENTS.md carries the loop), or run
`/loopback` for the explicit version.
