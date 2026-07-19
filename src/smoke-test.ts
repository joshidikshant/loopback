/**
 * End-to-end smoke test: spawns the built server over stdio as a real MCP client
 * and exercises the full loop: submit → list → claim → comment → link → fix →
 * resolve → get → stats. Run: npm run build && npm run smoke
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbPath = join(tmpdir(), `loopback-smoke-${Date.now()}.db`);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

interface CallOk {
  structured: Record<string, unknown>;
  text: string;
}

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
  const client = new Client({ name: "loopback-smoke", version: "1.0.0" });
  await client.connect(transport);

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallOk> => {
    const res = await client.callTool({ name, arguments: args });
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
    const res = await client.callTool({ name, arguments: args });
    assert(res.isError, `${name} should have errored`);
    return Array.isArray(res.content) && res.content[0]?.type === "text"
      ? (res.content[0].text as string)
      : "";
  };

  // 0. Tool inventory
  const tools = await client.listTools();
  assert(tools.tools.length === 9, `expected 9 tools, got ${tools.tools.length}`);
  console.log(`✅ 9 tools registered: ${tools.tools.map((t) => t.name).join(", ")}`);

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

  // 6. Stats + not-found error path
  const stats = await call("loopback_get_stats", {});
  assert(stats.structured.total === 2, "stats sees both projects");
  const notFound = await callExpectError("loopback_get_feedback", {
    id: "fb_nope",
  });
  assert(notFound.includes("not found"), "not-found is actionable");
  console.log("✅ stats across projects + actionable not-found errors");

  await client.close();
  console.log("\nALL SMOKE TESTS PASSED 🎉");
}

main()
  .catch((error) => {
    console.error("\nSMOKE TEST FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });
