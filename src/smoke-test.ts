/**
 * End-to-end smoke test: spawns the built server over stdio as a real MCP client
 * and exercises the full loop: submit → list → claim → comment → link → fix →
 * resolve → get → stats. Run: npm run build && npm run smoke
 */

import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_VERSION } from "./server.js";

const dbPath = join(tmpdir(), `loopback-smoke-${Date.now()}.db`);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

interface CallOk {
  structured: Record<string, unknown>;
  text: string;
}

/** Module scope so the failure path can still close it — see the .finally below. */
let client: Client | null = null;

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.LOOPBACK_DB = dbPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist", "index.js")],
    env,
  });
  const mcp = new Client({ name: "loopback-smoke", version: "1.0.0" });
  client = mcp;
  await mcp.connect(transport);

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallOk> => {
    const res = await mcp.callTool({ name, arguments: args });
    const text =
      Array.isArray(res.content) && res.content[0]?.type === "text"
        ? (res.content[0].text as string)
        : "";
    if (res.isError) throw new Error(`Tool ${name} errored: ${text}`);
    return {
      structured: (res.structuredContent ?? {}) as Record<string, unknown>,
      text,
    };
  };

  const callExpectError = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const res = await mcp.callTool({ name, arguments: args });
    assert(res.isError, `${name} should have errored`);
    return Array.isArray(res.content) && res.content[0]?.type === "text"
      ? (res.content[0].text as string)
      : "";
  };

  // 0a. Version parity: SERVER_VERSION is a hand-written constant and
  // package.json is what npm publishes. Nothing tied them together, and they
  // were already divergent once (0.8.0 vs the shipped docs).
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  };
  assert(
    SERVER_VERSION === pkg.version,
    `SERVER_VERSION (${SERVER_VERSION}) matches package.json (${pkg.version})`,
  );

  // The MCP Registry hard-fails publication on any of these drifting: it reads
  // `mcpName` from the PUBLISHED npm metadata and requires it to equal
  // server.json's `name`, and resolves the package by the exact version. npm
  // versions are immutable, so a mismatch is not a re-run — it is a wasted
  // version number. Four version fields and two name fields, all hand-typed.
  const srv = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf-8")) as {
    name: string;
    version: string;
    packages: { identifier: string; version: string }[];
  };
  const pkgJson = pkg as unknown as { mcpName?: string; name: string };
  assert(
    pkgJson.mcpName === srv.name,
    `package.json mcpName (${pkgJson.mcpName}) equals server.json name (${srv.name}) — the registry compares these exactly`,
  );
  assert(
    /^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(srv.name),
    `server.json name is a GitHub-auth reverse-DNS name (${srv.name})`,
  );
  assert(
    srv.version === pkg.version && srv.packages.every((x) => x.version === pkg.version),
    `server.json versions track package.json (${srv.version} / ${srv.packages.map((x) => x.version).join(",")} vs ${pkg.version})`,
  );
  assert(
    srv.packages.every((x) => x.identifier === pkgJson.name),
    `server.json package identifier is the published npm name (${srv.packages.map((x) => x.identifier).join(",")})`,
  );
  console.log(`✅ version + registry-identity parity: ${SERVER_VERSION} / ${srv.name}`);

  // 0. Tool inventory
  const tools = await mcp.listTools();
  assert(tools.tools.length === 10, `expected 10 tools, got ${tools.tools.length}`);
  console.log(`✅ 10 tools registered: ${tools.tools.map((t) => t.name).join(", ")}`);

  // 1. Submit a UI bug (project A) and a backend p0 (project B)
  const bug = await call("loopback_submit_feedback", {
    project: "demo-web",
    type: "ui",
    severity: "p1",
    title: "Pay button dead on mobile Safari",
    body: "Tapping Pay does nothing. No spinner, no error toast.",
    route: "/checkout",
    dom_selector: "button[data-testid='pay']",
    console: ["TypeError: undefined is not a function at pay.ts:42"],
    network: [{ url: "/api/pay", method: "POST", status: 500, ms: 2100 }],
    repro_steps: ["Open /checkout on iOS Safari", "Tap Pay"],
  });
  const bugId = bug.structured.id as string;
  assert(bugId?.startsWith("fb_"), "submit returns fb_ id");
  assert(bug.structured.status === "open", "new item starts open");
  console.log(`✅ submitted ${bugId} (demo-web, ui/p1, open)`);

  const apiBug = await call("loopback_submit_feedback", {
    project: "demo-api",
    type: "backend",
    severity: "p0",
    title: "Webhook handler 500s on empty payload",
    source: "sentry",
    reporter: "system",
  });
  const apiId = apiBug.structured.id as string;
  console.log(`✅ submitted ${apiId} (demo-api, backend/p0)`);

  // 2. List filters by project
  const list = await call("loopback_list_feedback", {
    project: "demo-web",
    status: "open",
    response_format: "json",
  });
  assert(list.structured.total === 1, "demo-web open queue has exactly 1 item");
  console.log("✅ list filters by project+status (total=1)");

  // 3. Claim — then conflicting claim must fail
  const claim = await call("loopback_claim_feedback", {
    id: bugId,
    agent: "claude-code",
  });
  const claimed = claim.structured as { status?: string; assignee_agent?: string };
  assert(claimed.status === "in_progress", "claim moves open → in_progress");
  assert(claimed.assignee_agent === "claude-code", "assignee set");
  const conflict = await callExpectError("loopback_claim_feedback", {
    id: bugId,
    agent: "codex",
  });
  assert(conflict.includes("claude-code"), "conflict names current holder");
  console.log("✅ atomic claim works; second agent blocked without force");

  // 4. Comment, link the change, mark fixed
  await call("loopback_add_comment", {
    id: bugId,
    author: "claude-code",
    body: "Root cause: pay() undefined on Safari due to missing polyfill.",
  });
  const linked = await call("loopback_link_change", {
    id: bugId,
    repo: "dj/demo-web",
    branch: "fix/pay-safari",
    commit: "abc1234",
    pr_url: "https://github.com/dj/demo-web/pull/42",
    diff_summary: "Add intl polyfill; guard pay() binding.",
  });
  const links = (linked.structured as { links?: { commit?: string } }).links;
  assert(links?.commit === "abc1234", "links merged");
  await call("loopback_update_status", {
    id: bugId,
    status: "fixed",
    note: "Verified locally on iOS simulator.",
    author: "claude-code",
  });
  console.log("✅ comment + link_change + update_status(fixed)");

  // 5. Resolve verified, then read back full item
  await call("loopback_resolve_feedback", {
    id: bugId,
    resolution: "verified",
    note: "Replay confirms checkout completes.",
  });
  const full = await call("loopback_get_feedback", {
    id: bugId,
    response_format: "json",
  });
  const fullItem = full.structured as {
    status?: string;
    resolution?: string;
    comments?: unknown[];
    links?: { pr_url?: string };
  };
  assert(fullItem.status === "verified", "final status verified");
  assert(fullItem.resolution === "verified", "resolution recorded");
  assert((fullItem.comments?.length ?? 0) >= 3, "audit trail preserved (3+ comments)");
  assert(
    fullItem.links?.pr_url === "https://github.com/dj/demo-web/pull/42",
    "PR link preserved",
  );
  console.log("✅ resolve(verified) + full get with comments/links intact");

  // 5b. itemMarkdown vs structuredContent parity.
  //
  // Two representations of the same item: structuredContent IS the item, while
  // the markdown is hand-written and is the DEFAULT an agent reads. Nothing
  // asserted they carry the same facts, so a field could be added to the store
  // and silently never reach the surface agents actually consume — which is
  // exactly what happened to attachments.
  const md = await call("loopback_get_feedback", { id: bugId });
  const carriesData = (v: unknown): boolean =>
    v !== null && v !== undefined && v !== "" &&
    !(Array.isArray(v) && v.length === 0) &&
    !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
  // Fields whose ABSENCE from the prose is deliberate: timestamps the markdown
  // renders as relative age, and machine plumbing an agent reads structurally.
  const NOT_IN_PROSE = new Set(["updated_at", "created_at", "extra", "dom_selector"]);
  // Compare VALUES, not key names. A first attempt searched for the key
  // ("title", "body") and reported four false positives — the markdown of
  // course renders the title's text, not the word "title".
  const leaves = (v: unknown): string[] => {
    if (v === null || v === undefined) return [];
    if (Array.isArray(v)) return v.flatMap(leaves);
    if (typeof v === "object") return Object.values(v as object).flatMap(leaves);
    return [String(v)];
  };
  const missing = Object.entries(fullItem as Record<string, unknown>)
    .filter(([k, v]) => carriesData(v) && !NOT_IN_PROSE.has(k))
    .filter(([, v]) => leaves(v).some((leaf) => leaf.length > 2 && !md.text.includes(leaf)))
    .map(([k]) => k);
  assert(
    missing.length === 0,
    `itemMarkdown drops populated field(s) structuredContent carries: ${missing.join(", ")}`,
  );
  console.log(`✅ itemMarkdown carries every populated field structuredContent does`);

  // 6. Stats + not-found error path
  const stats = await call("loopback_get_stats", {});
  assert(stats.structured.total === 2, "stats sees both projects");
  const notFound = await callExpectError("loopback_get_feedback", {
    id: "fb_nope",
  });
  assert(notFound.includes("not found"), "not-found is actionable");
  console.log("✅ stats across projects + actionable not-found errors");

  // 7. The tool contract: a mistyped argument must fail loudly.
  // Zod strips unknown keys by default, which turned `sevrity: "p0"` into a
  // silently-filed p2 that reported success — the agent believes it filed a
  // critical item. Verified through the MCP Inspector before this was fixed.
  const typo = await callExpectError("loopback_submit_feedback", {
    project: "demo-web",
    type: "ui",
    title: "Typo guard",
    sevrity: "p0",
  } as unknown as Record<string, unknown>);
  assert(
    /unrecognized|validation/i.test(typo),
    `a mistyped argument is rejected, not dropped (got: ${typo.slice(0, 80)})`,
  );
  const listed = await call("loopback_list_feedback", {
    project: "demo-web",
    response_format: "json",
  });
  const listedItems = (listed.structured as { items: { title: string }[] }).items;
  assert(
    !listedItems.some((i) => i.title === "Typo guard"),
    "the rejected call filed nothing at all",
  );
  console.log("✅ strict tool inputs: a typo'd argument errors instead of filing the wrong thing");

  await mcp.close();
  console.log("\nALL SMOKE TESTS PASSED 🎉");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the client on the FAILURE path too. Without this, a failed
    // assertion skipped the close, the spawned stdio server was orphaned, and
    // the calling shell hung forever waiting on a child that would never exit —
    // which reads as "the test suite hangs", not "an assertion failed".
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
