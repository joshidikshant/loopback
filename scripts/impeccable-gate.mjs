/**
 * Impeccable gate: the shipped UI must stay free of design anti-patterns.
 *
 * Impeccable (pbakaus/impeccable) is a 46-rule detector for the visual tells of
 * machine-generated UI — side-tab accent borders, flat type hierarchies, glow
 * shadows, gradient text. This gate runs it over the surfaces users actually
 * see and fails the build on any finding.
 *
 * The reason this is a script and not a one-line `npx impeccable detect` in CI:
 * **a bare run exits 0 having scanned nothing.** Point it at a path that does
 * not exist, or one whose extensions it does not recognise, and it prints a
 * clean result and returns success. In CI that is indistinguishable from a
 * passing run, so the check would rot into decoration the first time a
 * directory moved. Two defences here:
 *
 *   1. Targets are explicit and existence-checked — never a bare `.`.
 *   2. A canary fixture with a known violation is scanned every run and
 *      REQUIRED to produce a finding. If the canary comes back clean the
 *      detector is not really looking, and the gate fails.
 *
 * Run: node scripts/impeccable-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CANARY = join("scripts", "impeccable", "canary.html");

// The surfaces a user's eyes land on. `public/dashboard` is the built output —
// it is what the hub actually serves, and the built CSS is where Impeccable's
// static analysis can see computed type scales and borders that are invisible
// in the Tailwind class soup of the .tsx source.
const TARGETS = ["public/dashboard", "widget", "demo", "design"];

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`❌ ${msg}`);
};
const pass = (msg) => console.log(`✅ ${msg}`);

// The locally installed, version-pinned binary — deliberately not
// `npx --yes impeccable`, which resolves to @latest. An unpinned detector means
// CI can go red overnight on a rule that shipped upstream while nobody touched
// this repo. Bumping the rule set should be a visible dependency change.
const BIN = join(ROOT, "node_modules", ".bin", "impeccable");

/** Run the detector and return findings. Throws only if the CLI itself broke. */
function detect(paths, { useConfig = true } = {}) {
  const args = ["detect", "--json", ...paths];
  if (!useConfig) args.push("--no-config");
  if (!existsSync(BIN)) throw new Error("impeccable is not installed — run: npm ci");
  let stdout;
  try {
    stdout = execFileSync(BIN, args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    // A non-zero exit is how the detector reports findings, so the payload we
    // want is on stdout even here. Only a missing/blown-up CLI has no stdout.
    stdout = error.stdout;
    if (!stdout) throw new Error(`impeccable failed to run: ${error.stderr || error.message}`);
  }
  return JSON.parse(stdout);
}

// ---------- 1. Targets exist ----------
// Guards the commonest false green: a renamed directory turning the scan into a
// no-op that still exits 0.
const present = TARGETS.filter((t) => existsSync(join(ROOT, t)));
for (const t of TARGETS) {
  if (present.includes(t)) pass(`scan target exists: ${t}`);
  else fail(`scan target is missing: ${t} — fix the path or drop it from TARGETS`);
}

// ---------- 2. Canary: prove the detector is actually detecting ----------
// Scanned with --no-config so a future project-wide ignore cannot blind it.
if (!existsSync(join(ROOT, CANARY))) {
  fail(`canary fixture is missing: ${CANARY} — the gate cannot verify itself`);
} else {
  let canaryFindings = [];
  let canaryRan = true;
  try {
    canaryFindings = detect([CANARY], { useConfig: false });
  } catch (error) {
    canaryRan = false;
    fail(String(error.message).slice(0, 200));
  }
  if (canaryRan) {
    const sawSideTab = canaryFindings.some((f) => f.antipattern === "side-tab");
    if (sawSideTab) {
      pass(`canary tripped as designed (${canaryFindings.length} finding(s)) — detector is live`);
    } else {
      fail(
        "canary came back CLEAN — the detector is not scanning, so a green result " +
          "on the real targets means nothing. Check the impeccable install and the " +
          "canary's side-tab border.",
      );
    }
  }
}

// ---------- 3. The real scan ----------
if (present.length === 0) {
  fail("no scan targets resolved — refusing to report a pass on an empty scan");
} else {
  let findings;
  try {
    findings = detect(present);
  } catch (error) {
    fail(String(error.message).slice(0, 200));
    findings = null;
  }
  if (findings) {
    if (findings.length === 0) {
      pass(`no anti-patterns across ${present.length} target(s): ${present.join(", ")}`);
    } else {
      fail(`${findings.length} anti-pattern(s) found:`);
      for (const f of findings) {
        const where = String(f.file || "?").replace(`${ROOT}/`, "");
        console.error(`     · [${f.antipattern}] ${where}${f.line ? `:${f.line}` : ""}`);
        console.error(`       ${f.description}`);
      }
      console.error(
        "\n   Fix them, or — if a finding is vendored code you do not control —\n" +
          '   scope a suppression WITH A REASON:\n' +
          '     npx impeccable ignores add-value <rule> "*" --file "<glob>" --reason "..."',
      );
    }
  }
}

if (failures) {
  console.error(`\nIMPECCABLE GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nIMPECCABLE GATE PASSED 🎉  detector verified live, shipped UI is clean");
