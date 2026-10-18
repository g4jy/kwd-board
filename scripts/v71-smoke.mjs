// v7.1: 노트 접힘(수업안 노트 없음) · 학생 정보 탭(학생 카드·로드맵·지금 상태·자주 틀린 것·배운 문형·원본 문서) · 단어 탭 단계 거르기
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v71';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
const res = {};
await p.goto(`${BASE}/#/demo`);
await p.click('.demo-card.main');
await p.waitForSelector('.lesson-row');
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd?.store?.meta?.get('demoReady'), null, { timeout: 30000 });
await p.waitForTimeout(1200);
// 1) 노트: 비어 있고 접혀 있다, 목록에도 없다
res.noteText = await p.evaluate(() => window.__kwd.editor().getText().trim());
res.noteFolded = await p.locator('.page.canvas > .page-text.note-empty').count();
res.noteH = await p.evaluate(() => Math.round(document.querySelector('.page.canvas > .page-text').getBoundingClientRect().height / window.__kwd.vp.view.s));
res.railNote = await p.locator('.rail-item[data-key="note"]').count();
await p.click('.toolbar [data-tool="more"]').catch(() => {});
await p.keyboard.press('Escape');
// 전체 보기
await p.evaluate(() => window.__kwd.gotoItem && document.querySelector('.zoom-fit, .zoom-pct')?.click());
await p.waitForTimeout(500);
await p.screenshot({ path: `${OUT}/1-board.png` });
// 누르면 펼쳐져서 쓸 수 있다
await p.click('.toolbar [data-tool="text"]');
await p.locator('.page.canvas > .page-text').click();
await p.keyboard.type('메모 한 줄');
res.noteTyped = await p.evaluate(() => window.__kwd.editor().getText().trim());
res.noteOpen = await p.locator('.page.canvas > .page-text.note-empty').count();
await p.keyboard.press('Control+z');
// 2) 학생 정보 탭
await p.click('.mem-btn');
await p.click('.mp-tab[data-tab="student"]');
res.st = {
  facts: await p.locator('.st-facts span').allInnerTexts(),
  roadmapSteps: await p.locator('.rm-step').count(),
  now: await p.locator('.st-col b').allInnerTexts(),
  errRows: await p.locator('.st-err').count(),
  errMore: await p.locator('.st-sec .st-more').first().innerText().catch(() => ''),
  patCounts: await p.locator('.st-pc').allInnerTexts(),
  patRows: await p.locator('.st-pat').count(),
  words: await p.locator('.st-words').innerText().catch(() => ''),
  docs: await p.locator('.st-docs .linkish').allInnerTexts(),
  oldMdOpen: await p.locator('.mp-body .mp-det').count(),
};
await p.screenshot({ path: `${OUT}/2-student.png` });
await p.locator('.mp-body').evaluate((el) => (el.scrollTop = 900));
await p.screenshot({ path: `${OUT}/3-student-2.png` });
await p.click('.st-docs .linkish >> nth=0');
res.docView = (await p.locator('.mp-body').innerText()).slice(0, 60).replace(/\n+/g, ' | ');
await p.click('.mp-back');
res.backOk = await p.locator('.st-card').count();
// 3) 단어 탭: 단계 거르기
await p.click('.mp-tab[data-tab="vocab"]');
const n = async () => Number((await p.locator('.mp-count').innerText()).replace(/\D/g, ''));
res.v = { all: await n(), chips: await p.locator('.vf-row:not(.sub) .vf-chip').allInnerTexts() };
await p.click('.vf-row:not(.sub) .vf-chip:has-text("새싹")');
res.v.saessak = await n();
res.v.sub = await p.locator('.vf-row.sub .vf-chip').allInnerTexts();
await p.click('.vf-row.sub .vf-chip >> nth=1');
res.v.saessak2 = await n();
res.v.firstRow = await p.locator('.mp-dbrow').first().innerText();
await p.screenshot({ path: `${OUT}/4-vocab-stage.png` });
await p.click('.vf-row:not(.sub) .vf-chip:has-text("전체")');
await p.selectOption('.vf .mp-sort', 'lesson');
res.v.lesson = await n();
await p.selectOption('.vf .mp-sort', 'cards');
res.v.cards = await n();
await p.selectOption('.mp-tools .mp-sort', 'stage');
res.v.stageFirst = (await p.locator('.mp-dbrow .mp-rsub').first().innerText());
// 카드 상태 거르기: 자꾸 잊음 → 새싹 안에서만
await p.click('.vf-row.srs .vf-chip.lapsing');
res.v.lapsing = await n();
res.v.lapsingRows = await p.locator('.mp-dbrow .mp-rsub').evaluateAll((els) => els.every((e) => e.innerText.includes('자꾸 잊')));
await p.click('.vf-row:not(.sub) .vf-chip:has-text("새싹")');
res.v.lapsingSaessak = await n();
res.v.chipsSrs = await p.locator('.vf-row.srs .vf-chip').allInnerTexts();
await p.screenshot({ path: `${OUT}/5-vocab-cards.png` });
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
