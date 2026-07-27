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
  // Per-BLOCK comparison. This was a whole-file substring test, which cannot
  // tell `:root` from `.dark` — so a published theme with its light and dark
  // values swapped passed green, because both values existed *somewhere* in the
  // file. Verified: swapping --lb-fixed's two values used to report a match.
  const css = readFileSync(join(ROOT, "design/tokens.css"), "utf-8");
  const squash = (s) => s.replace(/\s+/g, " ").trim();

  const blockVars = (selector) => {
    const start = css.indexOf(`${selector} {`);
    if (start === -1) return null;
    const body = css.slice(start, css.indexOf("\n}", start));
    const out = {};
    // `--*` custom properties AND color-scheme, which tokens.css declares as a
    // plain property. Matching only custom properties made the parity check
    // report a published color-scheme as "absent from tokens.css".
    for (const [, name, value] of body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)) {
      out[name.startsWith("--") ? name : `--${name}`] = squash(value);
    }
    return out;
  };

  const source = { light: blockVars(":root"), dark: blockVars(".dark") };
  const drifted = [];
  let compared = 0;
  for (const themeName of ["light", "dark"]) {
    const src = source[themeName];
    if (!src) {
      drifted.push(`${themeName}:<block missing from tokens.css>`);
      continue;
    }
    for (const [name, value] of Object.entries(theme.cssVars?.[themeName] ?? {})) {
      const want = src[`--${name}`];
      compared++;
      if (want === undefined) drifted.push(`${themeName}/${name} (absent from tokens.css)`);
      else if (want !== squash(value)) drifted.push(`${themeName}/${name}: ${squash(value)} ≠ ${want}`);
    }
  }
  // Guard the guard: a parse that compares nothing must not report a match.
  assert(compared > 0, `published theme actually declares tokens to compare (${compared})`);

  // color-scheme is not a colour variable, so iterating cssVars keys could never
  // notice it was absent: an adopter got our palette with the browser still
  // drawing light-mode scrollbars, form chrome and caret in dark.
  for (const themeName of ["light", "dark"]) {
    assert(
      theme.cssVars?.[themeName]?.["color-scheme"] === themeName,
      `published theme declares color-scheme: ${themeName}`,
    );
  }

  // A published recipe must be able to RENDER from the published theme. The
  // theme shipped only the --lb-* status tokens while loopback-components
  // consumes 45 variables, so an installing project got pins at 6x13 instead of
  // 24x24, no shadows, and Times instead of the mono face. The gate iterated
  // the theme's own keys and so could never notice what the CSS needed.
  const consumers = registry.items.filter((i) =>
    (i.files ?? []).some((f) => f.path.endsWith(".css")),
  );
  for (const item of consumers) {
    for (const file of item.files ?? []) {
      if (!file.path.endsWith(".css")) continue;
      const text = readFileSync(join(ROOT, file.path), "utf-8");
      const needed = [...new Set([...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
      // BOTH blocks. Reading only `light` meant a token deleted from the dark
      // block passed clean, and the parity walk goes registry → tokens.css so
      // nothing else looked either — an adopter would have got a 3.34:1 badge.
      // Theme-invariant tokens live in :root only, so dark is checked against
      // what the source's own .dark block actually overrides.
      const suppliedLight = new Set(Object.keys(theme.cssVars?.light ?? {}).map((k) => `--${k}`));
      const suppliedDark = new Set(Object.keys(theme.cssVars?.dark ?? {}).map((k) => `--${k}`));
      const absent = needed.filter((n) => !suppliedLight.has(n));
      assert(
        absent.length === 0,
        `published theme supplies every variable ${item.name} consumes${
          absent.length ? ` (missing ${absent.length}: ${absent.slice(0, 6).join(", ")}…)` : ` (${needed.length})`
        }`,
      );
      // Reverse direction: every token the SOURCE .dark block overrides must
      // survive into the published dark block.
      const darkSource = Object.keys(source.dark ?? {});
      const droppedDark = darkSource.filter((n) => !suppliedDark.has(n));
      assert(
        droppedDark.length === 0,
        `published dark block keeps every override tokens.css declares${
          droppedDark.length ? ` (dropped ${droppedDark.length}: ${droppedDark.slice(0, 6).join(", ")}…)` : ` (${darkSource.length})`
        }`,
      );
    }
  }
  assert(
    drifted.length === 0,
    `published theme tokens match design/tokens.css per theme block${drifted.length ? ` (drifted: ${drifted.join(", ")})` : ` (${compared} compared)`}`,
  );
}

if (failures) {
  console.error(`\nREGISTRY GATE FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nREGISTRY GATE PASSED 🎉  manifest valid, built output fresh, theme in sync");
