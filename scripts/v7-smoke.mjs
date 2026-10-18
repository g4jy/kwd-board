// v7: 수업 묶음(lesson_packet/v1) 읽기 · 시간 배분 판에서 고치기 + 칸 타이머 · 대화 재료 → 학생 화면 · 로드맵 한눈에
//     · 도구 바꿔도 화면 그대로 · 나란히: 목록에서 고르면 학생도 같은 것 · 이모지 없는 수업 페이지 · 묶음은 Yjs 로 안 감
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v7';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const res = {};
const errs = [];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]/u;

// 1) 나란히: 선생님이 목록에서 학습지를 고르면 학생 폰도 학습지로
{
  const p = await (await b.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${BASE}/#/demo/split`);
  await p.waitForFunction(() => [...document.querySelectorAll('.dev-frame')].every((f) => f.src.includes('#/b/')), null, { timeout: 40000 });
  await p.waitForTimeout(3000);
  const t = p.frames().find((f) => f.url().includes('r=t'));
  const s = p.frames().find((f) => f.url().includes('r=s'));
  // 학생이 먼저 자기 마음대로 움직였어도
  await s.evaluate(() => window.__kwd.vp.set({ x: 500, y: -2000, s: 0.3 }));
  await s.evaluate(() => window.dispatchEvent(new Event('wheel')));
  const key = await t.locator('.rail-item').evaluateAll((els) => els.find((e) => e.title.includes('웹 학습지')).dataset.key);
  await t.evaluate((k) => document.querySelector(`.rail-item[data-key="${k}"]`).click(), key);
  await p.waitForTimeout(1500);
  res.splitStudentSeesWs = await s.evaluate(() => {
    const el = document.querySelector('.obj-html');
    const r = el.getBoundingClientRect();
    return r.left >= -2 && r.right <= innerWidth + 2 && r.top >= 0 && r.top < innerHeight / 2 && r.width > innerWidth * 0.8;
  });
  res.splitFlash = await s.locator('.look-flash').count(); // 목록 이동은 조용히 (배너 없음)
  await p.screenshot({ path: `${OUT}/1-split-follow.png` });
  await p.close();
}

const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
await p.goto(`${BASE}/#/demo`);
res.demoCardsEmoji = EMOJI.test(await p.locator('.demo-grid').innerText());
await p.click('.demo-card.main');
await p.waitForSelector('.lesson-row');
res.homeSplit = await p.locator('.lesson-row.next .lr-split').innerText({ timeout: 5000 }).catch(() => '');
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd?.store?.meta?.get('demoReady'), null, { timeout: 30000 });
await p.waitForTimeout(800);

// 2) 수업 페이지에 이모지 없음 (그림은 한 그림체 SVG)
{
  const man = JSON.parse(fs.readFileSync('public/demo/manifest.json', 'utf8'));
  const f = man.files.find((x) => x.p.endsWith('#12_수업페이지.html')).f;
  const html = fs.readFileSync('public/demo/work/' + f, 'utf8');
  res.lessonEmoji = EMOJI.test(html.replace(/✓|✗/g, ''));
  res.lessonIll = (html.match(/class="ill/g) || []).length;
}
// 3) 도구를 바꿔도 화면이 그대로
await p.locator('.rail-item').nth(3).click();
await p.waitForTimeout(800);
const view = () => p.evaluate(() => { const v = window.__kwd.vp.view; return [Math.round(v.x), Math.round(v.y), +v.s.toFixed(3)].join(','); });
const v0 = await view();
const vs = [];
for (const tool of ['select', 'text', 'select', 'text']) {
  await p.click(`.toolbar [data-tool="${tool}"]`);
  await p.waitForTimeout(300);
  vs.push(await view());
}
res.toolJump = vs.filter((v) => v !== v0).length;

// 4) 이 학생 → 오늘: 왜 지금 · 배분(묶음 5·10·30·5) · 분 고치기 · 칸 누르면 타이머 · 대화 재료 깔기
await p.click('.mem-btn');
await p.click('.mp-tab[data-tab="today"]');
res.why = await p.locator('.mp-why').innerText();
res.plan = (await p.locator('.plan-seg').allInnerTexts()).map((x) => x.replace(/\n/g, ' '));
res.noteInsertButtons = await p.locator('.mp-body button:has-text("판에 넣기"), .mp-body button:has-text("한 줄로")').count();
await p.click('.plan-edit');
await p.click('.pe-cell[data-seg="talk"] .pe-b >> nth=1'); // 대화 +1
await p.click('.pe-cell[data-seg="talk"] .pe-b >> nth=1'); // +1
await p.click('.pe-cell[data-seg="main"] .pe-b >> nth=0'); // 본 -1
res.planEdited = (await p.locator('.plan-seg').allInnerTexts()).map((x) => x.replace(/\n/g, ' '));
res.planTotal = await p.locator('.mp-sec h4').first().innerText();
await p.click('.plan-edit');
await p.click('.plan-seg[data-seg="talk"]');
await p.waitForTimeout(400);
res.timer = await p.locator('.timer').innerText();
res.kitWords = await p.locator('.mp-chip.static').count();
res.kitExamples = await p.locator('.tk-exp li').count();
await p.screenshot({ path: `${OUT}/2-today.png` });
const before = await p.evaluate(() => window.__kwd.objs(window.__kwd.pages()[0].id).length);
await p.click('.tk-put');
await p.waitForTimeout(800);
res.kitPlaced = await p.evaluate((n) => {
  const objs = window.__kwd.objs(window.__kwd.pages()[0].id).slice(n);
  return objs.map((o) => o.type + ':' + (o.name || ''));
}, before);
res.kitText = (await p.locator('.obj-box-text').last().innerText()).replace(/\n+/g, ' | ').slice(0, 160);
res.look = await p.evaluate(() => !!window.__kwd.store.getSetting('look', null));
await p.screenshot({ path: `${OUT}/3-talk-kit.png` });

// 5) 학생 정보: 로드맵 한눈에
await p.click('.mp-tab[data-tab="student"]');
res.rm = {
  goal: await p.locator('.rm-goal b').innerText(),
  pace: await p.locator('.rm-pace b').innerText(),
  steps: await p.locator('.rm-step').evaluateAll((els) => els.map((e) => e.dataset.step + ':' + [...e.classList].find((c) => ['done', 'now', 'next', 'later'].includes(c)))),
  near: await p.locator('.rm-near').innerText(),
  todo: await p.locator('.rm-todo').count(),
};
await p.screenshot({ path: `${OUT}/4-roadmap.png` });

// 6) 묶음은 판 문서(Yjs)에 없다 — 선생님이 깐 대화 카드 글만. 기록 묶음에 packet_id · 칸 사건
res.packetInDoc = await p.evaluate(() => {
  const j = JSON.stringify(window.__kwd.store.doc.toJSON());
  return ['캐나다 한국 친구들', '지난 시간 부산 이야기로', '조금 빠름', 'feedback_pick', '받침 ㅆ — 이틀'].filter((x) => j.includes(x));
});
const bundle = await p.evaluate(async () => {
  const r = await window.__kwd.bundle();
  return { manifest: JSON.parse(r.files['manifest.json']), events: (r.files['events.ndjson'] || '').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
});
res.manifestPacket = bundle.manifest.packet_id;
res.segEvents = bundle.events.filter((e) => e.kind === 'segment' || e.kind === 'segment_edit').map((e) => e.kind + ':' + (e.data?.key || e.data?.split));
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
