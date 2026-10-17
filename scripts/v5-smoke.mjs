// v5: 지우개 '닿은 부분만' · 문서(.md)·소리 가져오기 · 폴더 고르기 창이 막힌 브라우저 안내 · KWD 숙제(가짜 서버) · 수업 요약
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v5';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const res = {};
const errs = [];

// 1) 고르기 창이 바로 취소되는 브라우저 (Claude 앱 안 브라우저처럼)
{
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${BASE}/#/`);
  await p.click('.home-card button.primary');
  await p.waitForSelector('.home-warn:not([hidden])');
  res.blocked = await p.locator('.home-warn').innerText();
  await p.screenshot({ path: `${OUT}/1-blocked.png` });
  await ctx.close();
}

const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${BASE}/#/b/v5${Date.now()}?r=t&st=1000001`);
await p.waitForFunction(() => window.__kwd && window.__kwd.pages().length);
const page0 = await p.evaluate(() => window.__kwd.pages()[0].id);
const pb = await (await p.$('.page')).boundingBox();
const line = async (x0, y0, x1, y1) => {
  await p.mouse.move(x0, y0);
  await p.mouse.down();
  await p.mouse.move(x1, y1, { steps: 14 });
  await p.mouse.up();
};
// 2) 지우개: 닿은 부분만
await p.click('.pen-slot[data-slot="0"]');
await line(pb.x + 100, pb.y + 400, pb.x + 600, pb.y + 400);
await line(pb.x + 100, pb.y + 480, pb.x + 600, pb.y + 480);
res.strokes0 = await p.evaluate((id) => window.__kwd.store.ink(id).length, page0);
await p.click('.toolbar [data-tool="eraser"]');
await p.click('.toolbar [data-tool="eraser"]');
await p.click('.pen-pop [data-mode="part"]');
res.eraserPop = (await p.locator('.pen-pop').innerText()).replace(/\n+/g, ' | ');
await p.screenshot({ path: `${OUT}/2-eraser-pop.png` });
await p.keyboard.press('Escape');
await line(pb.x + 350, pb.y + 380, pb.x + 350, pb.y + 420); // 위 획 가운데만 문지르기
res.strokesPart = await p.evaluate((id) => window.__kwd.store.ink(id).toArray().map((s) => Math.round(s.pts[0]) + '→' + Math.round(s.pts[s.pts.length - 3])), page0);
await p.screenshot({ path: `${OUT}/3-erased-part.png` });
// 획 전체로 바꾸면 아래 획이 통째로
await p.click('.toolbar [data-tool="eraser"]');
await p.click('.pen-pop [data-mode="stroke"]');
await p.keyboard.press('Escape');
await line(pb.x + 300, pb.y + 470, pb.x + 300, pb.y + 490);
res.strokesAfterWhole = await p.evaluate((id) => window.__kwd.store.ink(id).length, page0);
await p.keyboard.press('Control+z');
res.afterUndo = await p.evaluate((id) => window.__kwd.store.ink(id).length, page0);

// 3) 문서(.md) 가져오기 → 새 글 페이지
const mdPath = `${OUT}/notes.md`;
fs.writeFileSync(mdPath, '# 오늘 읽을 글\n\n- 송편을 만들었어요\n- **보름달**을 봤어요\n\n| 말 | 뜻 |\n|---|---|\n| 달 | moon |\n');
const pick = async (label, file) => {
  const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.click('.toolbar [data-tool="import"]').then(() => p.click(`.menu button:has-text("${label}")`))]);
  await ch.setFiles(file);
};
await pick('문서', mdPath);
// 무한 판: 문서는 고칠 수 있는 큰 글상자로
await p.waitForFunction(() => window.__kwd.objs(window.__kwd.pages()[0].id).some((o) => o.type === 'box' && o.name === 'notes'));
res.mdPage = await p.evaluate(() => { const o = window.__kwd.objs(window.__kwd.pages()[0].id).find((x) => x.name === 'notes'); return document.querySelector(`[data-obj="${o.id}"] .ProseMirror`).innerHTML.slice(0, 200); });
// 4) 소리 가져오기 → 재생기
const aud = 'public/demo/work/' + JSON.parse(fs.readFileSync('public/demo/manifest.json', 'utf8')).files.find((f) => f.p.endsWith('듣기.ogg')).f;
const audCopy = `${OUT}/listen.ogg`; // (한글 파일 이름은 Playwright setFiles 가 조용히 실패해서 영어 이름으로)
fs.copyFileSync(aud, audCopy);
await pick('소리', audCopy);
await p.waitForTimeout(2500);
res.mediaObjs = await p.evaluate(() => window.__kwd.pages().map((pg) => window.__kwd.objs(pg.id).map((o) => o.type)));
res.audioDur = await p.evaluate(async () => {
  const a = document.querySelector('.obj-audio audio');
  if (!a) return -1;
  if (!(a.duration > 0)) await new Promise((r) => { a.onloadedmetadata = r; setTimeout(r, 3000); });
  return Math.round(a.duration);
});
await p.screenshot({ path: `${OUT}/4-md-audio.png` });
// 5) 수업 요약
await p.click('.toolbar [data-tool="more"]');
await p.click('.menu button:has-text("수업 요약")');
await p.waitForSelector('.summary');
res.summary = (await p.locator('.summary').innerText()).replace(/\n+/g, ' | ');
await p.screenshot({ path: `${OUT}/5-summary.png` });
await p.keyboard.press('Escape');

