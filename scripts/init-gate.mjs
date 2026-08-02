/**
 * Init gate: in a throwaway temp dir, run the built `init --project test-app
 * --write` and assert every rendering for all three agents exists and carries
 * the slug; then re-run and assert byte-level idempotence; then verify merges
 * preserve pre-existing user content. Run: npm run build && node scripts/init-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, symlinkSync } from "node:fs";
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

// No branch of serverCommand() may leak a machine path into a config that
// gets committed. An EXTERNAL repo onboarded from a stable checkout (this
// very gate run: CLI in this repo, cwd a temp dir) gets the published
// package via npx — the old absolute-path "fast startup" branch wrote a
// username-bearing path that dj-system committed to a public repo, where it
// worked on exactly one machine.
const HOME = process.env.HOME ?? "/Users";
assert(
  mcpJson.mcpServers?.loopback?.command === "npx" &&
    (mcpJson.mcpServers?.loopback?.args ?? []).includes("loopback-mcp-server"),
  ".mcp.json for an external repo launches the published package via npx",
);
for (const cfg of [".mcp.json", ".codex/config.toml", ".gemini/settings.json"]) {
  const body = read(fresh, cfg) ?? "";
  assert(
    !body.includes(HOME) && !body.includes(process.cwd()),
    `external ${cfg} carries no machine path`,
  );
}
// When the server lives INSIDE the repo being onboarded — this repo, which
// self-onboards and commits the result — the path must be repo-relative, or
// the committed config leaks a username and breaks on every other clone.
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


// ---------- no rendered config git-clones the repo ----------
// `serverCommand()` emits the EPHEMERAL branch when its own entry path contains
// an `_npx` segment — which is what happens when an adopter runs the command
// the README documents (`npx loopback-mcp-server init`). That branch used to
// write `npx -y github:joshidikshant/loopback`, so every adopter following the
// README got a config that cloned the repo and ran a full tsc build on every
// cold MCP start. Correct when nothing was published; wrong once it was.
//
// This MUST run the CLI from an `_npx`-shaped path. A first version of this
// check invoked the normal `dist/index.js` and passed with the github spec
// restored — the stable path never reaches the branch under test.
{
  const npxRoot = mkdtempSync(join(tmpdir(), "loopback-ephemeral-"));
  const pkgDir = join(npxRoot, "_npx", "deadbeef", "node_modules", "loopback-mcp-server");
  mkdirSync(pkgDir, { recursive: true });
  for (const dir of ["dist", "integrations", "skills"]) {
    cpSync(join(process.cwd(), dir), join(pkgDir, dir), { recursive: true });
  }
  cpSync(join(process.cwd(), "package.json"), join(pkgDir, "package.json"));
  // Dependencies resolve through a link; only the ENTRY path decides the branch.
  symlinkSync(join(process.cwd(), "node_modules"), join(pkgDir, "node_modules"), "dir");

  const adopter = join(npxRoot, "adopter");
  mkdirSync(adopter, { recursive: true });
  execFileSync(process.execPath, [join(pkgDir, "dist", "index.js"), "init", "--project", "npx-adopter", "--write"], {
    cwd: adopter,
    stdio: "pipe",
  });

  const rendered = [
    [".mcp.json", readFileSync(join(adopter, ".mcp.json"), "utf-8")],
    [".codex/config.toml", readFileSync(join(adopter, ".codex", "config.toml"), "utf-8")],
    [".gemini/settings.json", readFileSync(join(adopter, ".gemini", "settings.json"), "utf-8")],
  ];
  // Guard the guard: prove this render actually took the ephemeral branch,
  // otherwise the whole block is testing the wrong code path again.
  //
  // On the PARSED command, not a substring of the file: the first version of
  // this guard searched the raw text for "npx" while the temp directory was
  // itself named `loopback-npx-…`, so the absolute path in a `node <path>`
  // command satisfied it. Moving the fixture off a stable path left the guard
  // green — the canary caught it.
  const renderedCommand = JSON.parse(readFileSync(join(adopter, ".mcp.json"), "utf-8"))
    .mcpServers?.loopback?.command;
  assert(
    renderedCommand === "npx",
    `the ephemeral (_npx) branch was actually exercised — rendered command is '${renderedCommand}', expected 'npx'`,
  );
  for (const [name, text] of rendered) {
    assert(
      !text.includes("github:"),
      `init's ${name} does not point an adopter at a git clone (npx github:… rebuilds from source on every cold MCP start)`,
    );
    assert(
      text.includes("loopback-mcp-server"),
      `init's ${name} points at the published npm package`,
    );
  }
  rmSync(npxRoot, { recursive: true, force: true });
}

// ---------- the repo eats its own init output ----------
// The canonical template (skills/loopback/SKILL.md) is what every ADOPTER
// gets; .claude/skills/loopback/SKILL.md is what THIS repo runs on. Pass 20's
// doc fix landed only on the installed copy and nothing noticed — adopters
// would have onboarded with the stale playbook. A fresh render for this
// repo's own slug must equal the installed copy byte for byte, and the same
// for the AGENTS.md queue block.
{
  const renderDir = mkdtempSync(join(tmpdir(), "loopback-selfrender-"));
  execFileSync(process.execPath, [CLI, "init", "--project", "loopback", "--write"], {
    cwd: renderDir,
    stdio: "pipe",
  });
  const freshSkill = readFileSync(join(renderDir, ".claude", "skills", "loopback", "SKILL.md"), "utf-8");
  const repoSkill = readFileSync(join(process.cwd(), ".claude", "skills", "loopback", "SKILL.md"), "utf-8");
  assert(
    freshSkill === repoSkill,
    "repo's installed SKILL.md is exactly what init renders for slug 'loopback' (canonical and installed cannot drift)",
  );
  const block = (text) => {
    const a = text.indexOf("<!-- loopback:queue:begin -->");
    const b = text.indexOf("<!-- loopback:queue:end -->");
    return a === -1 || b === -1 ? null : text.slice(a, b);
  };
  const freshAgents = block(readFileSync(join(renderDir, "AGENTS.md"), "utf-8"));
  const repoAgents = block(readFileSync(join(process.cwd(), "AGENTS.md"), "utf-8"));
  assert(freshAgents !== null && freshAgents === repoAgents,
    "repo's AGENTS.md queue block is exactly what init renders (instructions-src cannot drift)");
  rmSync(renderDir, { recursive: true, force: true });

  // The PLUGIN channel carries a fourth copy, and it escaped the check above
  // because it is not init output — nothing renders it, so it silently kept a
  // pre-attachments playbook while the other three were fixed. Found by a
  // structural review, not by a gate, which is the point of adding one.
  const pluginSkill = readFileSync(join(process.cwd(), "plugin", "skills", "loopback", "SKILL.md"), "utf-8");
  const canonical = readFileSync(join(process.cwd(), "skills", "loopback", "SKILL.md"), "utf-8");
  assert(
    pluginSkill === canonical,
    "plugin/skills/loopback/SKILL.md matches the canonical template (the plugin ships its own copy)",
  );

  // There are TWO self-declared canonical sources, and every check above runs
  // from one of them down to its renderings. Nothing compared them to EACH
  // OTHER — instructions-src.md says the skill body "mirrors this text and must
  // be updated with it", and that sync was purely manual. It is the one drift
  // class in this repo with no automated check.
  //
  // They are not byte-identical by design (the skill carries frontmatter and
  // resolves its own project slug, the playbook gets {{PROJECT}} substituted),
  // so the invariant is the loop itself: both must drive the same tools in the
  // same order. Adding a step to one and not the other is the failure that
  // matters — an agent reading the skill would work a different loop than one
  // reading AGENTS.md.
  const instructionsSrc = readFileSync(join(process.cwd(), "integrations", "instructions-src.md"), "utf-8");
  const playbook = instructionsSrc.split("<!-- playbook:begin -->")[1]?.split("<!-- playbook:end -->")[0];
  const loopTools = (text, heading) => {
    const m = new RegExp(`${heading}\\n(.*?)(?=\\n#{2,3} )`, "s").exec(text);
    if (!m) return null;
    return [...new Set(m[1].match(/loopback_[a-z_]+/g) ?? [])];
  };
  const srcLoop = playbook ? loopTools(playbook, "### The loop") : null;
  const skillLoop = loopTools(canonical, "## The loop");
  assert(
    srcLoop !== null && skillLoop !== null,
    "both canonical sources still have a parseable 'The loop' section",
  );
  assert(
    JSON.stringify(srcLoop) === JSON.stringify(skillLoop),
    `the two canonical sources drive the same loop in the same order${
      srcLoop && skillLoop && JSON.stringify(srcLoop) !== JSON.stringify(skillLoop)
        ? `\n     instructions-src: ${srcLoop.join(" → ")}\n     SKILL.md:         ${skillLoop.join(" → ")}`
        : ""
    }`,
  );

  // Three version fields the npm release does not touch, so they rot silently:
  // both were still 0.8.0 two published releases later.
  const pkgVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).version;
  const pluginManifest = JSON.parse(
    readFileSync(join(process.cwd(), "plugin", ".claude-plugin", "plugin.json"), "utf-8"),
  );
  const marketplace = JSON.parse(
    readFileSync(join(process.cwd(), ".claude-plugin", "marketplace.json"), "utf-8"),
  );
  assert(
    pluginManifest.version === pkgVersion,
    `plugin.json version tracks package.json (${pluginManifest.version} vs ${pkgVersion})`,
  );
  assert(
    marketplace.plugins.every((x) => x.version === pkgVersion),
    `marketplace.json plugin versions track package.json (${marketplace.plugins.map((x) => x.version).join(",")} vs ${pkgVersion})`,
  );

  // An adopter installing the plugin should get the PUBLISHED artifact, not a
  // git clone that runs a full tsc build on every cold start.
  const pluginMcp = JSON.parse(readFileSync(join(process.cwd(), "plugin", ".mcp.json"), "utf-8"));
  const args = pluginMcp.mcpServers.loopback.args.join(" ");
  assert(
    args.includes("loopback-mcp-server") && !args.includes("github:"),
    `plugin/.mcp.json installs the published npm package, not a git clone (${args})`,
  );
}

if (failures) {
  console.error(`\nINIT GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nINIT GATE PASSED 🎉  all three agents' renderings + idempotence + merge safety");
