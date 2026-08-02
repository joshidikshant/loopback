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
      stdio: ["pipe", "pipe", "pipe"],
    });

    // stderr was "ignore". A server that dies during startup — node:sqlite
    // unavailable, SQLITE_CANTOPEN on the db path, a dist file that never made
    // it into the tarball — then reported a bare exit code or a bare 90s
    // timeout, and the only way to learn the cause was to re-run by hand. Keep
    // the TAIL: the reason is in the last lines, and a full stack buries it.
    let errTail = "";
    child.stderr.on("data", (chunk) => {
      errTail = (errTail + chunk).slice(-2000);
    });
    const withCause = (msg) => {
      const lines = errTail.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      // Prefer the line that NAMES the failure. A blind tail returned the last
      // four lines of a thrown Error's serialised properties — "code: '" and
      // friends — which is the least informative part of the dump. Node writes
      // the message first and the object dump after, so the tail is exactly
      // wrong. Fall back to the tail only when nothing looks like an error.
      const named = lines.filter((l) => /error|fatal|cannot|unable|EACCES|ENOENT|SQLITE/i.test(l));
      const pick = (named.length ? named : lines).slice(0, 3).join(" ⏎ ");
      return pick ? `${msg} — stderr: ${pick.slice(0, 300)}` : `${msg} (nothing on stderr)`;
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(withCause("MCP handshake timed out after 90s")));
    }, 90_000);

    const abort = (err) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };

    let buf = "";
    const pending = [];
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // This parse was unguarded, and it runs in a stream listener — OUTSIDE
        // the promise — so one non-JSON line threw past the .catch below, past
        // main()'s finally, and left temp dirs and the child behind. A server
        // writing anything but JSON-RPC on stdio is broken: name the line and
        // tear down through the normal path.
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          abort(new Error(withCause(`non-JSON-RPC line on stdout: ${JSON.stringify(line.slice(0, 120))}`)));
          return;
        }
        // Pairing is by arrival order, which holds only because every ask() is
        // awaited before the next send. What does NOT hold is that everything
        // arriving is a response: a server-initiated notification carries no id
        // and would be handed to whoever is waiting, reporting a healthy server
        // as broken.
        if (msg.id === undefined) continue;
        const next = pending.shift();
        if (next) next(msg);
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
      // Reject from 'close', not here: 'exit' can fire while the stderr pipe
      // still holds the very lines explaining the exit, which would leave the
      // capture above reporting "nothing on stderr" — a diagnostic that is
      // only ever empty is worse than none. Bounded, because a grandchild
      // (npx → node) can hold that pipe open after its parent goes.
      const fail = () =>
        reject(new Error(withCause(`process exited (code ${code}) before completing the MCP handshake`)));
      const late = setTimeout(fail, 250);
      child.once("close", () => {
        clearTimeout(late);
        fail();
      });
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
    })().catch(abort);
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
  // All NINE renderings src/init.ts writes, not the five this loop used to
  // carry under a comment claiming it covered every one. The four it skipped —
  // .codex/config.toml, .gemini/settings.json, the Gemini command, and the
  // Codex skill install — are the entire onboarding of every Codex and Gemini
  // adopter, so a published init that stopped writing them was green here.
  // A tarball missing `integrations/` or `skills/` also fails HERE and nowhere
  // else: it is invisible to every gate that reads the repo, not the package.
  for (const rel of [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".mcp.json",
    join(".codex", "config.toml"),
    join(".gemini", "settings.json"),
    join(".gemini", "commands", "loopback.toml"),
    join(".claude", "skills", "loopback", "SKILL.md"),
    join(".agents", "skills", "loopback", "SKILL.md"),
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
  // Guarded like the plugin handshake below. Unguarded, a rejection here — a
  // server that dies on startup is the realistic case — propagated to the outer
  // .catch and ENDED the run: the registry and plugin sections never executed.
  // A dead cold install is one red check, not a lost run.
  let coldMcp = null;
  let coldErr = null;
  try {
    coldMcp = await mcpHandshake(coldEntry.command, coldEntry.args ?? [], cold, {
      LOOPBACK_DB: join(cold, "cold.db"),
    });
  } catch (e) {
    coldErr = e;
  }
  check(
    !!coldMcp,
    `\`${coldEntry?.command} ${(coldEntry?.args ?? []).join(" ")}\` speaks MCP from the cold install${coldErr ? ` — ${coldErr.message}` : ""}`,
  );
  if (!coldMcp) coldMcp = { serverInfo: {}, tools: [], callText: "", callError: true };
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

  // ── 2b. the documented npx path ───────────────────────────────────────────
  section("npx onboarding (the command the README documents)");
  // README line 108 tells an adopter to onboard with `npx loopback-mcp-server
  // init …`, and that is a DIFFERENT branch of init's serverCommand() than the
  // node_modules/.bin run above: it emits `npx -y <spec>` only when its own
  // entry path contains an `_npx` segment. That branch wrote
  // `npx -y github:joshidikshant/loopback` — a git clone plus a full tsc build
  // on every cold MCP start — and shipped that way through 0.9.1.
  // scripts/init-gate.mjs covers the branch against SOURCE with an _npx-shaped
  // fixture. Nothing covered it against the tarball an adopter actually gets,
  // which is the only artifact that can still be wrong after a bad publish.
  const NPX_SPEC = NPM_NAME;
  const npxProject = tempDir("npx");
  const npxCache = tempDir("npx-cache");
  // A private cache is what makes this a COLD adopter run: against the
  // operator's ~/.npm, npx can satisfy the spec from an `_npx` dir left by an
  // earlier release and never contact the registry. The private prefix hides a
  // global `npm i -g loopback-mcp-server`, which npx would otherwise prefer
  // over its cache — that resolution never passes through `_npx`, so it would
  // quietly send this whole block down the branch section 2 already covers.
  const npxEnv = { ...process.env, npm_config_cache: npxCache, npm_config_prefix: tempDir("npx-prefix") };
  // Unpinned and without `-y`, because that is the documented command verbatim;
  // section 1 already established that `latest` is VERSION. stdin is closed
  // because npx asks "Ok to proceed?" before installing when it has a TTY, and
  // a prompt no one can answer would hang to the timeout instead of failing.
  run("npx", [NPX_SPEC, "init", "--project", "release-verify", "--write"], {
    cwd: npxProject,
    env: npxEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });

  const npxEntry = JSON.parse(readFileSync(join(npxProject, ".mcp.json"), "utf-8")).mcpServers?.loopback;
  // Guard the guard, on the parsed command field. If npx resolved the CLI from
  // anywhere other than its `_npx` cache, init renders `node <abs path>` and
  // every assertion below would pass while testing the wrong branch. init-gate
  // made this exact mistake twice — once by running the CLI from a stable path,
  // once by matching "npx" against a temp directory's own name.
  check(
    npxEntry?.command === "npx",
    `the documented command reached the ephemeral (_npx) branch — rendered command is '${npxEntry?.command}', expected 'npx'`,
  );

  // Each config is produced by a separate renderer, so a serialization bug can
  // put the right spec in one and garbage in another; a Codex or Gemini adopter
  // would never show up in a .mcp.json-only check. Parsed, not grepped: the
  // spec has to be in the args field, not merely somewhere in the file.
  const codexBlock = readFileSync(join(npxProject, ".codex", "config.toml"), "utf-8").split("[mcp_servers.loopback]")[1] ?? "";
  const renderedConfigs = [
    [".mcp.json", npxEntry],
    [".gemini/settings.json", JSON.parse(readFileSync(join(npxProject, ".gemini", "settings.json"), "utf-8")).mcpServers?.loopback],
    [".codex/config.toml", {
      command: codexBlock.match(/^command\s*=\s*(".*")$/m)?.[1] && JSON.parse(codexBlock.match(/^command\s*=\s*(".*")$/m)[1]),
      args: JSON.parse(codexBlock.match(/^args\s*=\s*(\[.*\])$/m)?.[1] ?? "null"),
    }],
  ];
  for (const [name, cfg] of renderedConfigs) {
    const spec = (cfg?.args ?? []).join(" ");
    check(
      cfg?.command === "npx" && spec.includes(NPM_NAME) && !spec.includes("github:"),
      `npx init's ${name} launches the npm package, not a git clone (${cfg?.command} ${spec})`,
    );
  }

  // Launchable, not just well-shaped. This does NOT cover the git-clone class —
  // `npx -y github:…` handshakes fine, it just clones and rebuilds first — so
  // the assertions above are what guard the spec and this one guards a tarball
  // that installs but cannot serve. Wrapped so a registry hiccup here costs one
  // red line instead of skipping the registry and plugin channels below.
  let npxHandshake = null;
  let npxErr = null;
  try {
    npxHandshake = await mcpHandshake(npxEntry.command, npxEntry.args, npxProject, {
      npm_config_cache: npxCache,
      LOOPBACK_DB: join(npxProject, "npx.db"),
    });
  } catch (e) {
    npxErr = e;
  }
  check(
    !!npxHandshake && !npxErr,
    `\`${npxEntry?.command} ${(npxEntry?.args ?? []).join(" ")}\` — the command npx init wrote — speaks MCP${npxErr ? ` — ${npxErr.message}` : ""}`,
  );
  if (npxHandshake) {
    check(
      npxHandshake.serverInfo?.version === VERSION,
      `the documented onboarding's config resolves to ${VERSION} (got ${npxHandshake.serverInfo?.version})`,
    );
    check(
      !npxHandshake.callError && /^Created fb_/.test(npxHandshake.callText),
      "a client can file an item through the config the documented npx onboarding wrote",
    );
  }


  // The section title has promised a hub since the day it was written, and not
  // one HTTP request has ever been made from the installed package. That is the
  // `integrations/` miss with a different name: a directory dropped from the
  // `files` whitelist is invisible to every gate that reads the repo. `widget`
  // and `public` are the two entries nothing above touches, and the only way to
  // ask for either is to start the hub and fetch them.
  //
  // 7077 is the developer's own hub, 7177/7180 belong to the e2e and 7191 to
  // the a11y gate. Nothing in this repo binds 7277.
  const HUB_PORT = Number(process.env.LOOPBACK_RELEASE_PORT ?? 7277);
  const HUB = `http://127.0.0.1:${HUB_PORT}`;
  // Its own slug, so `total === 1` below stays a hermeticity assertion rather
  // than an accident of which DB the stdio handshake above happened to write.
  const HUB_PROJECT = "release-verify-hub";

  // A hub this script did not start would answer every check below — out of a
  // source tree, not the tarball. Refuse rather than measure the wrong process.
  let squatter = null;
  try {
    squatter = (await getJson(`${HUB}/health`)).body;
  } catch {
    /* connection refused: the port is ours */
  }
  check(
    squatter === null,
    squatter === null
      ? `port ${HUB_PORT} is free for the installed hub`
      : `something already answers ${HUB}/health (${JSON.stringify(squatter).slice(0, 70)}) — stop it or set LOOPBACK_RELEASE_PORT; the hub checks did NOT run`,
  );

  if (squatter === null) {
    // The command README and integrations/keep-alive.md hand an adopter, run
    // from the bin npm installed — not a path into dist/ that this script
    // assembles for itself.
    //
    // LOOPBACK_DB is not a nicety: the hub defaults to ~/.loopback/loopback.db,
    // so without it a verification run files its test items straight into the
    // operator's live queue.
    const hubDb = join(cold, "hub.db");
    const hub = spawn(bin, ["--http", "--port", String(HUB_PORT)], {
      cwd: cold,
      env: { ...process.env, LOOPBACK_DB: hubDb },
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Startup failures land on stderr and nowhere else. Reporting only "never
    // came up" would describe the symptom and bury the cause — the same mistake
    // already fixed in mcpHandshake.
    let hubErr = "";
    hub.stderr.on("data", (c) => {
      hubErr += c;
    });

    try {
      let health = null;
      for (let i = 0; i < 60 && health === null; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          health = (await getJson(`${HUB}/health`)).body;
        } catch {
          /* still booting */
        }
      }
      check(
        health?.version === VERSION,
        health
          ? `the installed hub reports ${VERSION} on /health (got ${health.version})`
          : `the installed hub never answered ${HUB}/health in 15s, so the surface checks did NOT run — ${(
              hubErr.split("\n").find((l) => l.includes("Error")) ?? hubErr.trim()
            ).slice(0, 160) || "no stderr"}`,
      );

      // Everything below reads a file the hub loads off disk, so a dead hub
      // would turn one real failure into six misleading ones and push the
      // registry and plugin sections off the end of the output.
      if (health) {
        // "Something answered" is not "our package answered". Measured: on a
        // taken port this binary prints its success banner and exits 0 (the
        // listen callback fires with address() === null and the EADDRINUSE
        // error has no handler), after which a foreign hub serves every check
        // below and they all pass — verified by racing it deliberately. Liveness
        // says the responder is our child; the DB file says our child is the one
        // we configured, not one quietly writing the operator's real queue.
        check(
          hub.exitCode === null && existsSync(hubDb),
          `the hub that answered is the child we spawned (alive=${hub.exitCode === null}, own DB=${existsSync(hubDb)})`,
        );

        // 200 is not the assertion. `files` can keep `widget` while the file
        // itself is a stub, and a stub answers 200 with a perfectly valid empty
        // script. It shipped only if what arrives can mount and report.
        const widget = await getJson(`${HUB}/widget.js`);
        const widgetSrc = typeof widget.body === "string" ? widget.body : "";
        check(
          widget.status === 200 &&
            widgetSrc.length > 20_000 &&
            widgetSrc.includes("__loopbackWidgetLoaded") &&
            widgetSrc.includes("loopback-widget-host") &&
            widgetSrc.includes("/ingest"),
          `GET /widget.js serves the real capture widget (${widget.status}, ${widgetSrc.length} B)`,
        );

        // /queue and /queue/:id are both public/dashboard/index.html. A tarball
        // without `public` answers 503 "Dashboard not built" — a state the
        // adopter currently meets before the operator does.
        const queue = await getJson(`${HUB}/queue`);
        const shell = typeof queue.body === "string" ? queue.body : "";
        check(
          queue.status === 200 && shell.includes(`<div id="root">`),
          `GET /queue serves the built dashboard shell (${queue.status})`,
        );

        // Read the asset URLs OUT of the shell the hub just served. Vite hashes
        // content into these filenames, so any path hard-coded here goes stale
        // on the next build and from then on only ever proves itself.
        const assets = [...shell.matchAll(/(?:src|href)="(\/dashboard\/[^"]+)"/g)].map((m) => m[1]);
        check(assets.length >= 2, `the shell references its built assets (${assets.length} found)`);
        let bundle = "";
        for (const rel of assets) {
          const asset = await getJson(HUB + rel);
          const body = typeof asset.body === "string" ? asset.body : "";
          if (rel.endsWith(".js")) bundle = body;
          check(
            asset.status === 200 && body.length > 1000,
            `${rel} ships in the tarball (${asset.status}, ${body.length} B)`,
          );
        }
        // The one asset a size check cannot vouch for: this is the queue app
        // only if it knows how to call the hub's own list API.
        check(
          bundle.includes("/feedback?"),
          `the dashboard bundle is the queue app, not a placeholder (${bundle.length} B)`,
        );

        // The intake, which nothing above reaches. fetch directly: getJson is a
        // GET, and this is the one POST an adopter's host page ever makes. A
        // widget that arrives intact still reports into nothing if the installed
        // server cannot take the write.
        const res = await fetch(`${HUB}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: HUB_PROJECT,
            type: "ui",
            severity: "p3",
            title: "Filed by release verification over HTTP",
            body: "Proves the installed hub's intake accepts a widget-shaped report.",
            source: "widget",
            reporter: "agent",
            dom_selector: "#release-verify-anchor",
          }),
        });
        const filed = await res.json().catch(() => null);
        check(
          res.status === 201 && /^fb_/.test(filed?.id ?? ""),
          `POST /ingest accepts a widget-shaped report (${res.status}, id ${filed?.id ?? "ABSENT"})`,
        );

        // 201 only proves the body parsed. This proves it reached the store the
        // queue table and the widget's pins both read back out of.
        const listed = await getJson(`${HUB}/feedback?project=${HUB_PROJECT}&limit=5`);
        const back = (listed.body?.items ?? []).find((i) => i.id === filed?.id);
        check(
          listed.body?.total === 1 && back?.dom_selector === "#release-verify-anchor",
          `the report reads back with its pin anchor intact (total ${listed.body?.total}, selector ${back?.dom_selector ?? "ABSENT"})`,
        );
      }
    } finally {
      // In a finally, not after the last check: a throw anywhere above would
      // otherwise leave a hub holding the port and the temp DB for the rest of
      // the run.
      hub.kill("SIGKILL");
    }
  }


  // ── 3. MCP Registry ───────────────────────────────────────────────────────
  section("MCP Registry");
  const reg = await getJson(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(MCP_NAME)}`,
  );
  const servers = reg.body?.servers ?? reg.body?.data ?? [];
  // The registry keeps EVERY published version, so this endpoint returns a list.
  // A `.find()` on the name took whichever came first — 0.9.1 — and reported a
  // successful 0.9.2 publish as a failure, telling the operator to re-run a
  // command that had already worked. It passed until now only because there was
  // a single entry. Select the one the registry itself flags as latest, and fall
  // back to matching the version rather than to position.
  const all = servers
    .map((s) => ({ core: s.server ?? s, meta: s._meta?.["io.modelcontextprotocol.registry/official"] ?? {} }))
    .filter((s) => s.core?.name === MCP_NAME);
  const entry =
    all.find((s) => s.meta.isLatest === true) ?? all.find((s) => s.core.version === VERSION);
  check(!!entry, `${MCP_NAME} is listed${all.length ? ` (${all.length} version(s): ${all.map((s) => s.core.version).join(", ")})` : ""}`);
  if (entry) {
    check(
      entry.meta.isLatest === true,
      `the version flagged latest is the one being verified (latest=${all.find((s) => s.meta.isLatest)?.core.version ?? "none"})`,
    );
    check(entry.meta.status === "active", `listing status is active (got ${entry.meta.status})`);
    // The remediation hint belongs on the failure, not on every green line.
    check(
      entry.core.version === VERSION,
      entry.core.version === VERSION
        ? `the listing points at ${VERSION}`
        : `the listing points at ${entry.core.version}, not ${VERSION} — run: mcp-publisher publish`,
    );
    const npmPkg = (entry.core.packages ?? []).find((p) => p.registryType === "npm");
    check(
      npmPkg?.identifier === NPM_NAME && npmPkg?.version === VERSION,
      `the listing resolves to npm ${NPM_NAME}@${VERSION} (got ${npmPkg?.identifier}@${npmPkg?.version})`,
    );

    // Every check above this line compares strings, and a listing can pass all
    // of them while describing something no client can start. `transport` is
    // where "which npm package" becomes "how do I launch it", and nothing has
    // ever read it — not here, not smoke, not the schema.
    //
    // The schema cannot catch this. Package.transport is a LocalTransport, an
    // anyOf over stdio | streamable-http | sse, so `{"type":"streamable-http",
    // "url":…}` validates cleanly and `mcp-publisher validate` waves it
    // through. Only this repo knows the bin is a stdio process — package.json
    // `bin`, `.mcp.json`'s command/args and smoke's StdioClientTransport all
    // assume one. An adopter handed a streamable-http listing dials a URL that
    // does not exist and never spawns anything.
    const npmPkgs = (entry.core.packages ?? []).filter((p) => p.registryType === "npm");
    // Not `.find()`. That is the trap one level up in this same section — a
    // list quietly holding more than one match — and it is also the
    // precondition for the launch below: picking an entry out of an ambiguous
    // list is how you end up proving the wrong one works.
    check(npmPkgs.length === 1, `the listing offers exactly one npm package to launch (got ${npmPkgs.length})`);
    const launch = npmPkgs[0];
    check(
      launch?.transport?.type === "stdio",
      `the listing declares a stdio transport (got ${JSON.stringify(launch?.transport) ?? "ABSENT"})`,
    );

    // Absolute above, relative here. `stdio` in the listing is not enough if
    // server.json has since grown a field the registry never saw: the version
    // check only fires when the version moved, so editing transport,
    // environmentVariables or packageArguments without bumping leaves this
    // whole section green. `remotes` is compared too — it is how a listing
    // tells a client to skip the package entirely, it sits beside `packages`
    // rather than inside one, and neither side has ever been looked at. Keys
    // are sorted because mcp-publisher round-trips the JSON and key order is
    // not drift.
    const launchSurface = (s) =>
      JSON.stringify({ packages: s.packages ?? [], remotes: s.remotes ?? [] }, (_k, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
          : v,
      );
    const listingSurface = launchSurface(entry.core);
    const localSurface = launchSurface(server);
    check(
      listingSurface === localSurface,
      listingSurface === localSurface
        ? "the listing's launch surface matches server.json"
        : `the listing's launch surface has drifted from server.json — listing ${listingSurface}, local ${localSurface} — run: mcp-publisher publish`,
    );

    // A runtimeHint or an argument list would mean a client composes a
    // DIFFERENT command than the one below, and this script would then be
    // proving a launch nobody performs. Assert their absence instead of
    // branching on it — a check that quietly stops running is the defect this
    // file keeps rediscovering. If the listing ever grows launch inputs, this
    // goes red until the proof below is extended to cover them.
    const extras = {
      runtimeHint: launch?.runtimeHint,
      runtimeArguments: launch?.runtimeArguments,
      packageArguments: launch?.packageArguments,
      environmentVariables: launch?.environmentVariables,
    };
    const bare = Object.values(extras).every((v) => v === undefined);
    check(
      bare,
      bare
        ? "the listing's launch takes no inputs beyond the package spec"
        : `the listing declares launch inputs release-verify does not exercise (${JSON.stringify(extras)})`,
    );

    // And now stop reading the listing and USE it. The cold-install section
    // learned that a command this script composes proves nothing about the one
    // an adopter is handed; this is that lesson at the registry's address. A
    // client resolving an npm+stdio listing spawns `npx -y
    // <identifier>@<version>` — built from the listing's own fields, never from
    // NPM_NAME/VERSION, or the false green just moves here.
    const spec = `${launch?.identifier}@${launch?.version}`;
    const listingDir = tempDir("listing");
    let listingMcp = null;
    let listingErr = null;
    try {
      listingMcp = await mcpHandshake("npx", ["-y", spec], listingDir, {
        LOOPBACK_DB: join(listingDir, "listing.db"),
      });
    } catch (e) {
      listingErr = e;
    }
    check(
      !!listingMcp && !listingErr,
      `\`npx -y ${spec}\` — the command a client builds from this listing — speaks MCP from an empty directory${listingErr ? ` — ${listingErr.message}` : ""}`,
    );
    // Not a second tool inventory: sections 2 and 4 already prove the tarball's
    // surface. What is unproven until here is that the registry's OWN pinned
    // coordinates resolve to the release being verified.
    check(
      listingMcp?.serverInfo?.version === VERSION,
      `the listing's own coordinates launch ${VERSION} (got ${listingMcp?.serverInfo?.version})`,
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

  // ── 5. the plugin channel as GitHub serves it ─────────────────────────────
  // Section 4 is the only channel read off local disk — the one place that is
  // guaranteed to be correct. Adopters get those same files from a clone
  // (`claude plugin marketplace add joshidikshant/loopback`), so the sequence
  // bump → npm publish → mcp-publisher publish → verify:release, run before
  // `git push`, goes 4-for-4 green while GitHub still serves the previous
  // commit — an old manifest and a stale playbook, to every plugin adopter.
  section("plugin channel as GitHub serves it");

  // Hardcoded rather than read from `origin`: an operator whose origin is a fork
  // would otherwise verify their fork while adopters resolve this slug.
  const GH_SLUG = "joshidikshant/loopback";
  const PLUGIN_FILES = [
    ".claude-plugin/marketplace.json",
    "plugin/.claude-plugin/plugin.json",
    "plugin/skills/loopback/SKILL.md",
    // Section 4 handshakes the LOCAL copy of this one. Comparing the pushed copy
    // is what carries that live proof over to the command an adopter runs.
    "plugin/.mcp.json",
  ];

  // GIT_TERMINAL_PROMPT=0 so a credential prompt can never wedge the run.
  const git = (args) =>
    run("git", args, { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

  // ls-remote resolves HEAD's symref target — the default branch tip, which is
  // exactly the commit a marketplace clone checks out. Resolving it here also
  // lets the fetches below name an immutable SHA: raw.githubusercontent serves
  // branch paths with max-age=300, so reading `/main/` can report a tree that
  // was pushed four minutes ago as missing, and send the operator chasing a push
  // they already did.
  const remoteHead = git(["ls-remote", `https://github.com/${GH_SLUG}.git`, "HEAD"]).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(remoteHead)) {
    throw new Error(`could not resolve ${GH_SLUG} HEAD — git ls-remote returned ${JSON.stringify(remoteHead)}`);
  }
  const localHead = git(["rev-parse", "HEAD"]);
  const dirtyFiles = git(["status", "--porcelain", "--", ...PLUGIN_FILES]);

  // "Local is ahead" and "the pushed files are genuinely wrong" present as the
  // same symptom — a mismatch — and the operator must not have to work out which
  // one they are staring at. git can answer it: if GitHub's tip is an ancestor of
  // local HEAD, nothing is wrong with the files, they are just not pushed.
  const isAncestorOfLocal = (sha) => {
    try {
      git(["merge-base", "--is-ancestor", sha, localHead]);
      return true;
    } catch {
      return false; // diverged, or that commit is not in this clone — either way, not "ahead"
    }
  };
  const inSync = !dirtyFiles && remoteHead === localHead;
  const diagnosis = dirtyFiles
    ? `${dirtyFiles.split("\n").length} of these files have UNCOMMITTED local edits, so GitHub cannot match. Fix: commit and push.`
    : remoteHead === localHead
      ? `GitHub is serving this exact commit (${localHead.slice(0, 8)}), so this is a real defect in the pushed files — not a push you forgot.`
      : isAncestorOfLocal(remoteHead)
        ? `local HEAD ${localHead.slice(0, 8)} is AHEAD of GitHub's ${remoteHead.slice(0, 8)}: the files are fine, they are NOT PUSHED. Fix: git push`
        : `local HEAD ${localHead.slice(0, 8)} and GitHub's ${remoteHead.slice(0, 8)} have diverged, or that commit is not in this clone. Run: git fetch origin — do not read the lines below as a file defect until these agree.`;
  check(
    inSync,
    inSync ? `GitHub serves the commit being verified (${localHead.slice(0, 8)}, plugin files clean)` : diagnosis,
  );

  // getJson parses what it can, so the manifests arrive as objects and the
  // playbook arrives as text. Re-serialise BOTH sides through the same function
  // rather than byte-comparing a parsed value against a file and failing on
  // indentation.
  const canonical = (text) => {
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      return text;
    }
  };
  const declaredVersion = (text) => {
    try {
      const o = JSON.parse(text);
      return o.version ?? o.plugins?.find((p) => p.name === "loopback")?.version;
    } catch {
      return undefined;
    }
  };

  const RAW = `https://raw.githubusercontent.com/${GH_SLUG}/${remoteHead}`;
  for (const rel of PLUGIN_FILES) {
    const got = await getJson(`${RAW}/${rel}`);
    // Compared against this tree, not against VERSION: init-gate already pins
    // these files to package.json on every push, so re-asserting that here would
    // test the same thing twice and still miss the only gap left — the delta
    // between what is on disk and what GitHub hands an adopter.
    const served = typeof got.body === "string" ? got.body : JSON.stringify(got.body);
    const mine = canonical(readFileSync(join(ROOT, rel), "utf-8"));
    // A miss is a 200-shaped `404: Not Found` STRING body here too, so the status
    // has to carry the weight rather than the body being truthy.
    const same = got.status === 200 && served === mine;
    const theirs = got.status === 200 ? (declaredVersion(served) ?? `${served.length}B`) : `HTTP ${got.status}`;
    check(
      same,
      same
        ? `GitHub serves this tree's ${rel}`
        : `GitHub's ${rel} is not this tree's — it serves ${theirs}, this release has ${declaredVersion(mine) ?? `${mine.length}B`}. ${diagnosis}`,
    );
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
