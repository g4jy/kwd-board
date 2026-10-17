// 체험 흐름: 고르기 → 선생님(시작 화면 → 오늘 수업 → 판, 자료가 페이지마다) → 이 학생 패널 탭 → 학생 폰/태블릿/나란히
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/demo';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
const res = {};
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.home');
await p.click('.home-demo');
await p.waitForSelector('.demo-card');
res.cards = await p.locator('.demo-card .dc-title').allInnerTexts();
await p.screenshot({ path: `${OUT}/0-pick.png` });
await p.click('.demo-card.main');
await p.waitForSelector('.lesson-row');
res.home = await p.locator('.lesson-row').allInnerTexts();
res.badge = await p.locator('.demo-badge').innerText();
await p.screenshot({ path: `${OUT}/1-home.png` });
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd?.store?.meta?.get('demoSeeded') && window.__kwd.pages().length > 8, null, { timeout: 30000 });
await p.waitForTimeout(1500);
res.pages = await p.evaluate(() => window.__kwd.pages().map((x) => x.kind));
res.objs = await p.evaluate(() => window.__kwd.pages().map((pg) => window.__kwd.objs(pg.id).map((o) => o.type).join(',')).filter(Boolean));
res.firstText = await p.evaluate(() => window.__kwd.editor().getText().slice(0, 200));
await p.screenshot({ path: `${OUT}/2-board.png` });
// 페이지 넘기며 찍기
const rail = await p.locator('.rail-item').count();
res.rail = rail;
for (const i of [1, 7, 8, 9, 11, 12, 13]) {
  if (i >= rail) continue;
  await p.locator('.rail-item').nth(i).click();
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/3-page${i + 1}.png` });
}
// 패널
await p.click('.mem-btn');
await p.waitForSelector('.mem-panel .mp-tab');
res.tabs = await p.locator('.mem-panel .mp-tab').allInnerTexts();
for (const t of ['today', 'plan', 'hw', 'student', 'lessons', 'vocab']) {
  const tab = p.locator(`.mp-tab[data-tab="${t}"]`);
  if (!(await tab.count())) continue;
  await tab.click();
  await p.waitForTimeout(400);
  res['tab_' + t] = (await p.locator('.mp-body').innerText()).slice(0, 260).replace(/\n+/g, ' | ');
  await p.screenshot({ path: `${OUT}/4-tab-${t}.png` });
}
// 단어: 펼쳐서 관련 말
await p.locator('.mp-dbrow .mp-open').first().click();
res.rel = (await p.locator('.mp-rel').first().innerText()).replace(/\n+/g, ' | ');
await p.click('.mp-segb[data-kind="g"]');
res.grammarRows = await p.locator('.mp-dbrow').count();
await p.screenshot({ path: `${OUT}/5-vocab-grammar.png` });
// 요약
await p.click('.mp-close');
await p.click('.toolbar [data-tool="more"]');
await p.click('.menu button:has-text("수업 요약")');
await p.waitForSelector('.summary');
res.summary = (await p.locator('.summary').innerText()).replace(/\n+/g, ' | ');
await p.screenshot({ path: `${OUT}/6-summary.png` });
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
