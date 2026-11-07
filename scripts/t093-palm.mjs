// T093 팜리젝션 시험: node scripts/t093-palm.mjs <출력폴더> [주소]
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] || 'shots'; const url = process.argv[3] || 'http://localhost:4173';
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
let ok = 0, tot = 0; const chk = (n, c, d = '') => { tot++; if (c) ok++; console.log(c ? 'PASS' : 'FAIL', n, d); };
for (const [name, vw, vh] of [['phone390', 390, 800], ['tablet', 1180, 820]]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${url}/#/b/palm${Date.now()}?r=t&st=5`);
  await p.waitForFunction(() => window.__kwd);
  await p.click('.tb-pens > * >> nth=0');
  const c = await ctx.newCDPSession(p);
  const inkN = () => p.evaluate(() => window.__kwd.store.doc.getArray('ink:' + window.__kwd.pages()[0].id).length);
  const touch = (type, pts) => c.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const pen = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: 0.4 });
  const x0 = vw / 2 - 60, y0 = vh / 2;
  // 1) 큰 접촉(손바닥)
  let n0 = await inkN();
  await touch('touchStart', [{ x: x0, y: y0, id: 1, radiusX: 40, radiusY: 40 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: x0 + i * 8, y: y0, id: 1, radiusX: 40, radiusY: 40 }]);
  await touch('touchEnd', []);
  chk(name + ' 큰 접촉 선 0', (await inkN()) === n0);
  // 2) 손가락 하나 그려짐(펜 없음)
  n0 = await inkN();
  await touch('touchStart', [{ x: x0, y: y0, id: 1, radiusX: 4, radiusY: 4 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: x0 + i * 8, y: y0 + 20, id: 1, radiusX: 4, radiusY: 4 }]);
  await touch('touchEnd', []);
  chk(name + ' 손가락 하나 그려짐', (await inkN()) === n0 + 1);
  // 3) 그리다 두 번째 손가락 → 획 버림
  n0 = await inkN();
  await touch('touchStart', [{ x: x0, y: y0 + 60, id: 1, radiusX: 4, radiusY: 4 }]);
  await touch('touchMove', [{ x: x0 + 20, y: y0 + 60, id: 1, radiusX: 4, radiusY: 4 }]);
  await touch('touchStart', [{ x: x0 + 20, y: y0 + 60, id: 1, radiusX: 4, radiusY: 4 }, { x: x0 + 60, y: y0 + 90, id: 2, radiusX: 4, radiusY: 4 }]);
  await touch('touchMove', [{ x: x0 + 30, y: y0 + 60, id: 1, radiusX: 4, radiusY: 4 }, { x: x0 + 70, y: y0 + 90, id: 2, radiusX: 4, radiusY: 4 }]);
  await touch('touchEnd', []);
  chk(name + ' 두 번째 손가락 선 0', (await inkN()) === n0);
  // 4) 펜 그려짐, 이후 touch 무시
  n0 = await inkN();
  await pen('mousePressed', x0, y0 + 120); for (let i = 1; i <= 10; i++) await pen('mouseMoved', x0 + i * 6, y0 + 120 + i); await pen('mouseReleased', x0 + 60, y0 + 130);
  chk(name + ' 펜 그려짐', (await inkN()) === n0 + 1);
  n0 = await inkN();
  await touch('touchStart', [{ x: x0, y: y0 + 160, id: 1, radiusX: 4, radiusY: 4 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: x0 + i * 8, y: y0 + 160, id: 1, radiusX: 4, radiusY: 4 }]);
  await touch('touchEnd', []);
  chk(name + ' 펜 뒤 touch 선 0', (await inkN()) === n0);
  await p.screenshot({ path: `${out}/palm_${name}.png` });
  chk(name + ' JS 오류 0', errs.length === 0, errs.join('|'));
  await ctx.close();
}
await b.close(); console.log(`${ok}/${tot}`); process.exit(ok === tot ? 0 : 1);
