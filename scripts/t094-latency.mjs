// T094 획 지연 측정: node scripts/t094-latency.mjs [주소]  (펜 mouse 이벤트 → 다음 화면 갱신까지 ms)
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:4173';
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${url}/#/b/lat${Date.now()}?r=t&st=5`);
await p.waitForFunction(() => window.__kwd);
await p.click('.tb-pens > * >> nth=0');
const c = await ctx.newCDPSession(p);
const pen = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: 0.4 });
const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
await pen('mousePressed', 300, 400);
const ms = [];
for (let i = 1; i <= 150; i++) { const t = Date.now(); await pen('mouseMoved', 300 + i * 4, 400 + Math.sin(i / 8) * 60); await frame(); ms.push(Date.now() - t); }
await pen('mouseReleased', 900, 400);
const n = await p.evaluate(() => window.__kwd.store.doc.getArray('ink:' + window.__kwd.pages()[0].id).length);
ms.sort((a, z) => a - z);
console.log('획', n, '평균ms', (ms.reduce((a, z) => a + z, 0) / ms.length).toFixed(1), '중앙', ms[75], 'p95', ms[142], '오류', errs.length);
await b.close();
