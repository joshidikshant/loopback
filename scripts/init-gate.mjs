/**
 * Init gate: in a throwaway temp dir, run the built `init --project test-app
 * --write` and assert every rendering for all three agents exists and carries
 * the slug; then re-run and assert byte-level idempotence; then verify merges
 * preserve pre-existing user content. Run: npm run build && node scripts/init-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "index.js");
let failures = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    failures++;
    console.error(`❌ ${msg}`);
  }
}

function read(dir, rel) {
  try {
    return readFileSync(join(dir, rel), "utf-8");
  } catch {
    return null;
  }
}

function runInit(dir, extraArgs = []) {
  return execFileSync(
    process.execPath,
    [CLI, "init", "--project", "test-app", "--write", ...extraArgs],
    { cwd: dir, encoding: "utf-8" },
  );
}

function hashAll(dir, files) {
  return files
    .map((f) => `${f}:${createHash("sha256").update(read(dir, f) ?? "MISSING").digest("hex")}`)
    .join("\n");
}

function frontmatterValid(content) {
  if (!content) return false;
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  return /^name:\s*\S+/m.test(match[1]) && /^description:\s*\S+/m.test(match[1]);
}

const TRACKED = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".mcp.json",
  ".gemini/settings.json",
  ".gemini/commands/loopback.toml",
  ".codex/config.toml",
  ".claude/skills/loopback/SKILL.md",
  ".agents/skills/loopback/SKILL.md",
];

// ---------- 1. Fresh repo: all renderings exist and carry the slug ----------
const fresh = mkdtempSync(join(tmpdir(), "loopback-init-gate-"));
const stdout = runInit(fresh);

const agents = read(fresh, "AGENTS.md");
assert(
  agents?.includes("## Working the Loopback queue") && agents.includes("test-app"),
  "AGENTS.md has the queue section with the slug",
);
assert(
  agents?.includes("loopback_list_feedback") && agents.includes("loopback_resolve_feedback"),
  "AGENTS.md section carries the full loop",
);
assert(/@(\.\/)?AGENTS\.md/.test(read(fresh, "CLAUDE.md") ?? ""), "CLAUDE.md imports @AGENTS.md");
assert(/@(\.\/)?AGENTS\.md/.test(read(fresh, "GEMINI.md") ?? ""), "GEMINI.md imports @AGENTS.md");

const gemini = JSON.parse(read(fresh, ".gemini/settings.json") ?? "{}");
assert(
  Array.isArray(gemini.context?.fileName) && gemini.context.fileName.includes("AGENTS.md"),
  ".gemini/settings.json context.fileName includes AGENTS.md",
);
assert(
  gemini.mcpServers?.loopback?.command !== undefined,
  ".gemini/settings.json has the loopback mcpServers entry",
);

const claudeSkill = read(fresh, ".claude/skills/loopback/SKILL.md");
const codexSkill = read(fresh, ".agents/skills/loopback/SKILL.md");
assert(frontmatterValid(claudeSkill), ".claude/skills/loopback/SKILL.md has valid name:/description: frontmatter");
assert(frontmatterValid(codexSkill), ".agents/skills/loopback/SKILL.md has valid name:/description: frontmatter");
assert(
  claudeSkill === codexSkill && claudeSkill?.includes("`test-app`"),
  "both skill installs are the same body with the slug embedded",
);

const mcpJson = JSON.parse(read(fresh, ".mcp.json") ?? "{}");
assert(mcpJson.mcpServers?.loopback?.command !== undefined, ".mcp.json registers loopback");

assert(
  (read(fresh, ".codex/config.toml") ?? "").includes("[mcp_servers.loopback]"),
  ".codex/config.toml has the project-scoped MCP entry",
);
assert(
  (read(fresh, ".gemini/commands/loopback.toml") ?? "").includes("prompt"),
  ".gemini/commands/loopback.toml command exists",
);
assert(
  stdout.includes("[mcp_servers.loopback]"),
  "init prints the Codex config.toml block",
);
assert(stdout.includes('data-project="test-app"'), "init prints the widget embed with the slug");

// An external consuming repo correctly gets an absolute path to the checkout.
// But when the server lives INSIDE the repo being onboarded — this repo, which
// self-onboards and commits the result — the path must be repo-relative, or the
// committed config leaks a username and breaks on every other clone.
const HOME = process.env.HOME ?? "/Users";
for (const cfg of [".mcp.json", ".codex/config.toml", ".gemini/settings.json"]) {
  const body = read(process.cwd(), cfg);
  if (body === null) continue; // repo not self-onboarded (fine for consumers)
  assert(
    !body.includes(HOME) && body.includes("./dist/index.js"),
    `self-onboarded ${cfg} uses a repo-relative path, not a machine path`,
  );
}

// ---------- 2. Idempotence: second run is byte-identical, no duplicates ----------
const before = hashAll(fresh, TRACKED);
runInit(fresh);
const after = hashAll(fresh, TRACKED);
assert(before === after, "re-running init --write is byte-level idempotent");
assert(
  (agents?.match(/## Working the Loopback queue/g) ?? []).length === 1 &&
    (read(fresh, "AGENTS.md")?.match(/## Working the Loopback queue/g) ?? []).length === 1,
  "no duplicated queue sections after re-run",
);

// ---------- 3. Merges preserve pre-existing user content ----------
const seeded = mkdtempSync(join(tmpdir(), "loopback-init-merge-"));
writeFileSync(join(seeded, "AGENTS.md"), "# My project\n\nBuild with `make`.\n");
writeFileSync(join(seeded, "CLAUDE.md"), "# Claude notes\n\nPrefer small diffs.\n");
mkdirSync(join(seeded, ".gemini"), { recursive: true });
writeFileSync(
  join(seeded, ".gemini", "settings.json"),
  JSON.stringify({ context: { fileName: "TEAM.md" }, mcpServers: { other: { command: "x" } } }, null, 2),
);
writeFileSync(
  join(seeded, ".mcp.json"),
  JSON.stringify({ mcpServers: { existing: { command: "y" } } }, null, 2),
);
runInit(seeded);

const seededAgents = read(seeded, "AGENTS.md");
assert(
  seededAgents?.includes("Build with `make`.") && seededAgents.includes("## Working the Loopback queue"),
  "existing AGENTS.md content preserved; queue section appended",
);
const seededClaude = read(seeded, "CLAUDE.md");
assert(
  seededClaude?.includes("Prefer small diffs.") && /@(\.\/)?AGENTS\.md/.test(seededClaude),
  "existing CLAUDE.md preserved; import appended",
);
const seededGemini = JSON.parse(read(seeded, ".gemini/settings.json") ?? "{}");
assert(
  seededGemini.context?.fileName?.includes("TEAM.md") &&
    seededGemini.context.fileName.includes("AGENTS.md") &&
    seededGemini.mcpServers?.other?.command === "x" &&
    seededGemini.mcpServers?.loopback !== undefined,
  ".gemini/settings.json merge keeps user's fileName + servers and adds ours",
);
const seededMcp = JSON.parse(read(seeded, ".mcp.json") ?? "{}");
assert(
  seededMcp.mcpServers?.existing?.command === "y" && seededMcp.mcpServers?.loopback !== undefined,
  ".mcp.json merge keeps existing servers and adds loopback",
);

// ---------- 4. --agents subset only touches that agent's files ----------
const subset = mkdtempSync(join(tmpdir(), "loopback-init-subset-"));
runInit(subset, ["--agents", "claude"]);
assert(read(subset, "AGENTS.md") !== null, "subset: AGENTS.md still rendered (canonical)");
assert(read(subset, ".mcp.json") !== null, "subset: claude files rendered");
assert(
  read(subset, ".codex/config.toml") === null && read(subset, ".gemini/settings.json") === null,
  "subset: codex/gemini files not rendered",
);

for (const dir of [fresh, seeded, subset]) rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\nINIT GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nINIT GATE PASSED 🎉  all three agents' renderings + idempotence + merge safety");
