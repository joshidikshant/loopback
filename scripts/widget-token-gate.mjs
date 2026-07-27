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
import { readdirSync, readFileSync } from "node:fs";
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
// The widget hardcodes the derived radius multipliers rather than consuming the
// tokens (it inlines `calc(var(--lb-radius) * 0.8)`), so a change to the scale
// in tokens.css could not reach it. Compare the multipliers themselves.
const RADIUS_STEPS = [
  ["RADIUS_MD", "--radius-md", 0.8],
  ["RADIUS_SM", "--radius-sm", 0.6],
];
for (const [name, token, multiplier] of RADIUS_STEPS) {
  const inWidget = new RegExp(`var ${name} = "calc\\(var\\(--lb-radius\\) \\* ([\\d.]+)\\)"`).exec(widgetJs);
  const inTokens = new RegExp(`${token}:\\s*calc\\(var\\(--radius\\) \\* ([\\d.]+)\\)`).exec(tokensCss);
  if (!inWidget || !inTokens) {
    fail(`could not compare the ${token} multiplier (widget=${!!inWidget} tokens=${!!inTokens})`);
  } else if (inWidget[1] !== inTokens[1] || Number(inTokens[1]) !== multiplier) {
    fail(`${token}: widget derives * ${inWidget[1]}, tokens.css says * ${inTokens[1]}`);
  }
}

