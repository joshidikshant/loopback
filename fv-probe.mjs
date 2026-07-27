import { chromium, firefox, webkit } from 'playwright';

const html = `<!doctype html><html><head><style>
/* mirrors dashboard/src/index.css:64  * { @apply border-border outline-ring/50 } */
* { box-sizing:border-box; border:0 solid #ccc; outline-color: color-mix(in oklab, oklch(0.708 0 0) 50%, transparent); }
body{font-family:sans-serif;padding:20px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;background:#fafafa}
</style></head><body>
<div class="card" data-slot="card" id="card">
  <textarea id="ta">hello</textarea>
  <button id="btn">Comment</button>
</div>
<script>
const btn=document.getElementById('btn'), card=document.getElementById('card');
btn.addEventListener('click',()=>{
  // exactly what run() does: control self-disables, focus falls back to the card
  btn.disabled=true;
  requestAnimationFrame(()=>{
    card.setAttribute('tabindex','-1');
    card.focus({preventScroll:true});
    const cs=getComputedStyle(card);
    window.__r={active:document.activeElement.id,
      fv:card.matches(':focus-visible'),
      f:card.matches(':focus'),
      outline:cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor};
  });
});
</script></body></html>`;

for (const [name, t] of [['chromium',chromium],['firefox',firefox],['webkit',webkit]]) {
  let b;
  try { b = await t.launch(); } catch (e) { console.log(name, 'UNAVAILABLE', e.message.split('\n')[0]); continue; }
  const p = await b.newPage();
  await p.setContent(html);
  // pure keyboard path: tab to the button, press Enter
  await p.keyboard.press('Tab');            // textarea
  await p.keyboard.press('Tab');            // button
  const beforeFv = await p.evaluate(()=>document.activeElement.matches(':focus-visible'));
  await p.keyboard.press('Enter');
  await p.waitForFunction(()=>window.__r);
  const r = await p.evaluate(()=>window.__r);
  console.log(name, 'button-was-focus-visible=' + beforeFv, JSON.stringify(r));
  await b.close();
}
