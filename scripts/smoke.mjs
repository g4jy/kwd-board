// 눈으로 보는 확인: 주요 상태를 스크린샷으로 남긴다 → /tmp/shots/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('/tmp/shots', { recursive: true });
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = 'ws://localhost:1234';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 820 } });
const t = await ctx.newPage();
const errs = [];
t.on('pageerror', (e) => errs.push('T ' + e.message));
t.on('console', (m) => m.type() === 'error' && errs.push('T console ' + m.text().slice(0, 200)));
const id = 'smk' + Date.now().toString(36);
await t.goto(`${BASE}/#/b/${id}?r=t&st=1000001&srv=${encodeURIComponent(WS)}&tk=testtoken`);
await t.waitForSelector('.board-doc');
await t.waitForTimeout(800);
await t.screenshot({ path: '/tmp/shots/01-empty.png' });
await t.keyboard.type('# 마시다 / 마셔요 (drink)');
await t.keyboard.press('Enter');
await t.keyboard.type('1. I drink water. < 저는 물을 마셔요.');
await t.keyboard.press('Enter');
await t.keyboard.type('I drink coffee. < 저는 커피를 마셔요.');
await t.keyboard.press('Enter');
await t.keyboard.press('Enter');
await t.keyboard.type('호박 : pumpkin');
await t.keyboard.press('Enter');
await t.keyboard.type('학부모님들은 ___고 말했어요');
await t.waitForTimeout(300);
// 펜 2(빨강)로 '물을' 아래 밑줄
await t.click('.pen-slot[data-slot="1"]');
const word = await t.evaluate(() => {
  const r = document.createRange();
  const p = [...document.querySelectorAll('.board-doc li p')][0];
  const tn = [...p.childNodes].find((n) => n.nodeType === 3);
  const i = tn.data.indexOf('물을');
  r.setStart(tn, i); r.setEnd(tn, i + 2);
  const b = r.getBoundingClientRect();
  return { x: b.left, y: b.bottom, w: b.width };
});
await t.mouse.move(word.x - 2, word.y + 3);
await t.mouse.down();
for (let i = 1; i <= 10; i++) await t.mouse.move(word.x - 2 + (word.w + 4) * i / 10, word.y + 3 + Math.sin(i) * 0.6);
await t.mouse.up();
await t.waitForTimeout(200);
await t.click('.pen-slot[data-slot="1"]');
await t.waitForTimeout(200);
await t.screenshot({ path: '/tmp/shots/02-pen-popover.png' });
await t.keyboard.press('Escape');
await t.click('.toolbar [data-tool="text"]');
// PDF 가져오기
const pdf = fs.readFileSync('tests/fixtures/slides.pdf').toString('base64');
await t.evaluate(async (b64) => await window.__kwd.importPdfBytes(b64, '추석 슬라이드'), pdf);
await t.waitForTimeout(600);
await t.screenshot({ path: '/tmp/shots/03-after-pdf.png' });
const evs = await t.evaluate(() => window.__kwd.store.events.toArray().filter((e) => e.kind === 'ink'));
console.log('ink events', JSON.stringify(evs));
// 메모리
await t.evaluate(() => window.__kwd.setMemory({ student: '1000001', vocab: [{ kr: '마셔요', en: 'drink', first: '6/2', count: 6, status: 'known' }, { kr: '송편', en: 'rice cake', status: 'review' }], grammar: [], errors: [{ type: '조사', pattern: '에게/께', wrong: '원장님에게', right: '원장님께', count: 2 }], homework: [], lessons: [], next: { review: ['송편'] } }));
await t.waitForTimeout(300);
await t.click('.mem-btn');
await t.waitForTimeout(300);
await t.screenshot({ path: '/tmp/shots/04-memory.png' });
// 학생 폰
const ctx2 = await b.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const s = await ctx2.newPage();
s.on('pageerror', (e) => errs.push('S ' + e.message));
await s.goto(`${BASE}/#/b/${id}?r=s&srv=${encodeURIComponent(WS)}`);
await s.waitForSelector('.board-doc');
await s.waitForTimeout(1500);
await s.screenshot({ path: '/tmp/shots/05-student.png' });
// 한 장씩
await t.evaluate(() => window.__kwd.store.setSetting('viewMode', 'single'));
await t.waitForTimeout(500);
await t.screenshot({ path: '/tmp/shots/06-single.png' });
await s.waitForTimeout(800);
await s.screenshot({ path: '/tmp/shots/07-student-single.png' });
console.log('errors', JSON.stringify(errs, null, 1));
await b.close();
