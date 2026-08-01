/**
 * Release verification: prove the three distribution channels work by USING
 * them, against what is actually published.
 *
 * The gates in CI verify the source. Nothing verified what an adopter receives,
 * and that gap has already cost real bugs — every one of them found by running
 * the channel rather than reading it:
 *
 *   - `integrations/` was missing from the npm `files` whitelist, so `init`
 *     crashed from the tarball while every source-side gate stayed green;
 *   - the canonical skill template shipped a pre-attachments playbook that the
 *     repo's own installed copy did not have;
 *   - the Claude Code plugin shipped a 0.8.0 manifest two releases late, a
 *     stale playbook, and an install source that git-cloned and rebuilt from
 *     source on every cold start.
 *
 * This is deliberately NOT a per-push gate: it needs the network and it tests
 * PUBLISHED artifacts, so on a PR it would either pass while the branch is
 * broken or fail for reasons the branch did not cause. Run it after publishing.
 *
 *   npm run verify:release
 *
 * Exit code is non-zero if any channel is broken.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf-8"));
const VERSION = pkg.version;
const NPM_NAME = pkg.name;
const MCP_NAME = pkg.mcpName;

let failures = 0;
const temps = [];

function check(cond, msg) {
  if (cond) {
    console.log(`✅ ${msg}`);
  } else {
    failures++;
    console.error(`❌ ${msg}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}

function tempDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `lb-release-${tag}-`));
  temps.push(d);
  return d;
}

/** No shell: argv arrays only, so nothing is interpolated into a command line. */
function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: "utf-8", stdio: "pipe", ...opts });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Speak real MCP over stdio to a command and exercise the loop.
 *
 * Asserting that a process merely STARTS proves nothing — the whole point is
 * that a client can hand it work, so this initializes, lists tools, and files
 * an item, reading the id back out.
 */
function mcpHandshake(bin, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP handshake timed out after 90s"));
    }, 90_000);

    let buf = "";
    const pending = [];
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const next = pending.shift();
        if (next) next(JSON.parse(line));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // A command that spawns fine but then dies — `npx` resolving a package that
    // does not exist is the realistic case — otherwise sat here until the 90s
    // timeout and reported "timed out", which describes the symptom and hides
    // the cause. Found by canarying this script with a bogus package name.
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") return; // our own teardown after a clean run
      clearTimeout(timer);
      reject(new Error(`process exited (code ${code}) before completing the MCP handshake`));
    });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const ask = (msg) =>
      new Promise((res) => {
        pending.push(res);
        send(msg);
      });

    (async () => {
      const init = await ask({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "release-verify", version: "1" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const called = await ask({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "loopback_submit_feedback",
          arguments: {
            project: "release-verify",
            type: "ui",
            severity: "p3",
            title: "Filed by release verification",
            body: "Proves a client can hand this server work, not just start it.",
            reporter: "agent",
          },
        },
      });
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({
        serverInfo: init.result?.serverInfo,
        tools: tools.result?.tools ?? [],
        callText: called.result?.content?.[0]?.text ?? "",
        callError: called.error ?? called.result?.isError,
      });
    })().catch((e) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(e);
    });
  });
}

