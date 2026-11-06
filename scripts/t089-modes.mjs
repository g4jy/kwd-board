// T089: 자료 종류별 그리기→넘기기/스크롤→돌아오기. node scripts/t089-modes.mjs <outdir> [base]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [OUT, base = 'http://localhost:4173/'] = process.argv.slice(2); fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const FX = 'tests/fixtures/';
const results = [];
async function run(name, file, vp, how) {
  const ctx = await b.newContext({ viewport: vp });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}#/b/t089${Date.now().toString(36)}?r=t&st=1`);
  await p.waitForFunction(() => !!window.__kwd); await p.waitForTimeout(700);
  await p.evaluate((h) => window.__kwd.placeHtml(h, '자료'), fs.readFileSync(FX + file, 'utf8'));
  await p.waitForTimeout(2200);
  await p.evaluate(() => { const k = window.__kwd; const o = k.objs(k.pages()[0].id).find((x) => x.type === 'html'); k.vp.set({ x: 20 - o.x, y: 80 - o.y, s: 1 }); });
  await p.waitForTimeout(400);
  const st = () => p.evaluate(() => { const k = window.__kwd; const o = k.objs(k.pages()[0].id).find((x) => x.type === 'html'); const d = k.store.doc; const ink = {}; for (const [kk, v] of d.share) if (kk.startsWith('ink:ws:') && v.length) ink[kk.replace(/^ink:ws:\w+:/, '')] = v.length; const lay = k.boxes().filter((q) => q.id.startsWith('ws:')).map((q) => q.id.replace(/^ws:\w+:/, ''))[0]; const f = document.querySelector('.obj-frame').getBoundingClientRect(); return { step: o.step, view: o.view || '', h: o.h, layer: lay, ink, frame: [f.left, f.top, f.width, f.height] }; });
  const s0 = await st();
  await p.click('.tb-pens > * >> nth=0');
  const [fx, fy] = [s0.frame[0] + 90, s0.frame[1] + 110];
  await p.mouse.move(fx, fy); await p.mouse.down(); for (let i = 1; i <= 14; i++) await p.mouse.move(fx + i * 14, fy + Math.sin(i / 2) * 16); await p.mouse.up(); await p.waitForTimeout(400);
  const s1 = await st(); await p.screenshot({ path: `${OUT}/${name}_1draw.png` });
  const s2 = await how(p, 'away'); await p.waitForTimeout(900); const sa = await st(); await p.screenshot({ path: `${OUT}/${name}_2away.png` });
  await how(p, 'back'); await p.waitForTimeout(900); const sb = await st(); await p.screenshot({ path: `${OUT}/${name}_3back.png` });
  results.push({ name, vp: vp.width, draw: s1.layer, away: sa.layer, back: sb.layer, ink: sb.ink, h0: s0.h, hAway: sa.h, ok: s1.layer !== sa.layer || sa.frame[1] !== s1.frame[1] ? (sb.layer === s1.layer) : false, errs });
  await ctx.close();
}
const inFrame = (p) => p.frameLocator('.obj-frame');
const sel = (p) => p.evaluate(() => window.__kwd.setTool('select'));
const VPS = [['pc', { width: 1366, height: 820 }], ['tab', { width: 1024, height: 768 }], ['phone', { width: 390, height: 780 }]];
for (const [vn, vp] of VPS) {
  await run('slides_' + vn, 'slides61.html', vp, async (p, w) => { await inFrame(p).locator(w === 'away' ? '#next' : '#prev').evaluate((el) => el.click()); });
  await run('deck_' + vn, 'deck.html', vp, async (p, w) => { await p.frameLocator('.obj-frame').locator('.deck').evaluate((el, ww) => { el.scrollTo({ left: ww === 'away' ? el.clientWidth : 0, behavior: 'instant' }); }, w); });
  await run('inner_' + vn, 'inner.html', vp, async (p, w) => { await sel(p); const r = await p.evaluate(() => { const f = document.querySelector('.obj-frame').getBoundingClientRect(); return [f.left + 200, f.top + 200]; }); await p.mouse.move(r[0], r[1]); await p.mouse.wheel(0, w === 'away' ? 500 : -500); });
  await run('page_' + vn, 'page61.html', vp, async (p, w) => { await sel(p); const r = await p.evaluate(() => { const f = document.querySelector('.obj-frame').getBoundingClientRect(); return [f.left + 200, f.top + 200]; }); await p.mouse.move(r[0], r[1]); await p.mouse.wheel(0, w === 'away' ? 300 : -300); });
}
for (const r of results) console.log(JSON.stringify(r));
await b.close();
