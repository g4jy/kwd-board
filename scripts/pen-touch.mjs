// 루프 6: 태블릿 펜(필압) + 손바닥/손가락 — 펜은 그리고, 손가락은 이동·확대만
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`http://localhost:4173/#/b/pen${Date.now()}?r=t&st=5`);
await p.waitForFunction(() => window.__kwd);
await p.click('.tb-pens > * >> nth=0');
const c = await ctx.newCDPSession(p);
const pid = () => window.__kwd.pages()[0].id;
const inkN = () => p.evaluate((f) => window.__kwd.store.doc.getArray('ink:' + window.__kwd.pages()[0].id).length);
const pen = async (type, x, y, force) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });
await pen('mousePressed', 300, 300, 0.2);
for (let i = 1; i <= 20; i++) await pen('mouseMoved', 300 + i * 12, 300 + Math.sin(i / 3) * 10, 0.2 + i * 0.035);
await pen('mouseReleased', 540, 300, 0);
const afterPen = await inkN();
const stroke = await p.evaluate(() => { const a = window.__kwd.store.doc.getArray('ink:' + window.__kwd.pages()[0].id).toArray(); const s = a[a.length - 1]; const pts = s.pts || s.points || []; return { keys: Object.keys(s), n: pts.length, sample: JSON.stringify(pts).slice(0, 120) }; });
// S펜 옆 버튼 누르고 긋기 → 방금 획 지움 (확대 뒤라 획 위치를 화면 좌표로 계산)
const sp = await p.evaluate(() => { const a = window.__kwd.store.doc.getArray('ink:' + window.__kwd.pages()[0].id).toArray(); const s = a[a.length - 1]; const b = window.__kwd.boxes()[0]; return window.__kwd.vp.toScreen(b.x + s.pts[30], b.y + s.pts[31]); });
await p.evaluate(() => { window.__dbg = []; document.addEventListener('pointerdown', (e) => window.__dbg.push([e.pointerType, e.button, e.buttons, e.target.tagName, e.clientX|0, e.clientY|0]), true); });
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp[0], y: sp[1] - 30, button: 'right', buttons: 2, clickCount: 1, pointerType: 'pen', force: 0.5 });
for (let i = 1; i <= 8; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp[0], y: sp[1] - 30 + i * 8, button: 'right', buttons: 2, pointerType: 'pen', force: 0.5 });
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp[0], y: sp[1] + 34, button: 'right', buttons: 0, clickCount: 1, pointerType: 'pen' });
const afterSide = await inkN();

await pen('mousePressed', 300, 300, 0.3);
for (let i = 1; i <= 10; i++) await pen('mouseMoved', 300 + i * 12, 300, 0.5);
await pen('mouseReleased', 420, 300, 0);
const vp0 = await p.evaluate(() => JSON.stringify(window.__kwd.vp.get ? window.__kwd.vp.get() : window.__kwd.vp));
// 한 손가락 끌기 → 이동이어야 함(그림 아님)
const touch = (type, pts) => c.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
await touch('touchStart', [[600, 500]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[600, 500 - i * 15]]);
await touch('touchEnd', []);
const afterFinger = await inkN();
const vp1 = await p.evaluate(() => JSON.stringify(window.__kwd.vp.get ? window.__kwd.vp.get() : window.__kwd.vp));
// 두 손가락 벌리기 → 확대
await touch('touchStart', [[500, 400], [700, 400]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[500 - i * 10, 400], [700 + i * 10, 400]]);
await touch('touchEnd', []);
const afterPinch = await inkN();
const zoom = await p.textContent('.zoom');
console.log(JSON.stringify({ afterPen, stroke, afterFinger, afterPinch, afterSide, vp0, vp1, zoom, errs }));
await p.screenshot({ path: 'test-results/pen-touch.png' });
await b.close();
