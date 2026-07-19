/** Boots the stack, seeds the two demo pins (one open, one fixed by an agent), screenshots the page. */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const LB = "http://127.0.0.1:7077";
const DEMO = "http://127.0.0.1:5173";
const dbPath = join(tmpdir(), `loopback-shot-${Date.now()}.db`);
const children = [];
const start = (cmd, args, env = {}) => {
  const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] });
  children.push(c);
};
const waitFor = async (url) => {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
};
let id = 0;
const mcp = async (name, args) =>
  fetch(`${LB}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  }).then((r) => r.json());

const ingest = async (payload) =>
  (await (await fetch(`${LB}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json()).id;

try {
  start(process.execPath, ["dist/index.js", "--http", "--port", "7077"], { LOOPBACK_DB: dbPath });
  start(process.execPath, ["demo/serve.mjs"]);
  await waitFor(`${LB}/health`);
  await waitFor(`${DEMO}/`);

  const contactId = await ingest({
    project: "acme-demo", type: "backend", severity: "p1",
    title: "Contact form says try again",
    body: "What happened: clicked send, got error.\nExpected: message sends.",
    route: "/", url: `${DEMO}/`, dom_selector: 'button[data-testid="contact-submit"]',
    source: "widget", reporter: "human",
    network: [{ url: "/api/contact", method: "POST", status: 500, ms: 41 }],
    extra: { failed_responses: [{ url: "/api/contact", status: 500, body: '{"error":"DB_WRITE_FAILED"}' }] },
  });
  await ingest({
    project: "acme-demo", type: "usage", severity: "p2",
    title: "AI support answer is nonsense",
    route: "/", url: `${DEMO}/`, dom_selector: 'p[data-testid="ai-answer"]',
    source: "widget", reporter: "human",
    extra: { context: { run_id: "run_8f31a", model: "acme-llm-2" } },
  });
  await mcp("loopback_claim_feedback", { id: contactId, agent: "claude-code" });
  await mcp("loopback_link_change", { id: contactId, pr_url: "https://github.com/dj/acme-demo/pull/7", commit: "beef123" });
  await mcp("loopback_resolve_feedback", { id: contactId, resolution: "verified" });

  const browser = await chromium.launch(
    process.env.LOOPBACK_E2E_CHROMIUM ? { executablePath: process.env.LOOPBACK_E2E_CHROMIUM } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1100, height: 860 } });
  await page.goto(DEMO, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__loopback?.pins ?? []).length === 2, { timeout: 8000 });
  await page.click("#loopback-widget-host .fab"); // open panel to show the route's pin list
  await page.waitForTimeout(400);
  await page.screenshot({ path: "../loopback-widget-demo.png", fullPage: false });
  await browser.close();
  console.log("screenshot saved");
} finally {
  children.forEach((c) => { try { c.kill("SIGTERM"); } catch {} });
  ["", "-wal", "-shm"].forEach((s) => { try { rmSync(`${dbPath}${s}`, { force: true }); } catch {} });
}
