// v6: 무한 판 · 기기마다 같은 좌표 · '여기 보세요' · 웹 학습지 단계별 필기 · 함께 움직이는 학습지 · 필기 넣은 학습지 저장 · 과제 탭
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v6';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, acceptDownloads: true });
const t = await ctx.newPage();
const errs = [];
t.on('pageerror', (e) => errs.push('T ' + String(e)));
const res = {};
// 선생님: 체험 → 오늘 수업 → 판
await t.goto(`${BASE}/#/demo`);
await t.click('.demo-card.main');
await t.waitForSelector('.lesson-row');
await t.click('.lesson-row.next');
await t.waitForFunction(() => window.__kwd?.store?.meta?.get('demoReady'), null, { timeout: 30000 });
const bid = t.url().match(/#\/b\/([a-z0-9]+)/)[1];
const C = await t.evaluate(() => window.__kwd.pages()[0].id);
res.pages = await t.evaluate(() => window.__kwd.pages().length);
res.rail = await t.locator('.rail-item').evaluateAll((els) => els.map((e) => e.title));
await t.screenshot({ path: `${OUT}/1-canvas.png` });

// 학생 (폰 크기, 같은 브라우저의 다른 창)
const sctx = ctx; // 같은 브라우저 → 바로 같이 움직인다
const s = await sctx.newPage();
s.on('pageerror', (e) => errs.push('S ' + String(e)));
await s.setViewportSize({ width: 390, height: 844 });
await s.goto(`${BASE}/#/b/${bid}?r=s`);
await s.waitForFunction(() => window.__kwd && window.__kwd.objs(window.__kwd.pages()[0].id).length > 8, null, { timeout: 15000 });

// 1) 같은 좌표: 사진·학습지·글의 판 위 자리가 두 기기에서 같다
const geo = (pg) => pg.evaluate(() => {
  const c = window.__kwd.pages()[0].id;
  const vp = window.__kwd.vp.view;
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); const st = document.querySelector('.stage').getBoundingClientRect(); return [Math.round((b.left - st.left - vp.x) / vp.s), Math.round((b.top - st.top - vp.y) / vp.s), Math.round(b.width / vp.s), Math.round(b.height / vp.s)]; };
  return { img: r('.obj-img'), html: r('.obj-html'), note: r('.page.canvas .page-text'), h1: r('.page.canvas h1'), font: getComputedStyle(document.querySelector('.board-doc')).fontFamily.slice(0, 40) };
});
res.geoT = await geo(t);
res.geoS = await geo(s);

// 2) '여기 보세요': 선생님이 학습지를 고르고 누르면 학생 화면이 그리로
const ws = await t.evaluate((c) => window.__kwd.objs(c).find((o) => o.type === 'html'), C);
await t.evaluate((id) => document.querySelector(`.rail-item[data-key="${id}"]`).click(), ws.id);
await t.waitForTimeout(400);
await t.click('.toolbar [data-tool="select"]');
await t.click('.obj-html .obj-bar .obj-name');
await t.click('.look-btn');
await s.waitForTimeout(800);
res.studentSeesWs = await s.evaluate((o) => {
  const [cx, cy] = window.__kwd.vp.center();
  return cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h;
}, ws);
res.flash = await s.locator('.look-flash').count();
await s.screenshot({ path: `${OUT}/2-student-look.png` });

// 3) 학습지 안에서 고르기 → 학생 학습지에도 (함께 움직임)
await t.click('.toolbar [data-tool="text"]');
const tf = t.frameLocator('.obj-html iframe');
await tf.locator('#s1 .pick[data-v="food"]').click();
await t.waitForTimeout(600);
res.studentPick = await s.frameLocator('.obj-html iframe').locator('#s1 .pick[data-v="food"]').evaluate((el) => el.classList.contains('on'));

