/**
 * Dashboard gate: the committed build in public/dashboard must exist and be
 * built from the current source.
 *
 * The build output is committed on purpose — `npx loopback-mcp-server` must not
 * need React, Tailwind or a build step. The cost of that choice is drift: edit
 * dashboard/src, forget to rebuild, and the hub happily serves last week's UI
 * with no error anywhere. This gate is the thing that notices.
 *
 * It rebuilds into a temp dir and compares, rather than trusting timestamps,
 * because a `git checkout` rewrites mtimes and would make a stale build look
 * fresh. Run: node scripts/dashboard-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BUILT = join(ROOT, "public", "dashboard");
const SRC = join(ROOT, "dashboard");
let failures = 0;

function assert(cond, msg) {
  if (cond) console.log(`✅ ${msg}`);
  else {
    failures++;
    console.error(`❌ ${msg}`);
  }
}

// ---------- 1. The committed build exists and is servable ----------
assert(existsSync(join(BUILT, "index.html")), "public/dashboard/index.html is committed");
if (!existsSync(join(BUILT, "index.html"))) {
  console.error("\nDASHBOARD GATE FAILED — run: npm run dashboard:build");
  process.exit(1);
}

const html = readFileSync(join(BUILT, "index.html"), "utf-8");
assert(html.includes('id="root"'), "index.html has the React mount point");
assert(
  html.includes("lb-theme") && html.includes("prefers-color-scheme"),
  "the pre-paint theme script survived the build (no flash of wrong theme)",
);

const assetsDir = join(BUILT, "assets");
const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
const js = assets.filter((f) => f.endsWith(".js"));
const css = assets.filter((f) => f.endsWith(".css"));
assert(js.length > 0 && css.length > 0, `built assets present (${js.length} js, ${css.length} css)`);
for (const ref of [...js, ...css]) {
  assert(html.includes(ref), `index.html references ${ref}`);
}

// ---------- 2. The design system is the SHARED one ----------
// The dashboard must theme from design/tokens.css, not a private copy that can
// silently diverge from the widget and the published registry.
const cssText = css.map((f) => readFileSync(join(assetsDir, f), "utf-8")).join("\n");
const tokens = readFileSync(join(ROOT, "design", "tokens.css"), "utf-8");
const sampleTokens = ["--lb-verified", "--lb-open", "--lb-p0"];
for (const t of sampleTokens) {
  assert(tokens.includes(t), `design/tokens.css defines ${t}`);
  assert(cssText.includes(t), `the built dashboard CSS carries ${t} (shared design system)`);
}

// ---------- 3. Freshness: rebuild and compare ----------
if (!existsSync(join(SRC, "node_modules"))) {
  console.log(
    "⏭  dashboard/node_modules missing — skipping the rebuild comparison.\n" +
      "   (CI installs it; locally run: cd dashboard && npm ci)",
  );
} else {
  const TMP = join(ROOT, ".dashboard-freshness");
  rmSync(TMP, { recursive: true, force: true });
  try {
    // sync:tokens first — tokens.generated.css is a build artefact (gitignored),
    // so calling vite directly only works on a machine where a previous build
    // left one behind. That made this gate pass locally and fail in CI.
    execFileSync("npm", ["run", "sync:tokens"], { cwd: SRC, stdio: "pipe" });
    execFileSync("npx", ["vite", "build", "--outDir", TMP, "--emptyOutDir"], {
      cwd: SRC,
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (error) {
    failures++;
    console.error(`❌ dashboard source does not build: ${String(error).slice(0, 300)}`);
  }
  if (existsSync(TMP)) {
    const fresh = readdirSync(join(TMP, "assets")).sort();
    const committed = assets.sort();
    // Vite hashes content into filenames, so identical names ⇒ identical bytes.
    assert(
      JSON.stringify(fresh) === JSON.stringify(committed),
      `committed build matches the source${
        JSON.stringify(fresh) === JSON.stringify(committed)
          ? ""
          : ` — committed [${committed}] vs fresh [${fresh}]. Run: npm run dashboard:build`
      }`,
    );
    rmSync(TMP, { recursive: true, force: true });
  }
}

// ---------- 4. Size sanity ----------
const totalKb = Math.round(
  assets.reduce((sum, f) => sum + statSync(join(assetsDir, f)).size, 0) / 1024,
);
assert(totalKb < 800, `bundle is ${totalKb}KB (under the 800KB ceiling)`);

if (failures) {
  console.error(`\nDASHBOARD GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nDASHBOARD GATE PASSED 🎉  build committed, fresh, and on the shared design system");
