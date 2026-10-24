// T101: node scripts/t101-shots.mjs <base> <out>  (예: http://127.0.0.1:4173/ 또는 https://g4jy.github.io/kwd-board)
import { chromium } from 'playwright';
import fs from 'node:fs';
const [BASE, OUT] = [process.argv[2], process.argv[3]]; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const res = {};
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/#/demo/phone`); await p.waitForTimeout(5000);
  // 체험은 iframe 안; 첫 학생 프레임 사용
  const fr = p.frames().find((f) => f.url().includes('r=s')) || p.mainFrame();
  await fr.evaluate(() => { const bt = document.querySelector('.follow-btn'); if (bt) bt.hidden = false; });
  await p.screenshot({ path: `${OUT}/phone-${scheme}.png` });
  res[scheme] = await fr.evaluate(() => {
    const small = []; const bt = document.querySelector('.follow-btn');
    document.querySelectorAll('.toolbar *, .follow-btn, .zoom *, .bubble *').forEach((e) => {
      if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
      const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 12) small.push([e.className, fs]);
    });
    const cs = bt && getComputedStyle(bt);
    return { small, follow: cs && [cs.backgroundColor, cs.color, cs.borderTopWidth], stage: getComputedStyle(document.querySelector('.stage')).backgroundImage };
  });
  await ctx.close();
}
// 오류 상태: 서버 연결 불가
const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
const p = await ctx.newPage();
await p.route('**/ws/**', (r) => r.abort()); await p.route('**/api/**', (r) => r.abort());
await p.goto(`${BASE}/#/b/zz-error?r=s`); await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/error.png` });
console.log(JSON.stringify(res));
await b.close();
