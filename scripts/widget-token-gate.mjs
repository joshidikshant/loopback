/**
 * Widget token parity gate: the widget's inlined tokens must equal design/tokens.css.
 *
 * The widget ships as ONE file injected into arbitrary pages, so it cannot
 * `@import` the design system — it carries a hand-written transcription of the
 * token values instead. That copy is the only surface with no automatic link
 * back to the source, and it had already drifted before this gate existed:
 * `--lb-border` was 15% against tokens.css's 10%, and `--lb-input` 20% against
 * 15%, in dark mode. Nothing anywhere would have told us.
 *
 * The dashboard gets parity for free (`npm run sync:tokens` copies the file)
 * and the published registry is generated. This closes the third surface.
 *
 * Run: node scripts/widget-token-gate.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const tokensCss = readFileSync(join(ROOT, "design", "tokens.css"), "utf-8");
const widgetJs = readFileSync(join(ROOT, "widget", "loopback-widget.js"), "utf-8");

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`❌ ${m}`);
};
const pass = (m) => console.log(`✅ ${m}`);

/** Pull `--name: value;` pairs out of one CSS block. */
function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return null;
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out[name] = value.trim().replace(/\s+/g, " ");
  }
  return out;
}

/** Pull the widget's inlined custom properties for one theme. */
function widgetVars(themeMarker) {
  const start = widgetJs.indexOf(themeMarker);
  if (start === -1) return null;
  // Dark starts at the media query; light runs from .lb-root to that query.
  const darkAt = widgetJs.indexOf("@media (prefers-color-scheme:dark)");
  const slice =
    themeMarker === ".lb-root{display:contents"
      ? widgetJs.slice(start, darkAt)
      : widgetJs.slice(start, widgetJs.indexOf('";', start));
  const out = {};
  for (const [, name, value] of slice.matchAll(/(--lb-[\w-]+):\s*([^;"]+)/g)) {
    out[name] = value.trim().replace(/\s+/g, " ");
  }
  return out;
}

const light = block(tokensCss, ":root");
const dark = block(tokensCss, ".dark");
if (!light || !dark) {
  console.error("❌ could not parse design/tokens.css — :root or .dark block missing");
  process.exit(1);
}

// The widget names things `--lb-*`; the design system uses shadcn's names for
// the generic roles. This pairing is the contract, and it is deliberate:
// --lb-bg is the widget's FLOATING SURFACE, so it tracks --popover (a panel
// over a host page), never --background.
const PAIRS = [
  ["--lb-bg", "--popover"],
  ["--lb-fg", "--popover-foreground"],
  ["--lb-muted", "--muted"],
  ["--lb-muted-fg", "--muted-foreground"],
  ["--lb-border", "--border"],
  ["--lb-input", "--input"],
  ["--lb-primary", "--primary"],
  ["--lb-primary-fg", "--primary-foreground"],
  ["--lb-ring", "--ring"],
  ["--lb-open", "--lb-open"],
  ["--lb-open-fg", "--lb-open-foreground"],
  ["--lb-triaged", "--lb-triaged"],
  ["--lb-triaged-fg", "--lb-triaged-foreground"],
  ["--lb-in-progress", "--lb-in-progress"],
  ["--lb-in-progress-fg", "--lb-in-progress-foreground"],
  ["--lb-fixed", "--lb-fixed"],
  ["--lb-fixed-fg", "--lb-fixed-foreground"],
  ["--lb-verified", "--lb-verified"],
  ["--lb-verified-fg", "--lb-verified-foreground"],
  ["--lb-wontfix", "--lb-wontfix"],
  ["--lb-wontfix-fg", "--lb-wontfix-foreground"],
  ["--lb-highlight", "--lb-highlight"],
];

// tokens.css writes `oklch(1 0 0 / 10%)`; the widget minifies to `oklch(1 0 0/10%)`.
const norm = (v) => v.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();

for (const [theme, source, marker] of [
  ["light", light, ".lb-root{display:contents"],
  ["dark", dark, "@media (prefers-color-scheme:dark)"],
]) {
  const inWidget = widgetVars(marker);
  if (!inWidget) {
    fail(`could not find the widget's ${theme} token block`);
    continue;
  }
  let checked = 0;
  for (const [widgetName, designName] of PAIRS) {
    const want = source[designName];
    const got = inWidget[widgetName];
    if (want === undefined) {
      fail(`${theme}: design/tokens.css has no ${designName} (the gate's map is stale)`);
      continue;
    }
    if (got === undefined) {
      fail(`${theme}: widget is missing ${widgetName}`);
      continue;
    }
    checked++;
    if (norm(got) !== norm(want)) {
      fail(`${theme}: ${widgetName} = ${got}  ≠  ${designName} = ${want}`);
    }
  }
  // Guard the guard: a parse that silently matches nothing must not pass.
  if (checked < PAIRS.length) fail(`${theme}: only ${checked}/${PAIRS.length} tokens were compared`);
  else pass(`${theme}: all ${checked} widget tokens match design/tokens.css`);
}

// The six status colours must stay mutually distinct, in both themes. They were
// not: open/triaged and fixed/verified were byte-identical pairs, which
// collapsed a six-state model into four — and meant the pin went green when an
// agent CLAIMED a fix rather than when one was verified.
for (const [theme, source] of [
  ["light", light],
  ["dark", dark],
]) {
  const statuses = ["open", "triaged", "in-progress", "fixed", "verified", "wontfix"];
  const seen = new Map();
  for (const s of statuses) {
    const v = source[`--lb-${s}`];
    if (!v) {
      fail(`${theme}: --lb-${s} is missing from design/tokens.css`);
      continue;
    }
    if (seen.has(v)) fail(`${theme}: --lb-${s} is identical to --lb-${seen.get(v)} (${v})`);
    else seen.set(v, s);
  }
  if (seen.size === statuses.length) pass(`${theme}: all ${statuses.length} status colours are distinct`);
}

// design/components.css is the fourth token consumer and the one that caused a
// real regression: it hardcoded `color: oklch(0.985 0 0)` on every .lb-pin,
// which was survivable while all six status colours were dark and broke the
// moment --lb-fixed became a pale green. Nothing was checking this file.
const componentsCss = readFileSync(join(ROOT, "design", "components.css"), "utf-8");
const hardcoded = [
  ...componentsCss.matchAll(/^\s*(color|background(?:-color)?)\s*:\s*(oklch\([^)]*\)|#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/gm),
];
if (hardcoded.length === 0) {
  pass("design/components.css uses tokens throughout — no literal colours");
} else {
  for (const [, prop, value] of hardcoded) {
    fail(`design/components.css hardcodes ${prop}: ${value} — use the paired token`);
  }
}

if (failures) {
  console.error(`\nWIDGET TOKEN GATE FAILED — ${failures} mismatch(es)`);
  process.exit(1);
}
console.log("\nWIDGET TOKEN GATE PASSED 🎉  one design system, three surfaces, no drift");
