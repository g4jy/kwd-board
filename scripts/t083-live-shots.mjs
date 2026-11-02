// T083 실제 주소 확인: node scripts/t083-live-shots.mjs <출력폴더> <교실코드> <학생번호>  (선생님 #/t/ + 학생 #/c/ 두 창)
import { chromium } from 'playwright';
import fs from 'node:fs';
const [OUT, code, st] = process.argv.slice(2); fs.mkdirSync(OUT, { recursive: true });
const BASE = 'https://g4jy.github.io/kwd-board/';
const b = await chromium.launch({ channel: 'chrome' });
const errs = [];
const open = async (url, vp, mobile, shot) => {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(url); await p.waitForSelector('.obj iframe', { timeout: 30000 }); await p.waitForTimeout(3500);
  await p.screenshot({ path: `${OUT}/${shot}.png` });
  const info = await p.evaluate(() => ({ pages: window.__kwd?.pages().length, rail: document.querySelectorAll('.rail > *').length, iframes: document.querySelectorAll('.obj iframe').length, overflow: document.documentElement.scrollWidth > innerWidth, role: document.body.className }));
  return info;
};
console.log('teacher', JSON.stringify(await open(`${BASE}#/t/${code}${st ? '?st=' + st : ''}`, { width: 1366, height: 820 }, false, 'teacher')));
console.log('student', JSON.stringify(await open(`${BASE}#/c/${code}`, { width: 1366, height: 820 }, false, 'student')));
console.log('phone', JSON.stringify(await open(`${BASE}#/c/${code}`, { width: 390, height: 780 }, true, 'phone')));
console.log('errs', errs.length, errs.slice(0, 3));
await b.close();
