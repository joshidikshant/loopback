/**
 * Accessibility gate: measures the running UI in a real browser.
 *
 * The other five gates check structure, freshness and design anti-patterns.
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
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.LOOPBACK_A11Y_PORT || 7191);
const DEMO_PORT = Number(process.env.LOOPBACK_A11Y_DEMO_PORT || 5291);
const LB = `http://127.0.0.1:${PORT}`;
const DEMO = `http://127.0.0.1:${DEMO_PORT}`;
const DB = join(tmpdir(), `loopback-a11y-${process.pid}.db`);
const ROOT = process.cwd();

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
  // Alpha-COMPOSITE, do not skip. Translucent backgrounds are exactly where
  // contrast quietly fails — shadcn's row hover is bg-muted/50 — and treating
  // anything under 0.95 alpha as absent measured the page background instead,
  // reporting a hovered row as clean when it was not.
  const over = (fg, bg) => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const bgOf = (el) => {
    const stack = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (c[3] >= 0.999) break;
      n = n.parentElement;
    }
    const base = rgb(getComputedStyle(document.body).backgroundColor);
    let out = base[3] >= 0.999 ? base : [255, 255, 255, 1];
    // Composite from the bottom of the stack upward.
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };

  // Shadow roots are opaque to querySelectorAll, so the widget — an entire
  // surface — was invisible to every scan here. Walk into open roots.
  const deepAll = (sel) => {
    const out = [];
    const walk = (rootNode) => {
      out.push(...rootNode.querySelectorAll(sel));
      rootNode.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(document);
    return out;
  };

  const scanContrast = () => {
    const out = [], seen = new Set();
    deepAll('span,button,a,td,th,p,h1,h2,code,label,time,div').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (!t || el.children.length > 0) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (!el.getBoundingClientRect().width) return;
      const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
      const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
      const bg = bgOf(el);
      const r = ratio(rgb(cs.color), bg);
      const k = cs.color + '|' + bg.join(',') + '|' + px;
      if (seen.has(k)) return; seen.add(k);
      if (r < need) out.push({ text: t.slice(0,24), px, ratio: +r.toFixed(2), need });
    });
    return out;
  };

  const scanTargets = () => {
    const out = [], seen = new Set();
    deepAll('button,a,input,select,textarea,[role=button]').forEach((el) => {
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
    // deepAll, not document.querySelectorAll — this was the one scanner that did
    // not pierce the shadow root, so the widget's FAB, pins and pin-list rows
    // were outside the "every control has an accessible name" assertion.
    deepAll('input,select,textarea').forEach((el) => {
      if (el.type === 'hidden') return;
      const scope = el.getRootNode();
      const byFor = el.id && scope.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || byFor;
      if (!name) out.push(el.className || el.tagName);
    });
    deepAll('button').forEach((el) => {
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

/** How many elements the shadow-piercing scan actually reached. */
const DEEP_COUNT = `() => {
  let n = 0;
  const walk = (r) => { n += r.querySelectorAll('*').length;
    r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); }); };
  walk(document);
  return n;
}`;

const KILL_MOTION = `(() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;}';
  document.head.appendChild(s);
  return true;
})()`;

