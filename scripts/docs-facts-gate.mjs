/**
 * Docs-facts gate: the numbers in the docs must match the code they describe.
 *
 * Every other gate protects structure — that a file exists, renders, or matches
 * its canonical source. None of them ever read a *claim*. So the drift that
 * accumulated was entirely in hand-typed figures, and it was invisible:
 *
 *   - the widget's size was quoted four different ways across four files
 *     (46KB/15KB, 57KB/19KB, 57,183 B, ~29KB) against a real 59,443 B, and TWO
 *     separate commits claimed to have "corrected the widget size" while each
 *     fixed only one of the occurrences;
 *   - "The MCP bus — 10 tools" sat above a table with 9 rows for two releases,
 *     with loopback_update_feedback — announced in the 0.8.0 changelog —
 *     missing;
 *   - the HTTP surface table silently omitted all three attachment endpoints.
 *
 * A number nobody re-measures is a claim, not a fact. This re-measures them.
 *
 * Deliberately NOT checked here: prose. This asserts only things with one
 * correct answer that can be derived from the tree.
 *
 * Run: node scripts/docs-facts-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf-8");

let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => {
  failures++;
  console.error(`❌ ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

// ── the widget's size, measured ──────────────────────────────────────────────
// The docs describe this figure as "on the wire", so it is measured the way the
// server actually produces it: gzipSync with no options (src/http.ts:396). That
// distinction is not pedantic — the same file is 19,770 B at zlib's default
// level, 19,753 B at level 9, and 19,751 B through the gzip(1) CLI. The
// previous figure had been measured with the CLI and labelled "on the wire",
// so it was wrong by both method and 19 bytes.
const widget = readFileSync(join(ROOT, "widget/loopback-widget.js"));
const rawB = statSync(join(ROOT, "widget/loopback-widget.js")).size;
const gzB = gzipSync(widget).length;
const rawKB = Math.round(rawB / 1024);
const gzKB = Math.round(gzB / 1024);
console.log(`   widget measured: ${rawB} B raw / ${gzB} B gzipped as served → ~${rawKB}KB / ${gzKB}KB\n`);

const readme = read("README.md");
const roadmap = read("docs/ROADMAP.md");
const designReadme = read("design/README.md");

// Any "<n>KB" adjacent to a gzip claim in the README must be the real rounded
// size. Catching every KB figure in the file would be noisy, so this anchors on
// the two sentences that actually describe the bundle.
const kbClaims = [
  ...readme.matchAll(/~?(\d+)KB \((\d+)KB gzipped\)/g),
  ...readme.matchAll(/Widget is (\d+)KB \/ (\d+)KB gzipped/g),
];
check(
  kbClaims.length >= 2,
  `README still states the widget size in both places (found ${kbClaims.length})`,
);
for (const m of kbClaims) {
  check(
    Number(m[1]) === rawKB && Number(m[2]) === gzKB,
    `README "${m[0]}" matches the measured ~${rawKB}KB / ${gzKB}KB`,
  );
}

const exact = roadmap.match(/([\d,]+) B raw \/ ([\d,]+) B gzipped/);
check(!!exact, "docs/ROADMAP.md still states the widget's exact byte size");
if (exact) {
  const n = (s) => Number(s.replace(/,/g, ""));
  check(
    n(exact[1]) === rawB && n(exact[2]) === gzB,
    `ROADMAP "${exact[0]}" matches the measured ${rawB} B / ${gzB} B`,
  );
}

const designKB = designReadme.match(/single ~(\d+)KB dependency-free file/);
check(!!designKB, "design/README.md still states the widget size");
if (designKB) {
  check(
    Number(designKB[1]) === rawKB,
    `design/README.md "~${designKB[1]}KB" matches the measured ~${rawKB}KB`,
  );
}

// ── the MCP tool count, counted ──────────────────────────────────────────────
const serverTs = read("src/server.ts");
const tools = [...new Set([...serverTs.matchAll(/"(loopback_[a-z_]+)"/g)].map((m) => m[1]))].sort();
const claimed = readme.match(/## The MCP bus — (\d+) tools/);
check(!!claimed, "README still has the 'The MCP bus — N tools' heading");
if (claimed) {
  check(
    Number(claimed[1]) === tools.length,
    `README claims ${claimed[1]} tools; src/server.ts registers ${tools.length}`,
  );
}
// The heading agreeing with the code is not enough — the table itself went a
// whole tool short while the heading was right.
const missingRows = tools.filter((t) => !readme.includes(`\`${t}\``));
check(
  missingRows.length === 0,
  `every registered tool has a README row${missingRows.length ? ` — missing: ${missingRows.join(", ")}` : ""}`,
);

// ── the HTTP surface, enumerated ─────────────────────────────────────────────
// Express route strings, normalised to the README's ":id" style.
const httpTs = read("src/http.ts");
const routes = [...httpTs.matchAll(/app\.(get|post|delete|put)\(\s*"([^"]+)"/g)]
  .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
  // /queue and /queue/:id are the dashboard SPA shell, documented as a page
  // rather than an API endpoint; /mcp's GET+DELETE are the 405 pair the /mcp
  // row already describes.
  .filter((r) => !["GET /queue", "GET /queue/:id", "GET /mcp", "DELETE /mcp"].includes(r));
const undocumented = routes.filter((r) => {
  const path = r.split(" ")[1];
  return !readme.includes(path);
});
check(
  undocumented.length === 0,
  `every HTTP route appears in the README surface table${
    undocumented.length ? ` — missing: ${undocumented.join(", ")}` : ""
  }`,
);

// ── the endpoints left open on a token bind ──────────────────────────────────
// README said "Three endpoints stay open" and listed three while requireAuth
// let four through — /health was open in the code and absent from the table.
// This is a security claim, so it is worth deriving rather than trusting.
const authFn = httpTs.slice(httpTs.indexOf("requireAuth"));
const authBody = authFn.slice(0, authFn.indexOf("const presented"));
const openPaths = [...new Set([...authBody.matchAll(/req\.path === "([^"]+)"/g)].map((m) => m[1]))];
const openSection = readme.slice(readme.indexOf("stay open on a LAN bind"));
const openTable = openSection.slice(0, openSection.indexOf("\n\n", openSection.indexOf("|---|---|")));
const openRows = (openTable.match(/^\| `/gm) ?? []).length;
const NUMBER = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6 };
const stated = readme.match(/(\w+) endpoints stay open on a LAN bind/);
check(
  openPaths.every((p) => openTable.includes(p)),
  `every endpoint requireAuth leaves open is in the README table${
    openPaths.filter((p) => !openTable.includes(p)).length
      ? ` — missing: ${openPaths.filter((p) => !openTable.includes(p)).join(", ")}`
      : ""
  }`,
);
check(
  openRows === openPaths.length,
  `README lists ${openRows} open endpoints; requireAuth leaves ${openPaths.length} open`,
);
check(
  !!stated && NUMBER[stated[1]] === openPaths.length,
  `README says "${stated?.[1]} endpoints stay open" and ${openPaths.length} actually do`,
);

// ── the shadcn registry, enumerated ──────────────────────────────────────────
const registry = JSON.parse(read("registry.json"));
const items = (registry.items ?? []).map((i) => i.name);
const undocItems = items.filter((n) => !readme.includes(`\`${n}\``));
check(
  undocItems.length === 0,
  `every shadcn registry item is documented${undocItems.length ? ` — missing: ${undocItems.join(", ")}` : ""}`,
);

// ── the canary count, counted ────────────────────────────────────────────────
// ROADMAP quotes how many checks the sweep runs; it said 15 while the array
// held 20.
const canary = read("scripts/canary-all.mjs");
const caseCount = (canary.match(/^\s{2}\{$/gm) ?? []).length;
const canaryClaim = roadmap.match(/runs (\d+) checks/);
if (canaryClaim) {
  check(
    Number(canaryClaim[1]) === caseCount,
    `ROADMAP claims ${canaryClaim[1]} canary checks; canary-all.mjs defines ${caseCount}`,
  );
} else {
  ok("ROADMAP does not quote a canary count (nothing to drift)");
}

// ── npm's published version vs the tree ──────────────────────────────────────
// Only a warning: the tree is legitimately ahead between a bump and a publish.
const pkg = JSON.parse(read("package.json"));
try {
  const latest = execFileSync("npm", ["view", "loopback-mcp-server", "version"], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const quoted = [...roadmap.matchAll(/loopback-mcp-server@([\d.]+)/g)].map((m) => m[1]);
  for (const v of quoted) {
    check(
      v === latest || v === pkg.version,
      `ROADMAP quotes loopback-mcp-server@${v}; npm latest is ${latest}, tree is ${pkg.version}`,
    );
  }
} catch {
  console.log("⚠️  could not reach npm to compare the published version — skipped");
}

if (failures) {
  console.error(`\nDOCS FACTS GATE FAILED — ${failures} claim(s) do not match the code`);
  process.exit(1);
}
console.log("\nDOCS FACTS GATE PASSED 🎉  sizes, tool count, routes and registry items re-measured");
