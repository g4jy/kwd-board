// T089: 펜 흔적이 자료와 같이 움직이는지 — node scripts/t089-probe.mjs <fixture> <outprefix> [base]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [fx, out, base = 'http://localhost:4173/'] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1366, height: 820 } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${base}#/b/t089${Date.now().toString(36)}?r=t&st=1`);
await p.waitForFunction(() => !!window.__kwd); await p.waitForTimeout(800);
await p.evaluate((h) => window.__kwd.placeHtml(h, '자료'), fs.readFileSync(fx, 'utf8'));
await p.waitForTimeout(2500);
await p.evaluate(() => { const k = window.__kwd; const o = k.objs(k.pages()[0].id).find((x) => x.type === 'html'); k.vp.set({ x: 40 - o.x, y: 90 - o.y, s: 1 }); });
await p.waitForTimeout(500);
const info = () => p.evaluate(() => { const k = window.__kwd; const o = k.objs(k.pages()[0].id).find((x) => x.type === 'html'); const f = document.querySelector('.obj-frame'); const r = f.getBoundingClientRect(); return { o: { x: o.x, y: o.y, w: o.w, h: o.h, step: o.step, steps: o.steps }, frame: [r.left|0, r.top|0, r.width|0, r.height|0], boxes: k.boxes().map((q) => [q.id.slice(0, 12), q.x|0, q.y|0, q.w|0, q.h|0]) }; });
console.log(JSON.stringify(await info()));
await p.screenshot({ path: out + '_0.png' });
await p.click('.tb-pens > * >> nth=0');
const r = (await info()).frame;
const x0 = r[0] + 80, y0 = r[1] + 120;
await p.mouse.move(x0, y0); await p.mouse.down();
for (let i = 1; i <= 15; i++) await p.mouse.move(x0 + i * 15, y0 + Math.sin(i / 2) * 20);
await p.mouse.up(); await p.waitForTimeout(400);
const inkCount = () => p.evaluate(() => { const d = window.__kwd.store.doc; const o = {}; for (const [k, v] of d.share) if (k.startsWith('ink:') && v.length) o[k.slice(0, 22)] = v.length; return o; });
console.log('ink after draw', JSON.stringify(await inkCount()));
await p.screenshot({ path: out + '_1draw.png' });
// 넘기기: 안쪽 다음 버튼
const fr = p.frameLocator('.obj-frame');
if (await fr.locator('#next').count()) { await fr.locator('#next').click(); await p.waitForTimeout(700); console.log('after next', JSON.stringify(await info())); await p.screenshot({ path: out + '_2next.png' }); await fr.locator('#prev').click(); await p.waitForTimeout(700); await p.screenshot({ path: out + '_3back.png' }); }
else { await p.setTool?.call; await p.evaluate(() => window.__kwd.setTool('select')); await p.mouse.move(r[0] + 200, r[1] + 300); await p.mouse.wheel(0, 300); await p.waitForTimeout(700); console.log('after wheel', JSON.stringify(await info())); await p.screenshot({ path: out + '_2scroll.png' }); }
console.log('errs', JSON.stringify(errs)); await b.close();
