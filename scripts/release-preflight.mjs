/**
 * Pre-publish gate: refuse to release a commit whose CI is not green.
 *
 * Every other gate in this repo answers "is the source correct?". None of them
 * answered "did the suite actually pass on what I am about to publish?" — and
 * that gap is not hypothetical. The a11y gate went red the moment it landed
 * (d2ca476) and stayed red for sixteen consecutive runs across six days — last
 * green 623aa05 on 2026-07-26 — while 0.9.0, 0.9.1 and 0.9.2 were all published
 * on top of it. Three releases shipped two real WCAG 1.4.4/1.4.10 failures, and
 * nothing in the pipeline objected.
 *
 * `verify:release` is the mirror of this check and deliberately runs AFTER a
 * publish, against the published artifacts. By then npm versions are immutable,
 * so it can only report damage. This runs BEFORE, where refusing is still free.
 *
 * Wired as `prepublishOnly`, so `npm publish` enforces it rather than trusting
 * anyone to remember. Run it directly with:
 *
 *   node scripts/release-preflight.mjs            # checks HEAD
 *   node scripts/release-preflight.mjs --sha <sha>  # checks one commit
 *
 * It FAILS CLOSED: if CI status cannot be determined (no `gh`, no auth, no
 * network), that is a refusal, not a pass — an unknown answer is exactly the
 * state that let the last three releases through. The escape hatch is explicit
 * and auditable rather than a silent skip:
 *
 *   LOOPBACK_ALLOW_RED_CI=1 npm publish
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKFLOW = "ci.yml";

let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => {
  failures++;
  console.error(`❌ ${m}`);
};

/** No shell: argv arrays only, so nothing is interpolated into a command line. */
function run(bin, args) {
  return execFileSync(bin, args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" }).trim();
}
function tryRun(bin, args) {
  try {
    return { out: run(bin, args), err: null };
  } catch (e) {
    return { out: null, err: e.stderr?.toString().trim() || e.message };
  }
}

const argv = process.argv.slice(2);
const shaFlag = argv.indexOf("--sha");
const wantSha = shaFlag !== -1 ? argv[shaFlag + 1] : null;

if (process.env.LOOPBACK_ALLOW_RED_CI === "1") {
  console.warn(
    "\n⚠️  LOOPBACK_ALLOW_RED_CI=1 — publishing WITHOUT a green CI run.\n" +
      "   This is the override, not a pass. Say so in the release notes.\n",
  );
  process.exit(0);
}

// ── which repo ───────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const slug = (pkg.repository?.url ?? "").match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
if (!slug) {
  bad("could not read an owner/repo out of package.json repository.url");
  process.exit(1);
}

// ── which commit ─────────────────────────────────────────────────────────────
// The GitHub API matches head_sha on the FULL 40-char sha only: an
// abbreviation returns an empty run list, which is indistinguishable from
// "never tested". Resolve it locally so a short sha cannot read as untested.
const resolved = tryRun("git", ["rev-parse", wantSha ?? "HEAD"]);
if (!resolved.out) {
  bad(`could not resolve ${wantSha ?? "HEAD"} — ${resolved.err}`);
  process.exit(1);
}
let sha = resolved.out;

if (!wantSha) {

  // A dirty tree means the artifact about to be published is not the commit
  // whose CI result we are about to trust.
  const dirty = tryRun("git", ["status", "--porcelain"]);
  if (dirty.out === null) bad(`could not read git status — ${dirty.err}`);
  else if (dirty.out !== "") bad(`working tree is dirty — publishing something CI never saw:\n${dirty.out}`);
  else ok("working tree is clean, so the tarball matches the commit CI tested");

  // An unpushed commit has no CI result at all, and the run found below would
  // silently belong to some ancestor.
  const onRemote = tryRun("git", ["branch", "-r", "--contains", sha]);
  if (onRemote.out === null || onRemote.out === "") {
    bad(`${sha.slice(0, 7)} is not on any remote branch — push it, let CI run, then publish`);
  } else {
    ok(`${sha.slice(0, 7)} is pushed (${onRemote.out.split("\n")[0].trim()})`);
  }
}

// ── did CI pass on it ────────────────────────────────────────────────────────
const q = `repos/${slug}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=20`;
const res = tryRun("gh", ["api", q, "--jq", ".workflow_runs[] | \"\\(.status) \\(.conclusion) \\(.html_url)\""]);

if (res.out === null) {
  bad(
    `could not reach GitHub to check ${WORKFLOW} for ${sha.slice(0, 7)} — ${res.err}\n` +
      "   Failing closed. An unknown CI result is what shipped 0.9.0-0.9.2 on red.",
  );
} else if (res.out === "") {
  bad(`no ${WORKFLOW} run exists for ${sha.slice(0, 7)} — nothing has tested this commit`);
} else {
  const runs = res.out.split("\n").map((l) => {
    const [status, conclusion, url] = l.split(" ");
    return { status, conclusion, url };
  });
  const pending = runs.filter((r) => r.status !== "completed");
  const success = runs.filter((r) => r.conclusion === "success");
  const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== "success");

  if (pending.length) {
    bad(`${WORKFLOW} is still running for ${sha.slice(0, 7)} — wait for it\n   ${pending[0].url}`);
  } else if (!success.length) {
    bad(
      `${WORKFLOW} did not pass on ${sha.slice(0, 7)} — ${failed[0]?.conclusion ?? "no successful run"}\n` +
        `   ${failed[0]?.url ?? ""}`,
    );
  } else {
    ok(`${WORKFLOW} passed on ${sha.slice(0, 7)}`);
  }
}

if (failures) {
  console.error(
    `\nRELEASE PREFLIGHT FAILED — ${failures} check(s). Nothing was published.\n` +
      "Fix CI, or publish deliberately with LOOPBACK_ALLOW_RED_CI=1 and say so in the notes.",
  );
  process.exit(1);
}
console.log("\nRELEASE PREFLIGHT PASSED 🎉  green CI on the exact commit being published");
