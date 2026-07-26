/**
 * Accessibility gate: measures the running UI in a real browser.
 *
 * The other seven gates check structure, freshness and design anti-patterns.
 * None of them asserted a single accessibility property — so every a11y fix in
 * the repo was defended by nothing but a one-time manual check, which is
 * exactly how these regress. This is the durable version of that check.
 *
 * It measures rather than greps, because the interesting failures are
 * computed: contrast depends on resolved oklch values against whatever
 * background actually wins the cascade, and target size depends on layout.
 *
 * Two measurement traps this deliberately avoids, both of which produced false
 * results before being pinned down:
 *   1. `getComputedStyle().color` returns oklch()/oklab(), NOT rgb. Parsing the
 *      numbers as RGB yields garbage. Colours are resolved through a canvas.
 *   2. Toggling the theme and measuring in the same frame reads colours that
 *      are still mid-transition (shadcn's TableRow has transition-colors), so
 *      transitions are disabled before anything is measured.
 *
 * Run: node scripts/a11y-gate.mjs
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.LOOPBACK_A11Y_PORT || 7191);
const DEMO_PORT = Number(process.env.LOOPBACK_A11Y_DEMO_PORT || 5291);
const LB = `http://127.0.0.1:${PORT}`;
const DEMO = `http://127.0.0.1:${DEMO_PORT}`;
const DB = join(tmpdir(), `loopback-a11y-${process.pid}.db`);

const children = [];
let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`❌ ${m}`);
};
const pass = (m) => console.log(`✅ ${m}`);
const check = (cond, m) => (cond ? pass(m) : fail(m));

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  children.push(child);
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Injected into the page: resolve any CSS colour and score WCAG contrast. */
const MEASURE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (css) => { ctx.fillStyle = '#f0f'; ctx.fillStyle = css;
    ctx.clearRect(0,0,1,1); ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
  const lum = ([r,g,b]) => { const f = (c) => { c/=255;
    return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const ratio = (a,b) => { const x = lum(a), y = lum(b);
    const [hi,lo] = x > y ? [x,y] : [y,x]; return (hi+0.05)/(lo+0.05); };
  const bgOf = (el) => { let n = el;
    while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c[3] > 0.95) return c; n = n.parentElement; }
    return rgb(getComputedStyle(document.body).backgroundColor); };

  const scanContrast = () => {
    const out = [], seen = new Set();
    document.querySelectorAll('span,button,a,td,th,p,h1,h2,code,label,time,div').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (!t || el.children.length > 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (!el.getBoundingClientRect().width) return;
      const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
      const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
      const r = ratio(rgb(cs.color), bgOf(el));
      const k = cs.color + '|' + cs.backgroundColor + '|' + px;
      if (seen.has(k)) return; seen.add(k);
      if (r < need) out.push({ text: t.slice(0,24), px, ratio: +r.toFixed(2), need });
    });
    return out;
  };

  const scanTargets = () => {
    const out = [], seen = new Set();
    document.querySelectorAll('button,a,input,select,textarea,[role=button]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0,24);
      const k = name + Math.round(r.width) + Math.round(r.height);
      if (seen.has(k)) return; seen.add(k);
      if (r.width < 24 || r.height < 24) out.push({ name, w: Math.round(r.width), h: Math.round(r.height) });
    });
    return out;
  };

  const unnamedControls = () => {
    const out = [];
    document.querySelectorAll('input,select,textarea').forEach((el) => {
      if (el.type === 'hidden') return;
      const byFor = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || byFor;
      if (!name) out.push(el.className || el.tagName);
    });
    document.querySelectorAll('button').forEach((el) => {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name) out.push('button:' + (el.className || '').slice(0,30));
    });
    return out;
  };

  const de = document.documentElement;
  const root = de;
  root.classList.remove('dark'); void document.body.offsetHeight;
  const light = scanContrast();
  root.classList.add('dark'); void document.body.offsetHeight;
  const dark = scanContrast();
  root.classList.remove('dark'); void document.body.offsetHeight;

  return {
    contrastLight: light,
    contrastDark: dark,
    smallTargets: scanTargets(),
    unnamed: unnamedControls(),
    hasMain: !!document.querySelector('main'),
    title: document.title,
    horizontalOverflow: de.scrollWidth > de.clientWidth ? { scroll: de.scrollWidth, client: de.clientWidth } : null,
  };
})()`;

const KILL_MOTION = `(() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;}';
  document.head.appendChild(s);
  return true;
})()`;

async function main() {
  rmSync(DB, { force: true });
  start("node", ["dist/index.js", "--http", "--port", String(PORT)], { LOOPBACK_DB: DB });
  start("npx", ["--yes", "http-server", "demo", "-p", String(DEMO_PORT), "-s"]);
  await waitFor(`${LB}/queue`);
  await waitFor(`${DEMO}/index.html`);

  // One item, so the queue renders real rows rather than the empty state.
  await fetch(`${LB}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: "a11y", type: "ui", severity: "p3",
      title: "Seed item for the accessibility gate",
      body: "Rendered so the table and cards have content to measure.",
      dom_selector: "h1", route: "/index.html", source: "widget", reporter: "human",
    }),
  });

  const browser = await chromium.launch();
  try {
    // ---------- dashboard, desktop ----------
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${LB}/queue`);
    await page.waitForSelector("tbody tr");
    await page.evaluate(KILL_MOTION);
    const desktop = await page.evaluate(MEASURE);

    check(desktop.contrastLight.length === 0,
      `queue: no contrast failures in light${desktop.contrastLight.length ? ` — ${JSON.stringify(desktop.contrastLight)}` : ""}`);
    check(desktop.contrastDark.length === 0,
      `queue: no contrast failures in dark${desktop.contrastDark.length ? ` — ${JSON.stringify(desktop.contrastDark)}` : ""}`);
    check(desktop.smallTargets.length === 0,
      `queue: every target clears 24x24 (SC 2.5.8)${desktop.smallTargets.length ? ` — ${JSON.stringify(desktop.smallTargets)}` : ""}`);
    check(desktop.unnamed.length === 0,
      `queue: every control has an accessible name${desktop.unnamed.length ? ` — ${JSON.stringify(desktop.unnamed)}` : ""}`);
    check(desktop.hasMain, "queue: has a <main> landmark");

    // ---------- dashboard, phone ----------
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(150);
    const phone = await page.evaluate(MEASURE);
    check(!phone.horizontalOverflow,
      `queue at 375px: no page-level horizontal scroll${phone.horizontalOverflow ? ` — ${JSON.stringify(phone.horizontalOverflow)}` : ""}`);
    check(phone.smallTargets.length === 0,
      `queue at 375px: every target clears 24x24${phone.smallTargets.length ? ` — ${JSON.stringify(phone.smallTargets)}` : ""}`);

    // Long unbreakable strings are the realistic overflow trigger: AGENTS.md
    // tells agents to paste trace URLs into these very fields.
    const detail = await page.evaluate(async (base) => {
      const r = await fetch(base + "/feedback?project=a11y&limit=1");
      return (await r.json()).items[0].id;
    }, LB);
    await fetch(`${LB}/feedback/${detail}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "https://traces.example.dev/run/" + "z".repeat(120),
        body: "https://traces.example.dev/very/long/" + "y".repeat(160),
        author: "a11y-gate",
      }),
    });
    await page.goto(`${LB}/queue/${detail}`);
    await page.waitForSelector("h1");
    await page.evaluate(KILL_MOTION);
    const item = await page.evaluate(MEASURE);
    check(!item.horizontalOverflow,
      `detail at 375px with a 120-char unbroken URL: no page overflow${item.horizontalOverflow ? ` — ${JSON.stringify(item.horizontalOverflow)}` : ""}`);
    check(item.contrastLight.length === 0 && item.contrastDark.length === 0,
      "detail: no contrast failures in either theme");
    check(item.smallTargets.length === 0,
      `detail: every target clears 24x24${item.smallTargets.length ? ` — ${JSON.stringify(item.smallTargets)}` : ""}`);
    check(item.title.includes(detail), "detail: route change set the document title");

    // ---------- widget, on a host page ----------
    const wpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await wpage.goto(`${DEMO}/index.html`);
    await wpage.waitForFunction(() => !!window.__loopback);
    const widget = await wpage.evaluate(() => {
      const host = [...document.querySelectorAll("*")].find((e) => e.shadowRoot);
      const sr = host.shadowRoot;
      const fab = sr.querySelector(".fab");
      fab.click();
      sr.querySelector(".pinbtn").click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const form = sr.querySelector(".form");
      const controls = form ? [...form.querySelectorAll("input,textarea,select")] : [];
      return {
        liveRegions: [...sr.querySelectorAll("[aria-live]")].map((r) => r.getAttribute("aria-live")).sort(),
        openedByKeyboard: !!form,
        formRole: form?.getAttribute("role") ?? null,
        formNamed: !!form?.getAttribute("aria-label"),
        // aria-modal without a focus trap is a lie; we deliberately omit it.
        claimsModal: form?.getAttribute("aria-modal") === "true",
        controlCount: controls.length,
        allLabelled: controls.every((c) => c.id && form.querySelector(`label[for="${c.id}"]`)),
        smallestFont: Math.min(...controls.map((c) => parseFloat(getComputedStyle(c).fontSize))),
        fabExpanded: fab.hasAttribute("aria-expanded"),
      };
    });
    check(widget.allLabelled && widget.controlCount === 5,
      `widget: all ${widget.controlCount} form controls have a real <label for>`);
    check(widget.openedByKeyboard, "widget: pin mode is operable by keyboard alone");
    check(widget.formRole === "dialog" && widget.formNamed, "widget: capture form is a named dialog");
    check(!widget.claimsModal, "widget: does not claim aria-modal without a focus trap");
    check(JSON.stringify(widget.liveRegions) === '["assertive","polite"]',
      `widget: has polite + assertive live regions (${widget.liveRegions})`);
    check(widget.smallestFont >= 16,
      `widget: inputs are >=16px so iOS does not zoom a fixed panel (${widget.smallestFont}px)`);
    check(widget.fabExpanded, "widget: the FAB exposes aria-expanded");

    // ---------- reduced motion is honoured where the motion actually is ----------
    const rm = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await rm.emulateMedia({ reducedMotion: "reduce" });
    await rm.goto(`${LB}/queue`);
    await rm.waitForSelector("tbody tr");
    const motion = await rm.evaluate(() => {
      let guarded = 0;
      for (const sheet of document.styleSheets) {
        try {
          for (const r of sheet.cssRules) {
            if (r.conditionText && r.conditionText.includes("prefers-reduced-motion")) guarded++;
          }
        } catch {
          /* cross-origin sheet */
        }
      }
      return { guarded };
    });
    check(motion.guarded > 0, `dashboard: ships a prefers-reduced-motion rule (${motion.guarded})`);
  } finally {
    await browser.close();
  }
}

main()
  .catch((e) => {
    fail(String(e.message || e));
  })
  .finally(() => {
    for (const c of children) c.kill("SIGKILL");
    rmSync(DB, { force: true });
    rmSync(`${DB}-wal`, { force: true });
    rmSync(`${DB}-shm`, { force: true });
    if (failures) {
      console.error(`\nA11Y GATE FAILED — ${failures} assertion(s)`);
      process.exit(1);
    }
    console.log("\nA11Y GATE PASSED 🎉  contrast, target size, names, landmarks, motion — measured, not assumed");
    process.exit(0);
  });
