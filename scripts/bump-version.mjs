/**
 * Bump the version everywhere it is coupled.
 *
 * A release touches SIX hand-typed fields across five files, and the gates
 * enforce that they agree — so a partial bump fails CI, and a forgotten bump
 * fails at the worst moment: `npm publish` refuses with
 * "cannot publish over the previously published versions", after the release
 * notes are written and the commit is pushed. That happened.
 *
 * Run: npm run bump 0.9.3
 *
 * This only edits files. Build, gates and publish stay separate and manual —
 * the point is to remove a transcription error, not to automate releasing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const NEXT = process.argv[2];

if (!NEXT || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(NEXT)) {
  console.error("Usage: npm run bump <version>    e.g. npm run bump 0.9.3");
  process.exit(1);
}

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf-8"));
const writeJson = (rel, data) =>
  writeFileSync(join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);

const current = readJson("package.json").version;
if (current === NEXT) {
  console.error(`package.json is already ${NEXT} — nothing to do.`);
  process.exit(1);
}

const edits = [];

// 1. package.json — what npm publishes, and the source of truth every gate
//    compares against.
const pkg = readJson("package.json");
pkg.version = NEXT;
writeJson("package.json", pkg);
edits.push("package.json");

// 2. SERVER_VERSION — what the server reports over MCP. `npm run smoke`
//    asserts it equals package.json.
const serverTs = join(ROOT, "src", "server.ts");
const before = readFileSync(serverTs, "utf-8");
const after = before.replace(
  /export const SERVER_VERSION = "[^"]+";/,
  `export const SERVER_VERSION = "${NEXT}";`,
);
if (after === before) {
  console.error("Could not find SERVER_VERSION in src/server.ts — bump aborted, tree is now inconsistent.");
  process.exit(1);
}
writeFileSync(serverTs, after);
edits.push("src/server.ts");

// 3. server.json — the MCP Registry resolves the package by EXACT version, so
//    both the server version and every package entry have to move.
const srv = readJson("server.json");
srv.version = NEXT;
for (const p of srv.packages ?? []) p.version = NEXT;
writeJson("server.json", srv);
edits.push("server.json (version + packages[])");

// 4/5. The plugin channel. `npm publish` never touches these, which is exactly
//      why they sat at 0.8.0 for two releases.
const plugin = readJson("plugin/.claude-plugin/plugin.json");
plugin.version = NEXT;
writeJson("plugin/.claude-plugin/plugin.json", plugin);
edits.push("plugin/.claude-plugin/plugin.json");

const market = readJson(".claude-plugin/marketplace.json");
for (const p of market.plugins ?? []) p.version = NEXT;
writeJson(".claude-plugin/marketplace.json", market);
edits.push(".claude-plugin/marketplace.json");

console.log(`\n${current} → ${NEXT}\n`);
for (const e of edits) console.log(`  ✅ ${e}`);
console.log(`
Next:
  npm run build && npm run smoke && node scripts/init-gate.mjs   # parity gates
  git commit && git push                                          # push BEFORE verifying
  npm publish --otp=<code>
  mcp-publisher publish
  npm run verify:release
`);
