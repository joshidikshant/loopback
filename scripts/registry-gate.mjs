/**
 * Registry gate: the published shadcn registry must stay valid and in sync
 * with the source it claims to ship.
 *
 * Runs offline (no shadcn CLI, no network) so CI stays deterministic. The
 * authoritative schema check is `npm run registry:validate`, which uses the
 * real CLI; this gate covers the two failure modes that actually bite:
 *   1. structural drift from the documented registry contract, and
 *   2. STALENESS — public/r/*.json carrying an old copy of a source file,
 *      so consumers install something the repo no longer contains.
 *
 * Run: node scripts/registry-gate.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    failures++;
    console.error(`❌ ${msg}`);
  }
}

const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf-8"));

// ---------- 1. Source manifest ----------
const registry = readJson("registry.json");
assert(typeof registry.name === "string" && registry.name.length > 0, "registry.json declares a name");
assert(typeof registry.homepage === "string", "registry.json declares a homepage");
assert(Array.isArray(registry.items) && registry.items.length > 0, "registry.json has items");

const VALID_TYPES = new Set([
  "registry:base", "registry:block", "registry:component", "registry:file",
  "registry:font", "registry:hook", "registry:item", "registry:lib",
  "registry:page", "registry:style", "registry:theme", "registry:ui",
]);

const names = new Set();
for (const item of registry.items) {
  assert(typeof item.name === "string" && item.name.length > 0, `item has a name (${item.name ?? "?"})`);
  assert(!names.has(item.name), `item name '${item.name}' is unique`);
  names.add(item.name);
  assert(VALID_TYPES.has(item.type), `item '${item.name}' has a valid type (${item.type})`);

  for (const file of item.files ?? []) {
    assert(existsSync(join(ROOT, file.path)), `item '${item.name}' references an existing file (${file.path})`);
    // registry:file / registry:page must carry a target, and a target meant for
    // the project root needs the ~/ prefix — without it the CLI resolves it
    // against the consumer's source dir (verified: lands in src/public/).
    if (file.type === "registry:file" || file.type === "registry:page") {
      assert(typeof file.target === "string" && file.target.length > 0, `item '${item.name}' file declares a target`);
      if (file.target?.startsWith("public/") || file.target?.startsWith("app/")) {
        failures++;
        console.error(
          `❌ item '${item.name}' target '${file.target}' should be root-relative ('~/${file.target}') — ` +
            `otherwise it installs under the consumer's src/ directory`,
        );
      }
    }
  }

  // registryDependencies must not reference our own items by bare name: bare
  // names resolve against the built-in @shadcn registry and would 404.
  for (const dep of item.registryDependencies ?? []) {
    const bare = !dep.includes("/") && !dep.startsWith("@") && !dep.startsWith("http");
    assert(
      !(bare && names.has(dep)),
      `item '${item.name}' does not self-reference '${dep}' by bare name (use a URL or @namespace/name)`,
    );
  }
}

// ---------- 2. Built output exists and is fresh ----------
const BUILD_DIR = "public/r";
assert(existsSync(join(ROOT, BUILD_DIR)), `${BUILD_DIR} exists (run: npm run registry:build)`);

for (const item of registry.items) {
  const built = join(BUILD_DIR, `${item.name}.json`);
  if (!existsSync(join(ROOT, built))) {
    failures++;
    console.error(`❌ ${built} missing — run: npm run registry:build`);
    continue;
  }
  const builtItem = readJson(built);
  assert(builtItem.name === item.name, `${built} matches its source item name`);

  for (const file of item.files ?? []) {
    const builtFile = (builtItem.files ?? []).find((f) => f.path === file.path);
    if (!builtFile) {
      failures++;
      console.error(`❌ ${built} is missing file entry ${file.path}`);
      continue;
    }
    assert(
      typeof builtFile.content === "string" && builtFile.content.length > 0,
      `${built} inlines content for ${file.path} (required for static hosting)`,
    );
    const onDisk = readFileSync(join(ROOT, file.path), "utf-8");
    assert(
      builtFile.content === onDisk,
      `${built} content is in sync with ${file.path} — stale registries ship code the repo no longer has ` +
        `(regenerate: npm run registry:build)`,
    );
    assert(builtFile.target === file.target, `${built} preserves the root-relative target for ${file.path}`);
  }
}

// ---------- 3. Theme tokens agree with the design system ----------
const theme = registry.items.find((i) => i.type === "registry:theme");
if (theme) {
  // Substring comparison on normalised whitespace — the token values contain
  // regex metacharacters (parentheses, dots), so pattern-matching them is a
  // trap rather than a check.
  const squash = (s) => s.replace(/\s+/g, " ");
  const tokens = squash(readFileSync(join(ROOT, "design/tokens.css"), "utf-8"));
  const check = (vars) =>
    Object.entries(vars ?? {}).filter(([name, value]) => !tokens.includes(`--${name}: ${squash(value)};`));
  const missing = [...check(theme.cssVars?.light), ...check(theme.cssVars?.dark)];
  assert(
    missing.length === 0,
    `published theme tokens match design/tokens.css${missing.length ? ` (drifted: ${missing.map(([n]) => n).join(", ")})` : ""}`,
  );
}

if (failures) {
  console.error(`\nREGISTRY GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nREGISTRY GATE PASSED 🎉  manifest valid, built output fresh, theme in sync");
