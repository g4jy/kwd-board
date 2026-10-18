// KWD 폴더 연결 흐름: 시작 화면 오늘 수업 → 학생 누르기 → 이 학생 패널(오늘·수업안·자료·학생·지난 수업·단어) → 판에 넣기
import { chromium } from 'playwright';
import fs from 'node:fs';
import { fixtureFiles, writeOpfs } from './folder-fixture.mjs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/folder';
fs.mkdirSync(OUT, { recursive: true });
const p2 = (n) => String(n).padStart(2, '0');
const d = new Date();
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const res = {};
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.home');
res.noFolderCard = await p.locator('.home-card button').textContent();
await p.screenshot({ path: `${OUT}/0-home-nofolder.png` });
res.files = await p.evaluate(writeOpfs, fixtureFiles(today));
await p.waitForSelector('.lesson-row');
res.rows = await p.locator('.lesson-row').allInnerTexts();
res.students = await p.locator('.student-row').allInnerTexts();
await p.screenshot({ path: `${OUT}/1-home.png` });
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd && document.querySelector('.mem-btn') && !document.querySelector('.mem-btn').hidden);
res.url = p.url().split('#')[1];
res.chip = await p.locator('.chip-main').textContent();
await p.click('.mem-btn');
await p.waitForSelector('.mem-panel .mp-tab');
res.tabs = await p.locator('.mem-panel .mp-tab').allInnerTexts();
res.today = (await p.locator('.mp-body').innerText()).slice(0, 400);
await p.screenshot({ path: `${OUT}/2-today.png` });
// 묶음이 없으면 브리핑의 복습 단어로 대화 재료 → 학생 화면에 깔기 (판 위 글상자)
await p.click('.tk-put');
await p.waitForTimeout(600);
res.boardText = await p.locator('.obj-box-text').last().innerText();
// 수업안
await p.click('.mp-tab[data-tab="plan"]');
res.plan = (await p.locator('.mp-body').innerText()).slice(0, 200);
await p.screenshot({ path: `${OUT}/3-plan.png` });
// 자료 → 수업페이지.html 을 판에
res.mats = await p.locator('.mp-body .mp-main').allInnerTexts();
await p.locator('.mp-row', { hasText: '수업페이지' }).locator('.mp-ins').click();
await p.waitForFunction(() => window.__kwd.objs(window.__kwd.pages()[0].id).some((o) => o.type === 'html'), null, { timeout: 5000 });
res.htmlObj = await p.evaluate(() => window.__kwd.objs(window.__kwd.pages()[0].id).find((o) => o.type === 'html').name);
// 학생
await p.click('.mp-tab[data-tab="student"]');
res.student = (await p.locator('.mp-body').innerText()).slice(0, 200);
// 지난 수업 → 문서 열기
await p.click('.mp-tab[data-tab="lessons"]');
await p.click('.mp-link >> nth=0');
await p.waitForSelector('.mp-viewer .mp-md');
res.lessonDoc = (await p.locator('.mp-viewer').innerText()).slice(0, 120);
// 단어 (지난 수업 기록에서)
await p.waitForFunction(() => window.__kwd.memory()?.vocab?.length > 0, null, { timeout: 5000 });
await p.click('.mp-tab[data-tab="vocab"]');
res.vocab = await p.locator('.mp-body .mp-row').allInnerTexts();
res.hints = await p.evaluate(() => document.querySelectorAll('.mem-hint').length);
await p.screenshot({ path: `${OUT}/4-vocab.png` });
// 체험 학생
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.lesson-row');
await p.click('.lesson-row:has-text("Tom")');
await p.waitForFunction(() => document.querySelector('.mem-btn') && !document.querySelector('.mem-btn').hidden);
await p.click('.mem-btn');
await p.waitForSelector('.mem-panel .mp-tab');
res.trialTabs = await p.locator('.mem-panel .mp-tab').allInnerTexts();
res.trialToday = (await p.locator('.mp-body').innerText()).slice(0, 160);
await p.screenshot({ path: `${OUT}/5-trial.png` });
// 학생 기기에는 폴더 자료가 없다
const s = await (await b.newContext({ viewport: { width: 390, height: 800 } })).newPage();
const bid = res.url.match(/\/b\/([a-z0-9]+)/)[1];
await s.goto(`${BASE}/#/b/${bid}?r=s`);
await s.waitForTimeout(800);
res.studentMemBtn = await s.locator('.mem-btn').isHidden();
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
