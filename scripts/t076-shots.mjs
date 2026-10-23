// T076 전후 캡처: node scripts/t076-shots.mjs <출력폴더>  (preview 4173 필요, 체험 화면만 사용)
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:4173';
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${BASE}/#/`); await p.waitForTimeout(500);
await p.screenshot({ path: `${OUT}/1-home.png` });
await p.goto(`${BASE}/#/demo/split`);
await p.waitForFunction(() => [...document.querySelectorAll('.dev-frame')].every((f) => f.src.includes('#/b/')), null, { timeout: 30000 });
await p.waitForTimeout(3500);
await p.screenshot({ path: `${OUT}/2-split.png` });
for (const v of ['phone', 'tablet']) {
  await p.goto(`${BASE}/#/demo/${v}`); await p.waitForTimeout(4000);
  await p.screenshot({ path: `${OUT}/3-${v}.png` });
}
await p.goto(`${BASE}/#/demo/split`); await p.waitForTimeout(3500);
const t = p.frames().find((f) => f.url().includes('r=t'));
if (t) {
  await t.click('.toolbar button[data-tool="more"]').catch(() => {}); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/4-menu.png` });
  await p.keyboard.press('Escape');
}
console.log('errs', errs.length, errs.slice(0, 3));
await b.close();