async function main() {
  console.log(`Verifying published release: ${NPM_NAME}@${VERSION}  (${MCP_NAME})`);

  // ── 1. npm ────────────────────────────────────────────────────────────────
  section("npm");
  const meta = await getJson(`https://registry.npmjs.org/${NPM_NAME}/${VERSION}`);
  // A miss returns 200 with a plain STRING body ("version not found: x"), not a
  // 404 — so a truthy check on the response would sail straight past it.
  const published = meta.status === 200 && typeof meta.body === "object";
  check(published, `${NPM_NAME}@${VERSION} is on the registry${published ? "" : ` — ${JSON.stringify(meta.body)}`}`);
  if (!published) {
    console.error("\n  Publish first: npm publish --otp=<code>");
    return;
  }

  // The MCP Registry proves ownership by reading exactly this field and
  // comparing it to server.json's name. It is the reason 0.9.0 had to be
  // superseded, and npm versions are immutable, so a miss costs a version.
  check(
    meta.body.mcpName === server.name,
    `published mcpName equals server.json name (${meta.body.mcpName ?? "ABSENT"} vs ${server.name})`,
  );

  const distTag = await getJson(`https://registry.npmjs.org/${NPM_NAME}`);
  check(
    distTag.body?.["dist-tags"]?.latest === VERSION,
    `dist-tags.latest points at ${VERSION} (got ${distTag.body?.["dist-tags"]?.latest})`,
  );

  // ── 2. cold install from the registry ─────────────────────────────────────
  section("cold install (npm → init → hub → MCP)");
  const cold = tempDir("cold");
  run("npm", ["init", "-y"], { cwd: cold });
  run("npm", ["install", `${NPM_NAME}@${VERSION}`, "--cache", join(cold, ".npmcache")], {
    cwd: cold,
    timeout: 300_000,
  });
  const installed = JSON.parse(
    readFileSync(join(cold, "node_modules", NPM_NAME, "package.json"), "utf-8"),
  );
  check(installed.version === VERSION, `installs ${VERSION} from the registry (got ${installed.version})`);
  check(installed.mcpName === MCP_NAME, `the installed package carries mcpName (${installed.mcpName ?? "ABSENT"})`);

  const bin = join(cold, "node_modules", ".bin", NPM_NAME);
  run(bin, ["init", "--project", "release-verify", "--write"], { cwd: cold });
  // Every file init claims to write. A tarball missing `integrations/` or
  // `skills/` fails HERE and nowhere else — it is invisible to every gate that
  // reads the repo instead of the package.
  for (const rel of [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".mcp.json",
    join(".claude", "skills", "loopback", "SKILL.md"),
  ]) {
    check(existsSync(join(cold, rel)), `init writes ${rel} from the tarball`);
  }
  const coldSkill = readFileSync(join(cold, ".claude", "skills", "loopback", "SKILL.md"), "utf-8");
  check(
    coldSkill.includes("Attachments — reference vs asset") && coldSkill.includes("Pass `agent`"),
    "the tarball's playbook carries the attachments contract and the agent= guidance",
  );
  check(
    readFileSync(join(cold, "AGENTS.md"), "utf-8").includes("release-verify"),
    "init threads the project slug into the rendered playbook",
  );

  // Run the command `init` ACTUALLY WROTE, not a path this script composes.
  // An adversarial audit reproduced the false green: with init patched to emit
  // `npx -y github:…`, every check in this section still passed, because the
  // handshake below used a hand-built path and `.mcp.json` was only
  // existence-checked. The plugin section 40 lines down already did this right.
  const coldConfig = JSON.parse(readFileSync(join(cold, ".mcp.json"), "utf-8"));
  const coldEntry = coldConfig.mcpServers?.loopback;
  check(!!coldEntry?.command, "init's .mcp.json registers a launchable loopback server");
  check(
    !JSON.stringify(coldEntry ?? {}).includes("github:"),
    `init does not point an adopter at a git clone (${JSON.stringify(coldEntry?.args ?? [])})`,
  );
  const coldMcp = await mcpHandshake(coldEntry.command, coldEntry.args, cold, {
    LOOPBACK_DB: join(cold, "cold.db"),
  });
  check(
    coldMcp.serverInfo?.version === VERSION,
    `the installed server reports ${VERSION} over MCP (got ${coldMcp.serverInfo?.version})`,
  );
  // By name, not count: a rename swaps one tool for another and the
  // cardinality never moves. resolve_feedback is the write that turns the
  // reporter's pin green — the product's whole thesis.
  const REQUIRED_TOOLS = [
    "loopback_submit_feedback", "loopback_list_feedback", "loopback_get_feedback",
    "loopback_claim_feedback", "loopback_update_status", "loopback_add_comment",
    "loopback_link_change", "loopback_resolve_feedback", "loopback_update_feedback",
    "loopback_get_stats",
  ];
  const coldNames = new Set(coldMcp.tools.map((t) => t.name));
  const missingTools = REQUIRED_TOOLS.filter((t) => !coldNames.has(t));
  check(
    missingTools.length === 0 && coldMcp.tools.length === REQUIRED_TOOLS.length,
    `every named tool is exposed (${coldMcp.tools.length}/${REQUIRED_TOOLS.length}${missingTools.length ? `, missing ${missingTools.join(", ")}` : ""})`,
  );
  check(
    !coldMcp.callError && /^Created fb_/.test(coldMcp.callText),
    `a client can file an item through it (${coldMcp.callText.split("\n")[0].slice(0, 52)})`,
  );

  // ── 3. MCP Registry ───────────────────────────────────────────────────────
  section("MCP Registry");
  const reg = await getJson(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(MCP_NAME)}`,
  );
  const servers = reg.body?.servers ?? reg.body?.data ?? [];
  const entry = servers
    .map((s) => ({ core: s.server ?? s, meta: s._meta?.["io.modelcontextprotocol.registry/official"] ?? {} }))
    .find((s) => s.core?.name === MCP_NAME);
  check(!!entry, `${MCP_NAME} is listed`);
  if (entry) {
    check(entry.meta.status === "active", `listing status is active (got ${entry.meta.status})`);
    check(
      entry.core.version === VERSION,
      `the listing points at ${VERSION} (got ${entry.core.version}) — re-run mcp-publisher publish after a release`,
    );
    const npmPkg = (entry.core.packages ?? []).find((p) => p.registryType === "npm");
    check(
      npmPkg?.identifier === NPM_NAME && npmPkg?.version === VERSION,
      `the listing resolves to npm ${NPM_NAME}@${VERSION} (got ${npmPkg?.identifier}@${npmPkg?.version})`,
    );
  }

  // ── 4. Claude Code plugin ─────────────────────────────────────────────────
  section("Claude Code plugin");
  const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf-8"));
  const pluginEntry = marketplace.plugins.find((p) => p.name === "loopback");
  check(!!pluginEntry, "marketplace.json declares the loopback plugin");
  check(
    !!pluginEntry && existsSync(join(ROOT, pluginEntry.source)),
    `the marketplace source resolves (${pluginEntry?.source})`,
  );

  const pluginMcp = JSON.parse(readFileSync(join(ROOT, "plugin", ".mcp.json"), "utf-8"));
  const entryCmd = pluginMcp.mcpServers?.loopback;
  check(!!entryCmd, "plugin/.mcp.json registers a loopback server");

  // The command an adopter's client will actually run, executed from an empty
  // directory. Reading the JSON only proves the string is what we typed.
  if (entryCmd) {
    const pluginDir = tempDir("plugin");
    let handshake = null;
    let err = null;
    try {
      handshake = await mcpHandshake(entryCmd.command, entryCmd.args, pluginDir, {
        LOOPBACK_DB: join(pluginDir, "plugin.db"),
      });
    } catch (e) {
      err = e;
    }
    check(
      !!handshake && !err,
      `\`${entryCmd.command} ${entryCmd.args.join(" ")}\` speaks MCP from an empty directory${err ? ` — ${err.message}` : ""}`,
    );
    if (handshake) {
      check(
        handshake.serverInfo?.version === VERSION,
        `the plugin's command resolves to ${VERSION} (got ${handshake.serverInfo?.version}) — a stale npm publish shows up here`,
      );
      const pluginNames = new Set(handshake.tools.map((t) => t.name));
      const pluginMissing = REQUIRED_TOOLS.filter((t) => !pluginNames.has(t));
      check(
        pluginMissing.length === 0,
        `the plugin's server exposes every named tool (${handshake.tools.length}${pluginMissing.length ? `, missing ${pluginMissing.join(", ")}` : ""})`,
      );
      check(
        !handshake.callError && /^Created fb_/.test(handshake.callText),
        "a client can file an item through the plugin's registered command",
      );
    }
  }
}

main()
  .catch((e) => {
    failures++;
    console.error(`\n❌ ${e.stack ?? e.message ?? e}`);
  })
  .finally(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    if (failures) {
      console.error(`\nRELEASE VERIFICATION FAILED — ${failures} check(s)`);
      process.exit(1);
    }
    console.log("\nRELEASE VERIFICATION PASSED 🎉  npm, MCP Registry and the plugin all work from a clean directory");
  });
