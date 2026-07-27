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

/**
 * Pull the widget's inlined custom properties for one theme.
 *
 * Light lives in the `.lb-root{...}` rule; dark lives in the `DARK_BODY`
 * constant, which the widget emits under BOTH the media query and an explicit
 * `.lb-dark` host class. Anchoring on the constant rather than on the media
 * query means the parser does not break when that emission changes shape — it
 * did, and this gate reported 51 phantom mismatches.
 */
function widgetVars(theme) {
  let slice;
  if (theme === "light") {
    const start = widgetJs.indexOf(".lb-root{display:contents");
    if (start === -1) return null;
    slice = widgetJs.slice(start, widgetJs.indexOf("var DARK_BODY", start));
  } else {
    const start = widgetJs.indexOf("var DARK_BODY");
    if (start === -1) return null;
    slice = widgetJs.slice(start, widgetJs.indexOf("var TOKENS_DARK", start));
  }
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

// Geometry counts as a token too — --lb-pin-size drifted to 22 against the
// widget's 24 precisely because it sat outside the map and was re-hardcoded as
// a literal, leaving the vanilla .lb-pin recipe under the SC 2.5.8 floor.
// These are theme-INVARIANT: tokens.css declares them once in :root, so they
// are compared against the light block only.
const INVARIANT_PAIRS = [
  ["--lb-pin-size", "--lb-pin-size"],
  ["--lb-pin-radius", "--lb-pin-radius"],
  ["--lb-radius", "--radius"],
  ["--lb-font", "--lb-font"],
];

// Shadows DO change between themes (they deepen on dark), so they belong in the
// per-theme map, not the invariant one. They were outside both.
const SHADOW_PAIRS = [
  ["--lb-shadow-sm", "--lb-shadow-sm"],
  ["--lb-shadow-md", "--lb-shadow-md"],
  ["--lb-shadow-lg", "--lb-shadow-lg"],
];

// tokens.css writes `oklch(1 0 0 / 10%)`; the widget minifies to `oklch(1 0 0/10%)`.
const norm = (v) =>
  v
    .replace(/[}"']+$/g, "")     // trailing block braces captured by the fragment scan
    .replace(/['"]/g, '"')        // the widget minifies to single quotes
    .replace(/\s*\/\s*/g, "/")   // `rgb(0 0 0 / 0.6)` vs `rgb(0 0 0/0.6)`
    .replace(/,\s*/g, ",")        // font stacks
    .replace(/\s+/g, " ")
    .trim();

for (const [theme, source] of [
  ["light", light],
  ["dark", dark],
]) {
  const inWidget = widgetVars(theme);
  if (!inWidget) {
    fail(`could not find the widget's ${theme} token block`);
    continue;
  }
  // Invariant tokens live only in :root; comparing them against .dark would
  // report a phantom "missing from tokens.css" for every one of them.
  const applicable =
    theme === "light"
      ? [...PAIRS, ...SHADOW_PAIRS, ...INVARIANT_PAIRS]
      : [...PAIRS, ...SHADOW_PAIRS];
  let checked = 0;
  for (const [widgetName, designName] of applicable) {
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
  if (checked < applicable.length)
    fail(`${theme}: only ${checked}/${applicable.length} tokens were compared`);
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

// The widget's stylesheet is the OTHER hand-written CSS surface, and it was
// scanned by nothing: reintroducing the pale-green-pin bug there passed every
// gate. Its rules live inside JS string concatenation, so pull the CSS out of
// the quoted fragments first.
const widgetCss = [...widgetJs.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
  .map((m) => m[1])
  .filter((frag) => /[:{}]/.test(frag))
  .join("\n");
// Any declaration, not just color/background: a literal hiding in a border,
// outline, box-shadow or color-mix() is the same drift.
const NAMED = "white|black|red|green|blue|gray|grey|silver|maroon|olive|lime|aqua|teal|navy|fuchsia|purple|orange|yellow|pink|brown|cyan|magenta|gold|beige|ivory|coral|salmon|khaki|indigo|violet|tan|azure";
const COLOUR_LITERAL = new RegExp(
  "(oklch\\(\\s*[\\d.]|oklab\\(|lab\\(|lch\\(|color\\(|#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\b(?:" + NAMED + ")\\b)",
);
const hardcoded = [];
// Scan DECLARATIONS, not lines. The previous version only matched a line that
// *starts* with a declaration — and every rule in this file that carries a
// colour is written on one line (`.lb-pin--fixed { background: …; color: …; }`),
// so all 12 badge/pin rules and all 4 severity rules were skipped. The check
// could not see the exact block its own header cites as its reason to exist.
// Flatten first: a per-LINE scan missed any literal sitting on the continuation
// line of a multi-line declaration (`box-shadow: 0 2px 8px\n  rgb(...)`).
// Track the original line number for the message.
const flattened = [];
{
  let buf = "";
  let startLine = 1;
  componentsCss.split("\n").forEach((raw, i) => {
    if (!buf) startLine = i + 1;
    buf += (buf ? " " : "") + raw.trim();
    if (raw.includes(";") || raw.includes("}")) {
      flattened.push([buf, startLine]);
      buf = "";
    }
  });
  if (buf) flattened.push([buf, startLine]);
}
flattened.forEach(([line, lineNo]) => {
  const n = lineNo - 1;
  // Strip selectors and braces, then split the remaining declarations.
  const body = line.replace(/^[^{]*\{/, "").replace(/\}\s*$/, "");
  for (const decl of body.split(";")) {
    const m = decl.match(/^\s*([\w-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    if (!COLOUR_LITERAL.test(m[2])) continue;
    hardcoded.push([null, m[1], m[2].trim(), n + 1]);
  }
});
// Same scan over the widget's inlined stylesheet. Its own token DECLARATIONS
// are literals by necessity (it cannot @import), so only rules that CONSUME a
// colour are checked — declarations are matched by the parity map above.
// EVERY property, not an allowlist. The widget's real CSS carries colour inside
// `border:`, `outline:` and `box-shadow:` shorthands, and all three were exempt.
const WIDGET_TOKEN_DECL = /^--lb-/;
for (const [, prop, value] of widgetCss.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;}]+)/g)) {
  // The widget's own token declarations are literals by necessity — it ships as
  // one file and cannot @import. Those are covered by the parity map above.
  if (WIDGET_TOKEN_DECL.test(prop)) continue;
  if (COLOUR_LITERAL.test(value)) {
    fail(`widget/loopback-widget.js hardcodes ${prop}: ${value.trim()} — use a token`);
  }
}

if (hardcoded.length === 0) {
  pass("design/components.css uses tokens throughout — no literal colours");
} else {
  for (const [, prop, value, line] of hardcoded) {
    fail(`design/components.css:${line} hardcodes ${prop}: ${value} — use a token`);
  }
}

if (failures) {
  console.error(`\nWIDGET TOKEN GATE FAILED — ${failures} mismatch(es)`);
  process.exit(1);
}
console.log("\nWIDGET TOKEN GATE PASSED 🎉  one design system, three surfaces, no drift");