async function main() {
  rmSync(DB, { force: true });
  start("node", ["dist/index.js", "--http", "--port", String(PORT)], { LOOPBACK_DB: DB });
  start(process.execPath, ["demo/serve.mjs"], {
    DEMO_PORT: String(DEMO_PORT),
    LOOPBACK_ENDPOINT: LB,
  });
  await waitFor(`${LB}/queue`);
  await waitFor(`${DEMO}/`);

  // Seed one item per STATUS and per SEVERITY, so every colour pair in the
  // design system is actually on screen when contrast is measured. Seeding a
  // single open/p3 item measured 1 of 6 status pairs and 1 of 4 severities —
  // the pale --lb-fixed regression that motivated this gate would have passed.
  const STATUSES = ["open", "triaged", "in_progress", "fixed", "verified", "wontfix"];
  const SEVERITIES = ["p0", "p1", "p2", "p3"];
  const seeded = [];
  for (let i = 0; i < STATUSES.length; i++) {
    const res = await fetch(`${LB}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "acme-demo", type: "ui",
        severity: SEVERITIES[i % SEVERITIES.length],
        title: `Seed ${STATUSES[i]} / ${SEVERITIES[i % SEVERITIES.length]}`,
        body: "Rendered so every status and severity pair is measured.",
        // route must match the demo page the widget actually loads on, or the
        // widget queries a route with no items and renders no pins at all.
        dom_selector: "h1", route: "/", source: "widget", reporter: "human",
      }),
    });
    seeded.push((await res.json()).id);
  }
  // Move each into its target status so all six badge pairs render.
  for (let i = 0; i < seeded.length; i++) {
    const status = STATUSES[i];
    if (status === "open") continue;
    await fetch(`${LB}/queue/${seeded[i]}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status, note: "seed", author: "a11y-gate" }),
    });
  }
  const detailSeed = seeded[0];

  const LB_EXPECTED = LB;
  const browser = await chromium.launch();
  try {
    // ---------- dashboard, desktop ----------
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${LB}/queue`);
    await page.waitForSelector("tbody tr");
    await page.evaluate(KILL_MOTION);
    const desktop = await page.evaluate(MEASURE);

    // Measure the HOVERED row too: shadcn's TableRow tints to bg-muted/50, which
    // lowers the effective background contrast of every cell in it. The resting
    // state was the only thing ever checked.
    // A REAL pointer hover. Adding "bg-muted/50" as a class does nothing —
    // Tailwind only ever generated the `hover:` variant of that utility, so the
    // bare class has no rule behind it and the "hovered" measurement was just
    // the resting state again.
    // EVERY row, not the first. Severities are seeded round-robin, so hovering
    // only `tbody tr` measured p0 and never reached p3 — the one the audit
    // measured failing at 4.35:1.
    const rowCount = await page.evaluate(() => document.querySelectorAll("tbody tr").length);
    const hoverFails = [];
    for (let r = 0; r < rowCount; r++) {
      await page.hover(`tbody tr:nth-child(${r + 1})`);
      await page.waitForTimeout(40);
      const h = await page.evaluate(MEASURE);
      hoverFails.push(...h.contrastLight, ...h.contrastDark);
    }
    await page.mouse.move(0, 0);
    check(hoverFails.length === 0,
      `queue: no contrast failures on any of ${rowCount} HOVERED rows${
        hoverFails.length ? ` — ${JSON.stringify(hoverFails.slice(0, 4))}` : ""
      }`);

    check(desktop.contrastLight.length === 0,
      `queue: no contrast failures in light${desktop.contrastLight.length ? ` — ${JSON.stringify(desktop.contrastLight)}` : ""}`);
    check(desktop.contrastDark.length === 0,
      `queue: no contrast failures in dark${desktop.contrastDark.length ? ` — ${JSON.stringify(desktop.contrastDark)}` : ""}`);
    check(desktop.smallTargets.length === 0,
      `queue: every target clears 24x24 (SC 2.5.8)${desktop.smallTargets.length ? ` — ${JSON.stringify(desktop.smallTargets)}` : ""}`);
    check(desktop.unnamed.length === 0,
      `queue: every control has an accessible name${desktop.unnamed.length ? ` — ${JSON.stringify(desktop.unnamed)}` : ""}`);
    check(desktop.hasMain, "queue: has a <main> landmark");

    // SC 1.4.11 for the control BOUNDARY. Every input, textarea and select in
    // the product is identified by its 1px border alone — no fill
    // differentiation — and the only non-text contrast check here was the focus
    // ring, so a 1.26:1 boundary cleared every assertion in this file.
    const boundaries = await page.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      const rgba = (c) => { ctx.fillStyle = "#f0f"; ctx.fillStyle = c;
        ctx.clearRect(0,0,1,1); ctx.fillRect(0,0,1,1);
        const d = ctx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
      const over = (f,b) => [0,1,2].map(i => f[i]*f[3] + b[i]*(1-f[3])).concat(1);
      const lum = ([r,g,b]) => { const f = (c) => { c/=255;
        return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
        return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
      const ratio = (a,b) => { const x=lum(a),y=lum(b); const [hi,lo]=x>y?[x,y]:[y,x];
        return (hi+0.05)/(lo+0.05); };
      const bgOf = (el) => { let n = el.parentElement;
        while (n) { const c = rgba(getComputedStyle(n).backgroundColor);
          if (c[3] > 0.95) return c; n = n.parentElement; }
        return rgba(getComputedStyle(document.body).backgroundColor); };
      const out = [];
      const check = () => {
        document.querySelectorAll("input, textarea, select, [role=combobox]").forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || !el.getBoundingClientRect().width) return;
          const w = parseFloat(cs.borderTopWidth) || 0;
          if (w === 0) return; // filled controls are identified another way
          const r = ratio(over(rgba(cs.borderTopColor), bgOf(el)), bgOf(el));
          if (r < 3) out.push({ el: el.tagName.toLowerCase(), ratio: +r.toFixed(2) });
        });
      };
      const root = document.documentElement;
      root.classList.remove("dark"); void document.body.offsetHeight; check();
      root.classList.add("dark"); void document.body.offsetHeight; check();
      root.classList.remove("dark");
      return out;
    });
    check(boundaries.length === 0,
      `form controls have a 3:1 boundary in both themes (SC 1.4.11)${
        boundaries.length ? ` — ${JSON.stringify(boundaries.slice(0, 4))}` : ""
      }`);

    // SC 1.4.11: the focus INDICATOR itself needs 3:1 against what it sits on.
    // Nothing checked it, and shadcn's stock ring is `ring-ring/50` — half
    // opacity over a mid-grey --ring, which lands near 1.5:1 on the very
    // controls that are the keyboard-only route into a row.
    // Real keyboard focus: :focus-visible is what the outline rule keys on, and
    // element.focus() does not set it. Tab until a button in the table has it.
    await page.evaluate(() => document.body.focus());
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const onButton = await page.evaluate(
        () => document.activeElement?.tagName === "BUTTON" &&
              document.activeElement.matches(":focus-visible"),
      );
      if (onButton) break;
    }
    const focusRing = await page.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      const rgb = (c) => { ctx.fillStyle = "#f0f"; ctx.fillStyle = c;
        ctx.clearRect(0,0,1,1); ctx.fillRect(0,0,1,1);
        const d = ctx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
      const lum = ([r,g,b]) => { const f = (c) => { c/=255;
        return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
        return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
      const over = (fg,bg) => [0,1,2].map(i => fg[i]*fg[3] + bg[i]*(1-fg[3])).concat(1);
      const ratio = (a,b) => { const x=lum(a),y=lum(b); const [hi,lo]=x>y?[x,y]:[y,x];
        return (hi+0.05)/(lo+0.05); };

      // Focus a real control and read what is actually painted around it.
      const target = document.activeElement;
      if (!target || target === document.body) return null;
      const measure = () => {
        const cs = getComputedStyle(target);
        const bg = rgb(getComputedStyle(document.body).backgroundColor);
        const width = parseFloat(cs.outlineWidth) || 0;
        const style = cs.outlineStyle;
        const colour = rgb(cs.outlineColor);
        return {
          width, style,
          ratio: +ratio(over(colour, bg), bg).toFixed(2),
        };
      };
      const root = document.documentElement;
      root.classList.remove("dark"); void document.body.offsetHeight;
      const light = measure();
      root.classList.add("dark"); void document.body.offsetHeight;
      const dark = measure();
      root.classList.remove("dark"); void document.body.offsetHeight;
      return { light, dark };
    });
    for (const theme of ["light", "dark"]) {
      const f = focusRing?.[theme];
      check(
        !!f && f.style !== "none" && f.width >= 1 && f.ratio >= 3,
        `queue (${theme}): focus indicator is painted and clears 3:1 (SC 1.4.11) — ${
          f ? `${f.width}px ${f.style}, ${f.ratio}:1` : "no focusable control found"
        }`,
      );
    }

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
    const detail = detailSeed;
    await fetch(`${LB}/feedback/${detail}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "https://traces.example.dev/run/" + "z".repeat(120),
        body: "https://traces.example.dev/very/long/" + "y".repeat(160),
        author: "a11y-gate",
      }),
    });
    // Exercise the QUEUE with the long title too. The previous version PATCHed
    // a long title and then only loaded the detail route, so the phone card —
    // which was genuinely overflowing — was never measured.
    await page.goto(`${LB}/queue`);
    await page.waitForSelector("tbody tr, .grid button");
    await page.evaluate(KILL_MOTION);
    const queueLong = await page.evaluate(MEASURE);
    check(!queueLong.horizontalOverflow,
      `queue at 375px with a 120-char unbroken title: no page overflow${queueLong.horizontalOverflow ? ` — ${JSON.stringify(queueLong.horizontalOverflow)}` : ""}`);

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
    check(item.unnamed.length === 0,
      `detail: every control has an accessible name${item.unnamed.length ? ` — ${JSON.stringify(item.unnamed)}` : ""}`);
    check(item.title.includes(detail), "detail: route change set the document title");

    // SC 2.4.3 / 2.4.11: focus after a write. The gate asserted nothing about
    // this, and three of four write paths were dumping focus to <body> — the
    // comment in the code claimed otherwise for two of them.
    await page.goto(`${LB}/queue/${detail}`);
    await page.waitForSelector("#lb-comment");
    const focusAfter = async (label, act) => {
      await act();
      await page.waitForTimeout(700);
      const landed = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        return (
          a.getAttribute?.("data-lb-region") ??
          a.closest?.("[data-lb-region]")?.getAttribute("data-lb-region") ??
          a.tagName
        );
      });
      check(landed !== null, `focus stays in context after ${label} (landed on ${landed ?? "<body>"})`);
    };
    await focusAfter("a comment", async () => {
      await page.fill("#lb-comment", "gate probe");
      await page.click('button:has-text("Comment")');
    });
    await focusAfter("an edit save", async () => {
      await page.click('button:has-text("Edit")');
      await page.waitForSelector("#lb-edit-title");
      await page.click('button:has-text("Save")');
    });
    await focusAfter("a status change", async () => {
      await page.locator("[data-lb-region=status] button[role=combobox]").first().click();
      await page.waitForTimeout(250);
      await page.locator('[role=option]:has-text("triaged")').first().click();
    });

    // Seed a linked change. The zoom and overflow checks ran on an item with no
    // `links`, so the pr_url anchor — the one anchor in the file missing
    // break-all — was never rendered during a measurement. There is no HTTP
    // route for this; linking is MCP-only, and an earlier version of this seed
    // POSTed to a URL that does not exist and swallowed the 404.
    const linked = await fetch(`${LB}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "loopback_link_change",
          arguments: {
            id: detail,
            repo: "joshidikshant/loopback",
            branch: "main",
            commit: "abc1234def5678",
            pr_url: "https://github.com/joshidikshant/loopback/pull/1234",
          },
        },
      }),
    }).then((r) => r.json());
    check(
      !linked.error && !linked.result?.isError,
      `seeded a linked change so the pr_url anchor actually renders${linked.error ? ` — ${JSON.stringify(linked.error).slice(0, 120)}` : ""}`,
    );

    // Seed an attachment first. Every zoom and overflow assertion below used to
    // run on an item that had none, so the attachment UI — which carries two
    // fixed-px floors — was never in the measured state at all.
    await fetch(
      `${LB}/feedback/${detail}/attachments?name=logo-primary-on-dark-a8f3e91c4b7d2e6f5a0c9b8e7d6f5a4b.svg&intent=asset&target=public/logos/acme.svg`,
      { method: "POST", headers: { "Content-Type": "image/svg+xml" }, body: "<svg/>" },
    );

    // ---------- SC 1.4.4: 200% text-only zoom ----------
    // The gate only ever varied title and body, never the root font size — so a
    // header that could not shrink pushed the search input 81px off the LEFT
    // edge at 375px, with negative overflow and no scrollbar to recover it.
    // 320 is SC 1.4.10's reflow floor; 640 and 700 are where the attachment
    // upload row failed. And the EDIT FORM is opened below — no gate had ever
    // clicked into it, so a 33px overflow at 320px/200% went unseen.
    for (const width of [320, 375, 640, 700]) {
      await page.setViewportSize({ width, height: 812 });
      for (const route of ["/queue", `/queue/${detail}`]) {
        await page.goto(`${LB}${route}`);
        await page.waitForSelector("h1");
        await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
        await page.waitForTimeout(150);
      const zoomed = await page.evaluate(() => {
        const de = document.documentElement;
        const search = document.querySelector('input[aria-label="Search feedback"]');
        return {
          overflow: de.scrollWidth > de.clientWidth ? { s: de.scrollWidth, c: de.clientWidth } : null,
          offLeft: search ? Math.round(search.getBoundingClientRect().left) < 0 : false,
        };
      });
        check(!zoomed.overflow && !zoomed.offLeft,
          `${route} at ${width}px and 200% text zoom: nothing off-screen (SC 1.4.4/1.4.10)${
            zoomed.overflow ? ` — ${JSON.stringify(zoomed.overflow)}` : zoomed.offLeft ? " — search pushed off the left edge" : ""
          }`);
        await page.evaluate(() => (document.documentElement.style.fontSize = ""));
        // And at normal text size, which is where the pr_url anchor overflowed.
        await page.waitForTimeout(100);
        const plain = await page.evaluate(() => {
          const de = document.documentElement;
          return de.scrollWidth > de.clientWidth ? { s: de.scrollWidth, c: de.clientWidth } : null;
        });
        check(!plain, `${route} at ${width}px: no horizontal overflow${plain ? ` — ${JSON.stringify(plain)}` : ""}`);

        // The edit form is a whole surface the gate never entered.
        if (route.includes("/queue/")) {
          const edit = await page.$('button:has-text("Edit")');
          if (edit) {
            await edit.click();
            await page.waitForSelector("#lb-edit-title");
            await page.evaluate(() => (document.documentElement.style.fontSize = "32px"));
            await page.waitForTimeout(150);
            const inEdit = await page.evaluate(() => {
              const de = document.documentElement;
              return de.scrollWidth > de.clientWidth ? { s: de.scrollWidth, c: de.clientWidth } : null;
            });
            check(!inEdit,
              `edit form at ${width}px and 200% zoom: no horizontal overflow${inEdit ? ` — ${JSON.stringify(inEdit)}` : ""}`);
            await page.evaluate(() => (document.documentElement.style.fontSize = ""));
            const cancel = await page.$('button:has-text("Cancel")');
            if (cancel) await cancel.click();
          }
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---------- widget, on a host page ----------
    const wpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await wpage.goto(`${DEMO}/`);
    await wpage.waitForFunction(() => !!window.__loopback);
    const boundTo = await wpage.evaluate(() => window.__loopback.endpoint);
    check(boundTo === LB_EXPECTED, `widget is bound to THIS run's hub (${boundTo})`);
    // Enter pin mode, then drive the gesture with the REAL keyboard. Dispatching
    // synthetic KeyboardEvents only proves the listener is bound; it cannot show
    // the gesture is operable by an actual key press.
    await wpage.evaluate(() => {
      const sr = document.querySelector("#loopback-widget-host").shadowRoot;
      sr.querySelector(".fab").click();
      sr.querySelector(".pinbtn").click();
    });
    await wpage.keyboard.press("ArrowDown");
    await wpage.waitForTimeout(120);
    await wpage.keyboard.press("Enter");
    await wpage.waitForTimeout(200);
    const widget = await wpage.evaluate(() => {
      const host = [...document.querySelectorAll("*")].find((e) => e.shadowRoot);
      const sr = host.shadowRoot;
      const fab = sr.querySelector(".fab");
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
    // 6 controls: title, what-happened, expected, repro steps, type, severity.
    // The exact count is asserted, not a floor — a scan that reached an empty
    // or partial form would otherwise report "all 2 labelled" as a pass.
    check(widget.allLabelled && widget.controlCount === 6,
      `widget: all ${widget.controlCount} form controls have a real <label for>`);
    check(widget.openedByKeyboard, "widget: pin mode is operable by keyboard alone");
    check(widget.formRole === "dialog" && widget.formNamed, "widget: capture form is a named dialog");
    check(!widget.claimsModal, "widget: does not claim aria-modal without a focus trap");
    check(JSON.stringify(widget.liveRegions) === '["assertive","polite"]',
      `widget: has polite + assertive live regions (${widget.liveRegions})`);
    check(widget.smallestFont >= 16,
      `widget: inputs are >=16px so iOS does not zoom a fixed panel (${widget.smallestFont}px)`);
    check(widget.fabExpanded, "widget: the FAB exposes aria-expanded");

    // The shadow-piercing scan exists for THIS. It was only ever run on the
    // dashboard, which has no shadow roots, so the widget's own colours and
    // target sizes had never been measured by anything.
    // Hydrate pins and OPEN the panel before scanning. The keyboard-pin probe
    // above closes the panel and leaves no pins rendered, so the scan that
    // follows had nothing of the widget to look at.
    await wpage.evaluate(() => window.__loopback.refresh());
    await wpage.waitForFunction(
      () => document.querySelector("#loopback-widget-host")?.shadowRoot?.querySelectorAll(".pin").length > 0,
      { timeout: 8000 },
    );
    await wpage.evaluate(() => {
      const sr = document.querySelector("#loopback-widget-host").shadowRoot;
      sr.querySelector(".panel").classList.add("open");
    });
    const widgetParts = await wpage.evaluate(() => {
      const sr = document.querySelector("#loopback-widget-host").shadowRoot;
      return { pins: sr.querySelectorAll(".pin").length, badges: sr.querySelectorAll(".badge").length };
    });
    check(widgetParts.pins > 0 && widgetParts.badges > 0,
      `widget: pins and status badges are actually rendered before scanning (${widgetParts.pins} pins, ${widgetParts.badges} badges)`);

    await wpage.evaluate(KILL_MOTION);
    // The widget owns its theme via prefers-color-scheme (deliberately — it must
    // stay legible on any host page), so MEASURE's .dark class toggle does
    // nothing to it. Drive the media feature instead, or its dark palette is
    // never exercised at all.
    for (const scheme of ["light", "dark"]) {
      await wpage.emulateMedia({ colorScheme: scheme });
      await wpage.waitForTimeout(80);
      const m = await wpage.evaluate(MEASURE);
      const scanned = await wpage.evaluate(`(${DEEP_COUNT})()`);
      // Guard the guard: the widget renders pins and badges only when the hub
      // has items for this route. A scan that reached almost nothing proves
      // nothing, and that is exactly how this assertion passed while measuring
      // a foreign database.
      const inShadow = await wpage.evaluate(() => {
        const sr = document.querySelector("#loopback-widget-host").shadowRoot;
        return sr.querySelectorAll("*").length;
      });
      check(inShadow >= 20,
        `widget (${scheme}): scan reached inside the SHADOW ROOT (${inShadow} of ${scanned} elements)`);
      check(m.contrastLight.length === 0,
        `widget (${scheme}): no contrast failures${m.contrastLight.length ? ` — ${JSON.stringify(m.contrastLight)}` : ""}`);
      check(m.smallTargets.length === 0,
        `widget (${scheme}): every target clears 24x24${m.smallTargets.length ? ` — ${JSON.stringify(m.smallTargets)}` : ""}`);
    }
    await wpage.emulateMedia({ colorScheme: "light" });

    // ---------- the widget under a real viewport, not just 1280x800 ----------
    // Every widget assertion above ran at one large size, so the panel's
    // height was never constrained. `.form` clamps to min(72vh,460px) with
    // overflow:auto; `.panel` shipped with neither, and its primary action
    // fell below the fold on a landscape phone with no way to scroll to it.
    for (const [w, h] of [[320, 480], [568, 320], [375, 812]]) {
      await wpage.setViewportSize({ width: w, height: h });
      await wpage.waitForTimeout(120);
      // The earlier keyboard test leaves pin mode ON, and the fab's first
      // click EXITS pin mode rather than opening the panel — so a single
      // blind click measured a closed panel and reported it as unopenable.
      const open = await wpage.evaluate(() => {
        const sr = document.querySelector("#loopback-widget-host").shadowRoot;
        const fab = sr.querySelector(".fab");
        if (fab.classList.contains("pinmode")) fab.click();
        if (!sr.querySelector(".panel").classList.contains("open")) fab.click();
        return sr.querySelector(".panel").classList.contains("open");
      });
      await wpage.waitForTimeout(150);
      const fit = await wpage.evaluate(() => {
        const sr = document.querySelector("#loopback-widget-host").shadowRoot;
        const p = sr.querySelector(".panel");
        if (!p || getComputedStyle(p).display === "none") return null;
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        return {
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          right: Math.round(r.right), left: Math.round(r.left),
          scrollable: p.scrollHeight > p.clientHeight + 1,
          overflowY: cs.overflowY,
        };
      });
      if (open && fit) {
        // Reachability, not just visibility: content past the fold is fine IF
        // the container scrolls. Unreachable content is the failure.
        const vertOk = (fit.top >= 0 && fit.bottom <= h) || fit.overflowY === "auto" || fit.overflowY === "scroll";
        const horizOk = fit.left >= 0 && fit.right <= w;
        check(vertOk, `widget panel at ${w}x${h}: fully reachable (top ${fit.top}, bottom ${fit.bottom}, overflow-y ${fit.overflowY})`);
        check(horizOk, `widget panel at ${w}x${h}: within the viewport horizontally (${fit.left}..${fit.right} of ${w})`);
      } else {
        check(false, `widget panel at ${w}x${h}: opened and measurable`);
      }
      const mm = await wpage.evaluate(MEASURE);
      check(mm.smallTargets.length === 0,
        `widget at ${w}x${h}: every target clears 24x24${mm.smallTargets.length ? ` — ${JSON.stringify(mm.smallTargets)}` : ""}`);
      await wpage.evaluate(() => {
        const sr = document.querySelector("#loopback-widget-host").shadowRoot;
        if (sr.querySelector(".panel").classList.contains("open")) sr.querySelector(".fab").click();
      });
    }
    await wpage.setViewportSize({ width: 1280, height: 800 });

    // ---------- the onboarding tip retires, permanently ----------
    // It sits position:fixed OVER host content, so "shown on every visit" was
    // the P1. First visit: revealed on hover/focus. After a filed report or an
    // explicit dismissal, a stored flag must keep it away on every future load.
    // Both directions, because a tip that never shows fails onboarding and a
    // flag that is never honoured fails the host page. (No KILL_MOTION here —
    // document-level styles do not pierce the shadow root; the .12s transition
    // is simply waited out.)
    await wpage.evaluate(() => localStorage.removeItem("lb-tip-done"));
    await wpage.reload();
    await wpage.waitForSelector("#loopback-widget-host", { state: "attached" });
    await wpage.hover("#loopback-widget-host .fab");
    await wpage.waitForTimeout(350);
    const tipFresh = await wpage.evaluate(() => {
      const sr = document.querySelector("#loopback-widget-host").shadowRoot;
      const cs = getComputedStyle(sr.querySelector(".tip"));
      return { opacity: cs.opacity, display: cs.display };
    });
    check(
      tipFresh.display !== "none" && tipFresh.opacity === "1",
      `tip: first visit reveals it on hover (display ${tipFresh.display}, opacity ${tipFresh.opacity})`,
    );
    await wpage.evaluate(() => localStorage.setItem("lb-tip-done", "1"));
    await wpage.reload();
    await wpage.waitForSelector("#loopback-widget-host", { state: "attached" });
    await wpage.hover("#loopback-widget-host .fab");
    await wpage.waitForTimeout(350);
    const tipRetired = await wpage.evaluate(() => {
      const sr = document.querySelector("#loopback-widget-host").shadowRoot;
      return getComputedStyle(sr.querySelector(".tip")).display;
    });
    check(
      tipRetired === "none",
      `tip: the retired flag is honoured across loads, hover included (display ${tipRetired})`,
    );

    // ---------- the delete-confirm dialog ----------
    // No gate ever opened it. It is position:fixed, so its overflow never
    // reaches documentElement.scrollWidth — a title 215px past the right edge
    // at 320px was invisible to every overflow check in this file, on the one
    // irreversible action in the product.
    await page.setViewportSize({ width: 320, height: 812 });
    await page.goto(`${LB}/queue/${detail}`);
    await page.waitForSelector('[aria-label^="Remove attachment"]');
    await page.click('[aria-label^="Remove attachment"]');
    await page.waitForSelector("[role=alertdialog]");
    await page.evaluate(KILL_MOTION);
    const dialog = await page.evaluate(() => {
      const el = document.querySelector("[role=alertdialog]");
      const r = el.getBoundingClientRect();
      const title = el.querySelector("h2, [data-slot=alert-dialog-title]");
      const tr = title?.getBoundingClientRect();
      return {
        spillRight: Math.round(r.right - window.innerWidth),
        titleSpill: tr ? Math.round(tr.right - window.innerWidth) : 0,
        readable: tr ? tr.right <= window.innerWidth + 1 : false,
      };
    });
    check(dialog.spillRight <= 0 && dialog.readable,
      `delete-confirm fits the 320px viewport — the user can read WHICH file (dialog ${dialog.spillRight}px, title ${dialog.titleSpill}px past the edge)`);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 800 });

    // ---------- the PUBLISHED vanilla recipe ----------
    // design/components.css is shipped to adopters as @loopback/loopback-components
    // and no gate has ever rendered it — which is how .lb-sev--p0 came to measure
    // 4.38:1 on a hovered .lb-table row while every other surface was clean.
    const recipe = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const tokensCss = readFileSync(join(ROOT, "design", "tokens.css"), "utf-8");
    const componentsCss = readFileSync(join(ROOT, "design", "components.css"), "utf-8");
    await recipe.setContent(`<!doctype html><html><head><style>
      ${tokensCss}
      ${componentsCss}
    </style></head><body class="lb-body">
      <table class="lb-table"><tbody>
        <tr>
          <td><span class="lb-sev lb-sev--p0">p0</span> <span class="lb-sev lb-sev--p1">p1</span>
              <span class="lb-sev lb-sev--p2">p2</span> <span class="lb-sev lb-sev--p3">p3</span></td>
          <td><span class="lb-badge lb-badge--open">open</span>
              <span class="lb-badge lb-badge--triaged">triaged</span>
              <span class="lb-badge lb-badge--in_progress">in_progress</span>
              <span class="lb-badge lb-badge--fixed">fixed</span>
              <span class="lb-badge lb-badge--verified">verified</span>
              <span class="lb-badge lb-badge--wontfix">wontfix</span></td>
          <td><span class="lb-muted">muted text</span> <code class="lb-mono">mono</code></td>
        </tr>
      </tbody></table>
      <button class="lb-btn lb-btn--destructive">destructive</button>
      <div class="lb-pin lb-pin--fixed">1</div>
      <div class="lb-pin lb-pin--verified">2</div>
    </body></html>`);
    // A REAL hover, driven by the mouse. An earlier version injected a style tag
    // that hardcoded the tint — so it measured that tag rather than the file,
    // and reverting the fix in components.css still passed. The whole point is
    // to measure what the published file actually does.
    await recipe.hover("tbody tr");
    await recipe.waitForTimeout(80);
    // KILL_MOTION here too. .lb-btn carries a 0.15s colour transition, so
    // toggling the theme and measuring 60ms later read a mid-transition value —
    // 3.28:1 for a pair that is genuinely 6.21:1. The same trap this file
    // documents at the top, on a page added later that did not inherit the fix.
    await recipe.evaluate(KILL_MOTION);
    // ONE evaluate. MEASURE toggles .dark itself and strips it again before
    // returning, so an outer loop that set the class was undone from the inside
    // — and both iterations then asserted contrastLight, meaning the "(dark)"
    // line measured light twice. Proven inert by canary: a 1.04:1 dark-mode
    // failure in components.css printed green.
    const recipeM = await recipe.evaluate(MEASURE);
    check(recipeM.contrastLight.length === 0,
      `published recipe (light): every class clears contrast on a hovered row${
        recipeM.contrastLight.length ? ` — ${JSON.stringify(recipeM.contrastLight)}` : ""
      }`);
    check(recipeM.contrastDark.length === 0,
      `published recipe (dark): every class clears contrast on a hovered row${
        recipeM.contrastDark.length ? ` — ${JSON.stringify(recipeM.contrastDark)}` : ""
      }`);
    // components.css ships its OWN reduced-motion block, and nothing exercised
    // it — the assertion below this one probes the dashboard, whose rule comes
    // from Tailwind. The shipped rule is deliberately not `animation: none`
    // alone: it swaps the moving pin for a steady ring so "this one changed"
    // still reads. Both halves are asserted, because deleting the ring while
    // keeping the animation kill would silently drop the signal.
    // A FRESH page. The recipe page above has KILL_MOTION injected for the
    // contrast pass — `animation:none!important` on everything — so probing it
    // there measured the gate's own stylesheet: the assertion printed
    // "name none, duration 0s" identically with the components.css block
    // deleted. Reduced motion cannot be measured on a page whose motion was
    // already killed by hand.
    const rmr = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await rmr.emulateMedia({ reducedMotion: "reduce" });
    await rmr.setContent(`<!doctype html><html><head><style>
      ${tokensCss}
      ${componentsCss}
    </style></head><body class="lb-body"></body></html>`);
    await rmr.waitForTimeout(60);
    const rmRecipe = await rmr.evaluate(() => {
      const el = document.createElement("span");
      el.className = "lb-pin lb-pin--changed";
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { name: cs.animationName, dur: cs.animationDuration, shadow: cs.boxShadow };
      el.remove();
      return out;
    });
    check(rmRecipe.name === "none" || parseFloat(rmRecipe.dur) < 0.05,
      `components.css: reduced motion stops the changed-pin animation (name ${rmRecipe.name}, duration ${rmRecipe.dur})`);
    // Geometry, not a colour-function name: the deleted-block run produced
    // `oklab(...) 0px 0px 0px 0px` — a shadow string that is present but has
    // zero spread, i.e. invisible. A substring test on the colour syntax
    // failed it for the wrong reason and would have passed any non-empty ring.
    const spread = Math.max(
      0,
      ...[...rmRecipe.shadow.matchAll(/(-?[\d.]+)px/g)].map((m) => parseFloat(m[1])),
    );
    check(spread >= 2,
      `components.css: the still state keeps a visible ring, not nothing (spread ${spread}px)`);
    await rmr.close();
    await recipe.close();

    // ---------- reduced motion is honoured where the motion actually is ----------
    const rm = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await rm.emulateMedia({ reducedMotion: "reduce" });
    await rm.goto(`${LB}/queue`);
    await rm.waitForSelector("tbody tr");
    // Assert the EFFECT, not the presence of a rule. Counting rules let
    // sonner's injected stylesheet satisfy this while the repo's own rule could
    // have been deleted with the gate still green.
    const motion = await rm.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "animate-pulse";
      document.body.appendChild(probe);
      const dur = getComputedStyle(probe).animationDuration;
      probe.remove();
      return { pulseDuration: dur };
    });
    const seconds = parseFloat(motion.pulseDuration) || 0;
    check(seconds > 0 && seconds < 0.05,
      `dashboard: reduced motion actually shortens an animation (animate-pulse = ${motion.pulseDuration})`);
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
