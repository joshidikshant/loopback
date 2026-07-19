/**
 * Full-loop E2E: a real browser + the widget + the bus + an "agent".
 *
 *  1. Start loopback (--http) with a fresh DB, and the demo app (broken backend).
 *  2. Playwright (human role): submit the contact form (backend 500s), then pin
 *     feedback on the submit button — the widget must auto-attach the failed
 *     request incl. response body. Also pin the AI answer — the widget must
 *     attach data-loopback-context (run_id etc.).
 *  3. Verify both items in the bus carry the right context.
 *  4. Agent role (MCP over streamable HTTP): claim → link_change → fixed → verified.
 *  5. Human role again: reload the page — the pin must show the resolved state.
 *
 * Run: node scripts/e2e.mjs
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const LB = "http://127.0.0.1:7077";
const DEMO = "http://127.0.0.1:5173";
const dbPath = join(tmpdir(), `loopback-e2e-${Date.now()}.db`);
const children = [];
let browserRef = null;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", () => {});
  children.push(child);
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let rpcId = 0;
async function mcpCall(tool, args) {
  const res = await fetch(`${LB}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  if (json.result?.isError) {
    throw new Error(`Tool error: ${json.result.content?.[0]?.text}`);
  }
  return json.result;
}

async function main() {
  // 1. Boot both servers
  start(process.execPath, ["dist/index.js", "--http", "--port", "7077"], {
    LOOPBACK_DB: dbPath,
  });
  start(process.execPath, ["demo/serve.mjs"]);
  await waitFor(`${LB}/health`);
  await waitFor(`${DEMO}/`);
  console.log("✅ loopback + demo app up");

  let step = "launch";
  const watchdog = setTimeout(() => {
    console.error(`\nWATCHDOG: still stuck at step "${step}" after 100s`);
    process.exit(2);
  }, 100000);
  watchdog.unref();
  const log = (s) => {
    step = s;
    console.log(`   … ${s}`);
  };

  const browser = await chromium.launch(
    process.env.LOOPBACK_E2E_CHROMIUM
      ? { executablePath: process.env.LOOPBACK_E2E_CHROMIUM }
      : {},
  );
  browserRef = browser;
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(20000);
  log("goto demo");
  await page.goto(DEMO, { waitUntil: "load" });
  log("wait widget mount");
  await page.waitForSelector("#loopback-widget-host", { state: "attached" });

  // 2a. Human: use the app — frontend "works", backend 500s
  log("submit contact form");
  await page.click('[data-testid="contact-submit"]');
  await page.waitForTimeout(600);
  console.log("✅ contact form submitted (backend returned 500 behind the scenes)");

  // 2b. Human: pin feedback on the submit button
  log("open widget panel");
  await page.click("#loopback-widget-host .fab");
  log("enter pin mode");
  await page.click("#loopback-widget-host .pinbtn");
  log("pick contact submit");
  await page.click('[data-testid="contact-submit"]');
  const formSel = "#loopback-widget-host .form";
  await page.waitForSelector(formSel);
  const formText = await page.locator(formSel).innerText();
  assert(
    formText.includes("failed request"),
    "widget surfaced the captured failed request in the form",
  );
  await page.fill(`${formSel} .f-title`, "Contact form says try again");
  await page.fill(`${formSel} .f-got`, "Clicked send, got 'Something went wrong'.");
  await page.fill(`${formSel} .f-want`, "Message should send and confirm.");
  await page.click(`${formSel} .send`);
  await page.waitForSelector("#loopback-widget-host .toast");
  console.log("✅ pinned feedback on the form (failed request auto-attached)");

  // 2c. Human: pin the AI answer (LLM context capture)
  await page.click("#loopback-widget-host .fab");
  await page.click("#loopback-widget-host .pinbtn");
  await page.click('[data-testid="ai-answer"]');
  await page.waitForSelector(formSel);
  const aiFormText = await page.locator(formSel).innerText();
  assert(
    aiFormText.includes("AI/automation context attached"),
    "widget detected data-loopback-context on the AI block",
  );
  await page.fill(`${formSel} .f-title`, "AI support answer is nonsense");
  await page.fill(`${formSel} .f-got`, "Told user to mail a photocopy of their keyboard.");
  await page.click(`${formSel} .send`);
  await page.waitForTimeout(600);
  console.log("✅ pinned feedback on the AI answer (run context auto-attached)");

  // 3. Verify what landed in the bus
  const listing = await (
    await fetch(`${LB}/feedback?project=acme-demo&limit=10`)
  ).json();
  assert(listing.total === 2, `bus has both items (got ${listing.total})`);
  const contactItem = listing.items.find((i) =>
    i.title.includes("Contact form"),
  );
  const aiItem = listing.items.find((i) => i.title.includes("AI support"));
  assert(contactItem && aiItem, "both items retrievable");
  assert(
    contactItem.type === "backend",
    `contact pin auto-typed backend (got ${contactItem.type})`,
  );
  assert(
    contactItem.network.some((n) => n.status === 500),
    "500 request recorded on contact item",
  );
  const failedBody = JSON.stringify(contactItem.extra.failed_responses ?? []);
  assert(
    failedBody.includes("DB_WRITE_FAILED") && failedBody.includes("0042_add_message_column"),
    "backend error body captured — agent can chase the migration bug from a frontend pin",
  );
  assert(
    aiItem.extra?.context?.run_id === "run_8f31a",
    "LLM run_id captured from data-loopback-context",
  );
  assert(aiItem.type === "usage", "AI pin auto-typed usage");
  console.log("✅ bus items carry full-stack context (500 body + LLM run metadata)");

  // 4. Agent role over MCP/HTTP: claim → link → fix → verify
  await mcpCall("loopback_claim_feedback", {
    id: contactItem.id,
    agent: "claude-code",
  });
  await mcpCall("loopback_link_change", {
    id: contactItem.id,
    repo: "dj/acme-demo",
    branch: "fix/contacts-migration",
    commit: "beef123",
    pr_url: "https://github.com/dj/acme-demo/pull/7",
    diff_summary: "Apply migration 0042; add message column to contacts.",
  });
  await mcpCall("loopback_update_status", {
    id: contactItem.id,
    status: "fixed",
    note: "Migration applied; POST /api/contact returns 200 locally.",
    author: "claude-code",
  });
  await mcpCall("loopback_resolve_feedback", {
    id: contactItem.id,
    resolution: "verified",
    note: "Form submits clean end-to-end.",
  });
  console.log("✅ agent claimed, linked the fix, and resolved via MCP over HTTP");

  // 4b. Walkthrough: with the page still open, the status change must announce
  // itself (toast + pulsing pin) — the loop closes visibly, no reload needed.
  log("live status walkthrough");
  await page.evaluate(() => window.__loopback.refresh());
  await page.waitForFunction(() => {
    const root = document.querySelector("#loopback-widget-host")?.shadowRoot;
    if (!root) return false;
    const toasts = [...root.querySelectorAll(".toast")].map((t) => t.textContent);
    return (
      toasts.some((t) => t.includes("→ verified") && t.includes("claude-code")) &&
      root.querySelector(".pin.pulse") !== null
    );
  });
  const api = await page.evaluate(() => ({
    project: window.__loopback.project,
    hasRefresh: typeof window.__loopback.refresh === "function",
  }));
  assert(api.project === "acme-demo", "page API exposes the project");
  assert(api.hasRefresh, "page API exposes refresh()");
  console.log("✅ live walkthrough: open page announced open → verified (toast + pulsing pin)");

  // 5. Human reloads — the pin shows the closed loop
  log("reload for pin states");
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(
    () => (window.__loopback?.pins ?? []).length === 2,
    { timeout: 8000 },
  );
  const pinStates = await page.evaluate(() =>
    (window.__loopback?.pins ?? []).map((p) => ({
      title: p.title,
      status: p.status,
      assignee: p.assignee_agent,
      pr: p.links?.pr_url,
    })),
  );
  const contactPin = pinStates.find((p) => p.title.includes("Contact form"));
  assert(contactPin.status === "verified", "pin reflects verified status");
  assert(contactPin.assignee === "claude-code", "pin shows which agent fixed it");
  assert(contactPin.pr?.includes("pull/7"), "pin carries the PR link");
  const pinCount = await page.locator("#loopback-widget-host .pin").count();
  assert(pinCount === 2, `both pins rendered on the page (got ${pinCount})`);
  console.log("✅ reload: pin is green/verified with agent + PR attached — loop closed visibly");

  // 6. Widget hardening (regressions found dogfooding on a real Next.js site)
  log("hardening: dark color-scheme");
  const btnColor = await page.evaluate(() => {
    document.documentElement.style.colorScheme = "dark";
    const root = document.querySelector("#loopback-widget-host").shadowRoot;
    return getComputedStyle(root.querySelector(".pinbtn")).color;
  });
  assert(
    btnColor === "rgb(17, 17, 17)",
    `widget controls keep explicit colors under color-scheme:dark (got ${btnColor})`,
  );

  log("hardening: semantic-class selectors");
  const selSample = await page.evaluate(() =>
    window.__loopback._cssPath(document.querySelector(".card.ai h2")),
  );
  assert(
    selSample.includes("div.card"),
    `selector generator uses semantic classes (got ${selSample})`,
  );

  log("hardening: SPA route-change refresh");
  await page.evaluate(() => history.pushState({}, "", "/other-route"));
  await page.waitForFunction(() => (window.__loopback?.pins ?? []).length === 0, {
    timeout: 2500,
  });
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => (window.__loopback?.pins ?? []).length === 2, {
    timeout: 2500,
  });
  console.log("✅ hardening: dark-scheme colors, semantic selectors, instant SPA pin refresh");

  await browser.close();
  console.log("\nFULL-LOOP E2E PASSED 🎉  human pin → bus → agent fix → visible closure");
}

main()
  .catch((error) => {
    console.error("\nE2E FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browserRef) {
      try {
        await browserRef.close();
      } catch {
        /* ignore */
      }
    }
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
