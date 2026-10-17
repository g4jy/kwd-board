// 체험 기기 화면: 나란히(선생님+학생 폰) · 학생 폰 · 태블릿. 선생님이 쓰면 학생 창에 뜨는지, 유튜브 크게 → 학생에게도 팝업,
// 학생 권한 토글(메뉴가 안 닫히는지), 지우개 '닿은 부분만', 수업 요약
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/demo';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const res = {};
await p.goto(`${BASE}/#/demo/split`);
await p.waitForSelector('.dev-frame');
const frames = () => p.frames().filter((f) => f.url().includes('#/b/'));
const T = async () => frames().find((f) => f.url().includes('r=t'));
const S = async () => frames().find((f) => f.url().includes('r=s'));
await p.waitForFunction(() => [...document.querySelectorAll('.dev-frame')].every((f) => f.src.includes('#/b/')), null, { timeout: 30000 });
await p.waitForTimeout(2500);
const t = await T();
const s = await S();
res.tPages = await t.evaluate(() => window.__kwd.pages().length);
res.sPages = await s.evaluate(() => window.__kwd?.pages().length);
await p.screenshot({ path: `${OUT}/6-split.png` });
// 선생님이 쓰면 학생 창에
await t.evaluate(() => {
  const ed = window.__kwd.editor();
  ed.chain().focus('end').insertContent('<p>학생 창에 보여요?</p>').run();
});
await p.waitForTimeout(800);
res.sSees = await s.evaluate(() => window.__kwd.editor().getText().includes('학생 창에 보여요'));
// 유튜브 크게 → 학생에게도
const ytPage = await t.evaluate(() => window.__kwd.pages().find((pg) => window.__kwd.objs(pg.id).some((o) => o.type === 'youtube')).id);
await t.evaluate((id) => document.querySelector(`.rail-item[data-page="${id}"]`).click(), ytPage);
await p.waitForTimeout(800);
await t.locator('.obj-youtube .obj-big, .obj-youtube button:has-text("크게")').first().click();
await p.waitForTimeout(800);
res.tPopup = await t.locator('.popup, .kwd-popup, .pop-over').count();
res.sPopup = await s.locator('.popup, .kwd-popup, .pop-over').count();
await p.screenshot({ path: `${OUT}/7-split-popup.png` });
// 선생님이 닫으면 학생도
await t.locator('.popup-x').first().click().catch((e) => (res.closeErr = String(e).slice(0, 120)));
await p.waitForTimeout(600);
res.sPopupAfter = await s.locator('.popup, .kwd-popup, .pop-over').count();
// 학생 권한 토글 — 메뉴가 열린 채로
await p.screenshot({ path: `${OUT}/7b-after-close.png` });
await t.locator('.toolbar [data-tool="more"]').click();
await p.waitForTimeout(300);
res.menuItems = (await t.locator('.menu').first().innerText()).slice(0, 300).replace(/\n+/g, ' | ');
const toggles = t.locator('.menu [role="switch"], .menu .mi.toggle');
res.toggleCount = await toggles.count();
if (res.toggleCount) {
  const before = await toggles.first().getAttribute('aria-checked');
  await toggles.first().click();
  await p.waitForTimeout(200);
  res.menuStillOpen = await t.locator('.menu').count();
  res.toggleFlip = [before, await toggles.first().getAttribute('aria-checked')];
  await toggles.first().click();
}
await p.screenshot({ path: `${OUT}/8-menu.png` });
await t.locator('body').press('Escape');
// 학생 폰 / 태블릿 화면
for (const v of ['phone', 'tablet', 'pen']) {
  await p.goto(`${BASE}/#/demo/${v}`);
  await p.waitForFunction(() => [...document.querySelectorAll('.dev-frame')].every((f) => f.src.includes('#/b/')), null, { timeout: 30000 });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/9-${v}.png` });
}
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