// 6) KWD 숙제 (가짜 서버) → 체험 학생 패널 과제 탭
const png1 = fs.readFileSync('public/demo/work/' + JSON.parse(fs.readFileSync('public/demo/manifest.json', 'utf8')).files.find((f) => f.p.includes('숙제_손글씨')).f).toString('base64');
const calls = [];
await ctx.route('https://hw.test/**', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  calls.push(body.action + (body.tkey === 'secret-k' ? ':key' : ':nokey'));
  const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, data }) });
  if (body.action === 'teacher.board') return ok({ students: [{ student_id: 'stu9', name: 'Mina K.', preply_id: '9000001' }] });
  // 숙제 앱에 지금 있는 기능만으로: teacher.student(날마다 기록) + teacher.day(그날 과제·답·피드백)
  if (body.action === 'teacher.student') return ok({ analytics: { days: [{ date: '2026-10-16', status: 'on_time', dayset_id: 'd16' }, { date: '2026-10-15', status: 'none' }], progress: { since_lesson: { lesson_at: '2026-10-12T10:00:00Z' } } } });
  if (body.action === 'teacher.day') return ok({ day: { tasks: [{ title_ko: '추석 이야기 3문장', type: 'write', steps: [{ label_ko: '쓰기', kind: 'write', sub: { answer: { text: '추석에 송편을 만들었어요.' }, grade_status: 'needs_teacher_review' } }, { label_ko: '손글씨 사진', kind: 'hand', sub: { media_file_id: 'F1', grade_status: 'teacher_ok', score: 1, feedback: [{ text: '글씨가 예뻐요' }] } }] }] } });
  if (body.action === 'media.get') return ok({ mime: 'image/jpeg', b64: png1 });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unknown' }) });
});
await p.goto("about:blank");
await p.goto(`${BASE}/#/demo`);
await p.evaluate(() => localStorage.setItem('kwd.hw', JSON.stringify({ url: 'https://hw.test/exec', key: 'secret-k' })));
await p.click('.demo-card.main');
await p.waitForSelector('.lesson-row');
await p.click('.lesson-row.next');
await p.waitForFunction(() => window.__kwd?.store?.meta?.get('demoReady'), null, { timeout: 30000 });
await p.click('.mem-btn');
await p.click('.mp-tab[data-tab="hw"]');
await p.click('.hw-app .mp-ins');
await p.waitForSelector('.hw-sum:has-text("10/12")', { timeout: 8000 });
res.hwSum = await p.locator('.hw-sum').innerText();
res.hwGroups = (await p.locator('.hw-dayb').allInnerTexts()).map((t) => t.replace(/\n+/g, ' | ').slice(0, 200));
const objsBefore = await p.evaluate(() => window.__kwd.objs(window.__kwd.pages()[0].id).length);
await p.locator('.hw-days .hw-item', { hasText: '추석에 송편을' }).first().locator('> .mp-ins').click();
await p.waitForSelector('.hw-days .hw-item .mp-thumb');
await p.locator('.hw-days .hw-item', { hasText: '손글씨' }).first().locator('.hw-m .mp-ins').click();
await p.waitForTimeout(800);
res.hwPlaced = await p.evaluate((n) => window.__kwd.objs(window.__kwd.pages()[0].id).slice(n).map((o) => o.type), objsBefore);
res.hwCalls = calls;
await p.screenshot({ path: `${OUT}/6-homework.png` });
// 키는 판 문서·기록 묶음에 없다
res.keyInDoc = await p.evaluate(async () => JSON.stringify(await window.__kwd.bundle()).includes('secret-k'));
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
