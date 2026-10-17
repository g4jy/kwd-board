// 두 기기: 선생님이 놓은 글상자·웹 학습지·옮긴 획이 학생 폰에 같은 자리로
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = process.env.WS || 'ws://localhost:1234';
const b = await chromium.launch();
const t = await (await b.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
const room = 'sync' + Date.now();
await t.goto(`${BASE}/#/b/${room}?r=t&st=9&srv=${encodeURIComponent(WS)}`);
await t.waitForFunction(() => window.__kwd && window.__kwd.store.status === 'connected', null, { timeout: 10000 });
const pid = await t.evaluate(() => window.__kwd.pages()[0].id);
await t.evaluate((p) => window.__kwd.addBox(p, 300, 500), pid);
await t.keyboard.type('학생도 보여요');
await t.evaluate(() => window.__kwd.placeHtml('<button>누르기</button>', '작은 학습지'));
const s = await (await b.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })).newPage();
await s.goto(`${BASE}/#/b/${room}?r=s&srv=${encodeURIComponent(WS)}`);
await s.waitForTimeout(3000);
console.log('objs', await s.evaluate(() => [document.querySelectorAll('.obj').length, window.__kwd.store.status, location.hash]));
await s.waitForTimeout(500);
const res = {
  studentObjs: await s.evaluate(() => Array.from(document.querySelectorAll('.obj')).map((e) => e.className.split(' ')[1] + ':' + (e.querySelector('.box-doc')?.textContent || e.querySelector('.obj-name')?.textContent || ''))),
  studentCanType: await s.evaluate(() => document.querySelector('.box-doc')?.getAttribute('contenteditable')),
  handlesHidden: await s.evaluate(() => getComputedStyle(document.querySelector('.obj-grip')).display),
};
await t.evaluate(() => window.__kwd.store.setSetting('studentWrite', true));
await s.waitForTimeout(500);
res.studentCanTypeAfter = await s.evaluate(() => document.querySelector('.box-doc')?.getAttribute('contenteditable'));
console.log(JSON.stringify(res));
await b.close();