// 4) 학습지 위 필기: 1단계에 한 획
const fb = await (await t.$('.obj-html iframe')).boundingBox();
await t.click('.pen-slot[data-slot="1"]');
const line = async (x0, y0, x1, y1) => { await t.mouse.move(x0, y0); await t.mouse.down(); await t.mouse.move(x1, y1, { steps: 10 }); await t.mouse.up(); };
await line(fb.x + fb.width * 0.08, fb.y + fb.height * 0.25, fb.x + fb.width * 0.5, fb.y + fb.height * 0.27);
res.ink1 = await t.evaluate((id) => window.__kwd.store.ink(`ws:${id}:1`).length, ws.id);
// 글상자 (T 단추)
await t.click('.obj-html .ws-t');
await t.waitForTimeout(200);
await t.keyboard.type('1단계 메모');
await t.click('.toolbar [data-tool="text"]');
res.box1 = await t.evaluate((id) => window.__kwd.objs(`ws:${id}:1`).length, ws.id);
await t.screenshot({ path: `${OUT}/3-ws-step1-ink.png` });
// 5) 다음 단계 → 필기가 사라지고, 학생 학습지도 2단계
await tf.locator('#next').click();
await t.waitForTimeout(700);
res.stepT = await t.evaluate((id) => window.__kwd.objs(window.__kwd.pages()[0].id).find((o) => o.id === id).step, ws.id);
res.stepS = await s.frameLocator('.obj-html iframe').locator('#lab').textContent();
res.boxesVisibleStep2 = await t.locator('.ws-layer .obj-box').count();
await t.click('.pen-slot[data-slot="2"]');
await line(fb.x + fb.width * 0.2, fb.y + fb.height * 0.5, fb.x + fb.width * 0.6, fb.y + fb.height * 0.55);
res.ink2 = await t.evaluate((id) => window.__kwd.store.ink(`ws:${id}:2`).length, ws.id);
await t.screenshot({ path: `${OUT}/4-ws-step2.png` });
// 학생 창에도 2단계 필기층
res.studentInk2 = await s.evaluate((id) => window.__kwd.store.ink(`ws:${id}:2`).length, ws.id);
await s.screenshot({ path: `${OUT}/5-student-step2.png` });
// 6) 다시 1단계 → 1단계 필기·글상자가 돌아온다
await t.click('.toolbar [data-tool="text"]');
await tf.locator('#prev').click();
await t.waitForTimeout(600);
res.backStep = await t.evaluate((id) => window.__kwd.objs(window.__kwd.pages()[0].id).find((o) => o.id === id).step, ws.id);
res.boxesVisibleStep1 = await t.locator('.ws-layer .obj-box').count();
// 7) 필기 넣은 학습지 저장 (체험 폴더는 못 쓰니 내려받기)
const [dl] = await Promise.all([t.waitForEvent('download'), t.click('.obj-html .obj-bt[title^="필기 넣은"]')]);
const fp = `${OUT}/annotated.html`;
await dl.saveAs(fp);
const html = fs.readFileSync(fp, 'utf8');
res.annotated = { name: dl.suggestedFilename(), steps: Object.keys(JSON.parse(html.match(/var ANN=(\{.*?\}),STATES=/s)[1])), hasState: html.includes('"s1":["food"]') };
// 저장한 파일을 열면 단계마다 필기
const v = await ctx.newPage();
await v.goto('file://' + fs.realpathSync(fp));
await v.waitForTimeout(1200);
res.viewStep1Paths = await v.locator('#ink path').count();
await v.frameLocator('#f').locator('#next').click();
await v.waitForTimeout(500);
res.viewStep2Paths = await v.locator('#ink path').count();
await v.screenshot({ path: `${OUT}/6-annotated-file.png` });
await v.close();
// 8) 기록 묶음에도
res.bundle = await t.evaluate(async () => { const z = await window.__kwd.bundle(); return { ws: Object.keys(z.files).filter((k) => k.startsWith('worksheets/')), md: z.files['board.md'].match(/\(학습지 \d단계\)[^\n]*/g) }; });

// 9) 과제 탭
await t.click('.mem-btn');
await t.click('.mp-tab[data-tab="hw"]');
await t.waitForSelector('.hw-strip');
res.hwSum = await t.locator('.hw-sum').innerText();
res.hwDays = await t.locator('.hw-days').first().locator('.hw-dayb').count();
res.hwPoints = await t.locator('.mp-sec:has(h4:has-text("수업에서 짚을 것")) .hw-item').count();
await t.waitForTimeout(800);
res.hwThumbs = await t.locator('.hw-item .mp-thumb').count();
await t.screenshot({ path: `${OUT}/7-hw-tab.png` });
await t.click('.mp-sec:has(h4:has-text("수업에서 짚을 것")) > .mp-ins');
res.hwPlaced = await t.evaluate((c) => window.__kwd.objs(c).filter((o) => o.type === 'box').length, C);
// 10) 오늘 탭 시간 나누기
await t.click('.mp-tab[data-tab="today"]');
res.plan = await t.locator('.plan-seg').allInnerTexts();
await t.click('.plan-seg >> nth=1');
res.timer = await t.locator('.timer').isVisible();
await t.screenshot({ path: `${OUT}/8-today-plan.png` });
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