const INVARIANT_PAIRS = [
  ["--lb-pin-size", "--lb-pin-size"],
  ["--lb-pin-radius", "--lb-pin-radius"],
  ["--lb-radius", "--radius"],
  ["--lb-font", "--lb-font"],
  // Theme-INVARIANT by design: these are drawn on the HOST page, so they must
  // not follow the widget's own light/dark choice — no single colour can be
  // guaranteed 3:1 against a background we do not control.
  ["--lb-overlay-dark", "--lb-overlay-dark"],
  ["--lb-overlay-light", "--lb-overlay-light"],
  ["--lb-scrim", "--lb-scrim"],
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

// Orphans: a token the WIDGET declares that the design system does not. The
// parity walk goes design-system → widget, so a brand-new `--lb-canary:hotpink`
// inlined into the widget was never compared against anything.
{
  const declared = { ...widgetVars("light"), ...widgetVars("dark") };
  const mapped = new Set([...PAIRS, ...SHADOW_PAIRS, ...INVARIANT_PAIRS].map(([w]) => w));
  const orphans = Object.keys(declared).filter((n) => !mapped.has(n));
  if (orphans.length) {
    for (const o of orphans) {
      fail(`widget declares ${o}, which is in no parity pair — add it to the map or remove it`);
    }
  } else {
    pass(`widget declares no unmapped tokens (${Object.keys(declared).length} checked)`);
  }
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
    // Split on `;` AND on every `{`/`}`, not just the first. Treating `}` as a
    // plain terminator merged declarations sitting inside a nested at-rule
    // block into whatever came before them, so an @media rule's contents were
    // invisible to the scan.
    if (/[;{}]/.test(raw)) {
      for (const piece of buf.split(/[{}]/)) {
        if (piece.trim()) flattened.push([piece, startLine]);
      }
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
for (const [, prop, value] of widgetCss.matchAll(/([\w-]+)\s*:\s*([^;}{]+)/g)) {
  // The widget's own token declarations are literals by necessity — it ships as
  // one file and cannot @import. Those are covered by the parity map above.
  if (WIDGET_TOKEN_DECL.test(prop)) continue;
  if (COLOUR_LITERAL.test(value)) {
    fail(`widget/loopback-widget.js hardcodes ${prop}: ${value.trim()} — use a token`);
  }
}

// A scan that examined nothing must never report clean. Emptying
// components.css used to print "uses tokens throughout" and exit 0.
const componentsDecls = [...componentsCss.matchAll(/[\w-]+\s*:\s*[^;}{]+/g)].length;
if (componentsDecls < 50) {
  fail(`design/components.css scan only saw ${componentsDecls} declarations — it is not reading the file`);
}
const widgetDecls = [...widgetCss.matchAll(/[\w-]+\s*:\s*[^;}{]+/g)].length;
if (widgetDecls < 100) {
  fail(`widget stylesheet scan only saw ${widgetDecls} declarations — it is not reading the CSS`);
}

if (hardcoded.length === 0) {
  pass(`design/components.css uses tokens throughout — no literal colours (${componentsDecls} declarations)`);
} else {
  for (const [, prop, value, line] of hardcoded) {
    fail(`design/components.css:${line} hardcodes ${prop}: ${value} — use a token`);
  }
}

// ---------- dashboard/src: the largest consumer, previously unscanned ----------
// Tailwind classes, not CSS declarations: bg-black/50, text-white, border-red-500.
// Arbitrary values carrying a literal (bg-[#fff]) count too. shadcn primitives
// are excluded — they are upstream verbatim and drift there is a sync question,
// which `shadcn add --diff` answers.
const PALETTE = "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const CLASS_LITERAL = new RegExp(
  "\\b(?:bg|text|border|ring|fill|stroke|outline|shadow|from|via|to)-(?:white|black|(?:" +
    PALETTE +
    ")-\\d{2,3})(?:/\\d{1,3})?\\b" +
    // Arbitrary values in any colour utility, hex OR function form. This
    // previously matched only bg-[#hex], so text-[oklch(...)] and
    // bg-[rgb(...)] walked straight through.
    "|\\b(?:bg|text|border|ring|fill|stroke|outline|shadow|from|via|to)-\\[(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\()[^\\]]*\\]",
  "g",
);
const appFiles = readdirSync(join(ROOT, "dashboard", "src"), { recursive: true })
  // .css too. The filter was .tsx? only, so dashboard/src/index.css — the one
  // hand-written stylesheet in the tree, and the file that maps every token —
  // was outside the sweep that reported "22 files scanned".
  .filter((f) => typeof f === "string" && /\.(tsx?|css)$/.test(f))
  // No blanket exclusion. This used to skip components/ui/ entirely on the
  // stated grounds that those files are "upstream verbatim" — false for
  // button.tsx and badge.tsx, both hand-patched off stock, and that is the pair
  // whose dark-mode contrast then broke unseen.
  .map((f) => join("dashboard", "src", f));
let appScanned = 0;
for (const rel of appFiles) {
  // Strip comments first. The scan's own first run flagged `text-white` and
  // `text-black` inside the comment in api.ts that explains why those literals
  // were wrong — a rule reporting the documentation of the bug it prevents.
  const text = readFileSync(join(ROOT, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  appScanned++;
  if (rel.endsWith(".css")) {
    // Declarations, like the components.css scan — a stylesheet has no classes
    // to match. --lb-*/shadcn token DEFINITIONS are literals by necessity.
    for (const [, prop, value] of text.matchAll(/([\w-]+)\s*:\s*([^;}{]+)/g)) {
      if (/^--/.test(prop)) continue;
      if (COLOUR_LITERAL.test(value)) {
        fail(`${rel} hardcodes ${prop}: ${value.trim()} — use a token`);
      }
    }
    continue;
  }
  for (const hit of text.match(CLASS_LITERAL) ?? []) {
    fail(`${rel} uses the literal colour class \`${hit}\` — use a token utility`);
  }
  // Inline styles too. A literal in a React style={{ color: "#f00" }} carried
  // no Tailwind class, so the class scan could never see it.
  for (const [, prop, value] of text.matchAll(
    /\b(color|background|backgroundColor|borderColor|outlineColor|fill|stroke|boxShadow)\s*:\s*(["'`][^"'`]*["'`])/g,
  )) {
    if (COLOUR_LITERAL.test(value)) {
      fail(`${rel} hardcodes ${prop}: ${value} in an inline style — use a token`);
    }
  }
}
if (appScanned < 3) fail(`dashboard/src scan only saw ${appScanned} files — it is not reading the tree`);
else pass(`dashboard/src uses token utilities throughout (${appScanned} files scanned)`);

// ---------- @theme inline: the unguarded hop ----------
// Every `lb-*` utility the dashboard USES must be mapped in index.css, or
// Tailwind emits nothing for it and the build still passes.
{
  const themeCss = readFileSync(join(ROOT, "dashboard", "src", "index.css"), "utf-8");
  const mappedUtilities = new Set(
    [...themeCss.matchAll(/--color-(lb-[\w-]+):/g)].map((m) => m[1]),
  );
  const used = new Set();
  for (const rel of appFiles) {
    if (rel.endsWith(".css")) continue;
    const text = readFileSync(join(ROOT, rel), "utf-8");
    for (const [, util] of text.matchAll(/\b(?:bg|text|border|ring|fill|stroke|outline)-(lb-[\w-]+)\b/g)) {
      used.add(util);
    }
  }
  const unmapped = [...used].filter((u) => !mappedUtilities.has(u));
  if (unmapped.length) {
    for (const u of unmapped) {
      fail(`dashboard uses \`${u}\` but index.css maps no --color-${u} — Tailwind emits nothing for it`);
    }
  } else {
    pass(`every lb-* utility the dashboard uses is mapped in @theme (${used.size} checked)`);
  }
}

if (failures) {
  console.error(`\nWIDGET TOKEN GATE FAILED — ${failures} mismatch(es)`);
  process.exit(1);
}
console.log("\nWIDGET TOKEN GATE PASSED 🎉  one design system, three surfaces, no drift");
