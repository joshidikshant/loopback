/**
 * Link gate: check the docs' links, and prove the check actually looked.
 *
 * The workflow step this replaces had been green since the day it was added
 * without ever checking a single link. Two independent reasons, both silent:
 *
 *   1. `linkinator README.md docs integrations` takes ONE path. The extra
 *      arguments were ignored, and the run reported success.
 *   2. `--skip "127.0.0.1|localhost|^#|shields.io"` is matched against every
 *      URL including the ROOT linkinator serves the files from — which is
 *      http://127.0.0.1:<random-port>/. The skip matched the root, so the crawl
 *      never started. On its own that pattern took the scan from 24 links to 0,
 *      and "Successfully scanned 0 links" exits 0.
 *
 * A link checker that scans nothing is worse than no link checker: it is a
 * green tick that means nothing. So this asserts a MINIMUM link count per
 * target — the failure mode was never a broken link, it was an empty crawl.
 *
 * The localhost skip is anchored to the two ports the docs actually document
 * (5173 demo, 7077 hub) so it cannot match linkinator's own random root port.
 *
 * Run: node scripts/link-gate.mjs
 */
import { execFileSync } from "node:child_process";

// Minimums are floors, not exact counts — docs grow. They exist to catch a
// crawl that collapsed to nothing, which is the failure that actually happened.
const TARGETS = [
  { glob: "README.md", min: 15 },
  { glob: "docs/*.md", min: 5 },
  { glob: "integrations/*.md", min: 3 },
];

// Only the documented localhost endpoints, never a bare host: a bare 127.0.0.1
// also matches the server linkinator itself spins up.
const SKIP = "^https?://(127\\.0\\.0\\.1|localhost):(5173|7077)";

let failures = 0;

for (const { glob, min } of TARGETS) {
  let out;
  try {
    out = execFileSync(
      "npx",
      ["--yes", "linkinator", glob, "--markdown", "--directory-listing", "--skip", SKIP, "--format", "json"],
      { encoding: "utf-8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (e) {
    // linkinator exits non-zero when it finds broken links; the JSON is still
    // on stdout, so parse it rather than reporting a bare exit code.
    out = e.stdout?.toString() ?? "";
    if (!out) {
      failures++;
      console.error(`❌ ${glob}: linkinator produced no output — ${e.message}`);
      continue;
    }
  }

  let report;
  try {
    report = JSON.parse(out);
  } catch {
    failures++;
    console.error(`❌ ${glob}: could not parse linkinator output`);
    continue;
  }

  const links = report.links ?? [];
  const broken = links.filter((l) => l.state === "BROKEN");
  const scanned = links.filter((l) => l.state !== "SKIPPED").length;

  if (scanned < min) {
    failures++;
    console.error(
      `❌ ${glob}: scanned only ${scanned} links (expected >= ${min}) — the crawl collapsed, ` +
        "which is exactly how this check passed for weeks while looking at nothing",
    );
    continue;
  }
  if (broken.length) {
    failures++;
    console.error(`❌ ${glob}: ${broken.length} broken link(s)`);
    for (const b of broken) console.error(`     [${b.status}] ${b.url}`);
    continue;
  }
  console.log(`✅ ${glob}: ${scanned} links, none broken`);
}

if (failures) {
  console.error(`\nLINK GATE FAILED — ${failures} target(s)`);
  process.exit(1);
}
console.log("\nLINK GATE PASSED 🎉  every target actually crawled, every link resolves");
