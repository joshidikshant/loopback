/**
 * Meta-gate: prove every gate can actually FAIL.
 *
 * Twenty audit passes found the same defect nine separate times — a gate
 * reporting green on something it could not see. A passing suite is therefore
 * not evidence on its own; it is only evidence if each gate has been shown to
 * fail when the thing it guards is broken.
 *
 * That claim used to live in a ✅ column in docs/ROADMAP.md, verified by hand
 * and true only on the day it was written. This script makes it executable: for
 * each gate it applies one surgical mutation to the thing that gate protects,
 * runs the gate, and REQUIRES a non-zero exit. A gate that still passes with
 * its subject broken is decorative, and this script fails.
 *
 * Every mutation is reverted in a `finally`, including on SIGINT, so a run
 * cannot leave the tree dirty. Mutations are chosen to type-check: one that
 * breaks `tsc` would make the gate fail for the wrong reason and prove nothing,
 * so a mutation that breaks the build is itself reported as a failure.
 *
 * Commands are argv arrays run through execFileSync — no shell, nothing
 * interpolated into a command string.
 *
 * Run: npm run build && node scripts/canary-all.mjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const BACKUP = mkdtempSync(join(tmpdir(), "lb-canary-"));
const BUILD = ["npm", ["run", "build"]];
let failures = 0;
const restores = [];

function mutate(relPath, edit) {
  const abs = join(ROOT, relPath);
  const bak = join(BACKUP, relPath.replace(/[/\\]/g, "__"));
  copyFileSync(abs, bak);
  restores.push(() => copyFileSync(bak, abs));
  const before = readFileSync(abs, "utf-8");
  const after = edit(before);
  // A no-op "mutation" is the exact failure mode this script exists to catch:
  // it would run the gate against an unmodified tree and record a false pass.
  if (after === before) {
    throw new Error(`mutation for ${relPath} changed nothing — the anchor text has moved`);
  }
  writeFileSync(abs, after);
}

function restoreAll() {
  while (restores.length) restores.pop()();
}

function run([bin, args]) {
  try {
    execFileSync(bin, args, { cwd: ROOT, stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

/** Each entry: the gate, one mutation to what it guards, and any build it needs. */
const CASES = [
  {
    gate: "impeccable-gate",
    cmd: ["node", ["scripts/impeccable-gate.mjs"]],
    guards: "the detector actually scanning (the canary must trip)",
    apply: () =>
      mutate("scripts/impeccable/canary.html", (s) =>
        s.replace("border-left: 4px solid #6366f1;", "border: 1px solid #e5e5e5;"),
      ),
  },
  {
    gate: "widget-token-gate",
    cmd: ["node", ["scripts/widget-token-gate.mjs"]],
    guards: "the widget's inlined token copy matching design/tokens.css",
    apply: () =>
      mutate("design/tokens.css", (s) => s.replace("--lb-pin-size: 24px;", "--lb-pin-size: 20px;")),
  },
  {
    gate: "widget-token-gate (@theme)",
    cmd: ["node", ["scripts/widget-token-gate.mjs"]],
    guards: "every lb-* utility the dashboard uses being mapped in @theme",
    apply: () =>
      mutate("dashboard/src/views/QueueList.tsx", (s) =>
        s.replace(
          'className="mt-4 flex flex-wrap items-center gap-1.5"',
          'className="mt-4 flex flex-wrap items-center gap-1.5 bg-lb-highlight"',
        ),
      ),
  },
  {
    gate: "registry-gate",
    cmd: ["node", ["scripts/registry-gate.mjs"]],
    guards: "the published theme matching tokens.css per theme block",
    apply: () =>
      mutate("design/tokens.css", (s) =>
        s.replace("--lb-pin-size: 24px;", "--lb-pin-size: 26px;"),
      ),
  },
  {
    gate: "a11y-gate (widget responsive)",
    cmd: ["node", ["scripts/a11y-gate.mjs"]],
    guards: "the widget panel staying reachable on a short viewport",
    apply: () =>
      mutate("widget/loopback-widget.js", (s) =>
        s.replace(
          "width:min(290px,calc(100vw - 36px));max-height:calc(100vh - 76px);overflow:auto;",
          "width:290px;",
        ),
      ),
  },
  {
    gate: "a11y-gate (reduced motion)",
    cmd: ["node", ["scripts/a11y-gate.mjs"]],
    guards: "components.css keeping a still state under prefers-reduced-motion",
    apply: () =>
      mutate("design/components.css", (s) =>
        s.slice(0, s.indexOf("@media (prefers-reduced-motion: reduce) {")),
      ),
  },
  {
    gate: "smoke",
    cmd: ["npm", ["run", "-s", "smoke"]],
    build: BUILD,
    guards: "itemMarkdown carrying every field structuredContent does",
    apply: () =>
      mutate("src/format.ts", (s) =>
        s.replace("for (const [k, v] of links) lines.push(`- **${k}**: ${v}`);", "// mutated"),
      ),
  },
  {
    gate: "e2e (repro steps)",
    cmd: ["npm", ["run", "-s", "e2e"]],
    guards: "the widget capturing typed repro steps",
    apply: () =>
      mutate("widget/loopback-widget.js", (s) => s.replace(".slice(0, 20),", ".slice(0, 0),")),
  },
  {
    gate: "e2e (journey)",
    cmd: ["npm", ["run", "-s", "e2e"]],
    guards: "the widget recording the route journey",
    apply: () =>
      mutate("widget/loopback-widget.js", (s) =>
        s.replace("if (journeyBuf.length > 1) extra.journey", "if (journeyBuf.length > 99) extra.journey"),
      ),
  },
  {
    gate: "e2e (tip retires on file)",
    cmd: ["npm", ["run", "-s", "e2e"]],
    guards: "a filed report retiring the onboarding tip",
    apply: () =>
      mutate("widget/loopback-widget.js", (s) => s.replace("            tipDone();", "            void 0;")),
  },
  {
    gate: "a11y-gate (tip persistence)",
    cmd: ["node", ["scripts/a11y-gate.mjs"]],
    guards: "the retired-tip flag being honoured on load",
    apply: () =>
      mutate("widget/loopback-widget.js", (s) =>
        s.replace('if (localStorage.getItem(TIP_KEY)) tip.classList.add("done");', 'if (false) tip.classList.add("done");'),
      ),
  },
  {
    gate: "smoke (registry identity)",
    cmd: ["npm", ["run", "-s", "smoke"]],
    build: BUILD,
    guards: "package.json mcpName matching server.json name",
    apply: () =>
      mutate("server.json", (s) => s.replace("io.github.joshidikshant/loopback", "io.github.someoneelse/loopback")),
  },
  {
    gate: "smoke (registry description limit)",
    cmd: ["npm", ["run", "-s", "smoke"]],
    build: BUILD,
    guards: "server.json description fitting the registry's 100-char limit",
    apply: () =>
      mutate("server.json", (s) =>
        s.replace('"description": "', '"description": "' + "x".repeat(120)),
      ),
  },
  {
    gate: "init-gate (adopter install source)",
    cmd: ["node", ["scripts/init-gate.mjs"]],
    build: BUILD,
    guards: "init not handing adopters a git-clone MCP command",
    apply: () =>
      mutate("src/init.ts", (s) =>
        s.replace('const NPM_SPEC = "loopback-mcp-server";', 'const NPM_SPEC = "github:joshidikshant/loopback";'),
      ),
  },
  {
    gate: "init-gate (plugin channel)",
    cmd: ["node", ["scripts/init-gate.mjs"]],
    guards: "the plugin's own SKILL.md copy matching canonical",
    apply: () =>
      mutate("plugin/skills/loopback/SKILL.md", (s) =>
        s.slice(0, s.indexOf("## Attachments")) + s.slice(s.indexOf("## Filing feedback")),
      ),
  },
  {
    gate: "init-gate (canonical drift)",
    cmd: ["node", ["scripts/init-gate.mjs"]],
    guards: "the canonical skill template matching the repo's installed copy",
    apply: () =>
      mutate("skills/loopback/SKILL.md", (s) => s.replace("**Pass `agent`**", "Pass agent")),
  },
  {
    gate: "e2e (ingest rate limit)",
    cmd: ["npm", ["run", "-s", "e2e"]],
    build: BUILD,
    guards: "the open intake refusing a burst on a LAN bind",
    apply: () =>
      mutate("src/http.ts", (s) =>
        s.replace("const INGEST_MAX_PER_WINDOW = 60;", "const INGEST_MAX_PER_WINDOW = 6e9;"),
      ),
  },
  {
    gate: "e2e (LAN auth)",
    cmd: ["npm", ["run", "-s", "e2e"]],
    build: BUILD,
    guards: "a LAN bind refusing unauthenticated reads",
    apply: () =>
      // A universal allow at the top of the guard — "auth check disabled".
      // (Re-anchored once already: the rate limiter rewrote the ingest branch
      // this originally patched, and the no-op guard caught it.)
      mutate("src/http.ts", (s) =>
        s.replace(
          "    if (!options.token) return true;",
          "    if (!options.token) return true;\n    if (req.path.length >= 0) return true;",
        ),
      ),
  },
  {
    gate: "e2e",
    cmd: ["npm", ["run", "-s", "e2e"]],
    build: BUILD,
    guards: "an asset reaching the agent-facing rendering",
    apply: () =>
      mutate("src/format.ts", (s) =>
        s.replaceAll("${a.name}", "FILE").replaceAll("${a.path}", "PATH"),
      ),
  },
];

process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});

try {
  for (const c of CASES) {
    try {
      c.apply();
      if (c.build && run(c.build) !== 0) {
        failures++;
        console.error(
          `❌ ${c.gate}: the mutation broke the build, so the gate would fail for the wrong reason`,
        );
        continue;
      }
      if (run(c.cmd) !== 0) {
        console.log(`✅ ${c.gate} fails when ${c.guards} is broken`);
      } else {
        failures++;
        console.error(`❌ ${c.gate} PASSED with ${c.guards} broken — it is decorative`);
      }
    } catch (e) {
      failures++;
      console.error(`❌ ${c.gate}: ${e.message}`);
    } finally {
      restoreAll();
      if (c.build) run(c.build);
    }
  }
} finally {
  restoreAll();
  run(BUILD);
  rmSync(BACKUP, { recursive: true, force: true });
}

if (failures) {
  console.error(
    `\nCANARY SWEEP FAILED — ${failures} check(s) could not see their own subject break`,
  );
  process.exit(1);
}
console.log(`\nCANARY SWEEP PASSED 🎉  all ${CASES.length} checks fail when their subject breaks`);
