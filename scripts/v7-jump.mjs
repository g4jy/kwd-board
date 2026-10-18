// 도구를 바꿔도 화면이 움직이지 않는지 (선택 ↔ 글 ↔ 펜)
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
await p.goto(`${BASE}/#/demo`);
await p.click('.demo-card.main');
await p.waitForSelector('.lesson-row');
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd?.store?.meta?.get('demoReady'), null, { timeout: 30000 });
await p.waitForTimeout(800);
const v = () => p.evaluate(() => { const w = window.__kwd.vp.view; const st = document.querySelector('.stage'); return [Math.round(w.x), Math.round(w.y), +w.s.toFixed(3), st?.scrollTop | 0, st?.scrollLeft | 0].join(','); });
await p.locator('.rail-item').nth(3).click();
await p.waitForTimeout(900);
const out = { start: await v() };
for (const t of ['select', 'text', 'select', 'text', 'pen', 'text']) {
  const btn = p.locator(`.toolbar [data-tool="${t}"], .toolbar [data-slot="0"]`).first();
  if (t === 'pen') await p.click('.toolbar [data-slot="0"]'); else await p.click(`.toolbar [data-tool="${t}"]`);
  await p.waitForTimeout(400);
  out[t + Object.keys(out).length] = await v();
}
console.log(JSON.stringify(out));
await b.close();
