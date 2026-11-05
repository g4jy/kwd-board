// T160 시험: 선생님 첫 화면 = 오늘 수업 목록 → 수업 카드(전·중·후) → ⚙ 설정. 가짜 구글·가짜 허브·가짜 학생만 쓴다.
//   node scripts/t160-smoke.mjs   (BASE=http://localhost:4173 로 vite preview, WS=ws://localhost:1234 로 npm run server 가 떠 있어야 접속 표시까지 봄)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = process.env.WS || '';
const OUT = path.resolve(process.env.OUT || 'test-results/t160');
const KEY = 'testkey-0123456789abcdef';
const PORT = 8798;
fs.rmSync(OUT, { recursive: true, force: true });
const root = path.join(OUT, 'drive');
const mirror = path.join(root, 'work');
const dataDir = path.join(root, 'data');
const landing = path.join(OUT, 'landing');
fs.mkdirSync(landing, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayTok = (t) => t.replace(/@D([-+])(\d+)@/g, (_m, sg, n) => ymd(new Date(today.getTime() - (sg === '-' ? 1 : -1) * Number(n) * 86400000)));
const clock = (min) => { const d = new Date(today.getTime() + min * 60000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const man = JSON.parse(fs.readFileSync('public/demo/manifest.json', 'utf8'));
for (const { p, f } of man.files) {
  const rel = dayTok(p.replace('intake/TODAY/', `intake/${ymd(today)}/`).replace('lesson_packets/TODAY/', `lesson_packets/${ymd(today)}/`));
  const dest = path.join(mirror, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let buf = fs.readFileSync(path.join('public/demo/work', f));
  if (/\.(json|md|txt)$/.test(p)) buf = Buffer.from(dayTok(buf.toString('utf8').replace(/TODAY/g, ymd(today)).replace(/NOW\+(\d+)/g, (_m, n) => clock(Number(n)))));
  fs.writeFileSync(dest, buf);
}
// 학생 정보 정본 사본(가짜): 데이터 쪽 student_info.json
fs.writeFileSync(path.join(dataDir, 'student_info.json'), JSON.stringify({ students: { S900: { sno: 'S900', st: 'st_900', folder: 'Mina K (9000001)', name: 'Mina', level: 'L2', next_unit: '단원 12 · 과거형', avoid_topics: ['정치', '가족 이야기'], know: ['천천히 말하면 잘 알아들음'], memo: ['(2026-10-30) 받침 ㅆ 헷갈림'] } } }));
const gas = spawn('node', ['scripts/mock-gas.mjs', String(PORT), mirror, landing, KEY], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const res = {};
const errs = [];
const watch = (n, p) => {
  p.on('pageerror', (e) => errs.push(n + ': ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|ERR_CONNECTION|Failed to load resource|net::/.test(m.text()) && errs.push(n + ' console: ' + m.text()));
};
const init = (ctx, withHub) => ctx.addInitScript(([k, u, hub, ws]) => {
  try {
    localStorage.setItem('kwd.gasKey', k);
    localStorage.setItem('kwd.gasUrl', u);
    if (hub) localStorage.setItem('kwd.hw', JSON.stringify({ url: 'https://hub.test/exec', key: 'tk' }));
    if (ws) localStorage.setItem('kwd.server', ws);
  } catch (e) { /* */ }
}, [KEY, `http://localhost:${PORT}/`, withHub, WS]);
const hubRoute = (ctx) => ctx.route('https://hub.test/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, data: { students: [{ student_id: 'st_900', name: 'Mina K.', sno: 'S900', today: { date: ymd(today), state: 'done', est: 20 } }, { student_id: 'st_901', name: 'Tom', today: { date: ymd(today), state: 'open', est: 15 } }] } }) }));
const metrics = (p) => p.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  minFont: Math.min(...[...document.querySelectorAll('.home *')].filter((e) => e.offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize))),
  smallTap: [...document.querySelectorAll('.home button, .home a, .home summary')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => (e.textContent || '').trim().slice(0, 14)),
}));

const b = await chromium.launch({ channel: 'chrome' });
for (const [tag, vp] of [['pc', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
  const ctx = await b.newContext({ viewport: vp, permissions: ['clipboard-read', 'clipboard-write'] });
  await init(ctx, true);
  await hubRoute(ctx);
  const p = await ctx.newPage();
  watch('home-' + tag, p);
  await p.goto(`${BASE}/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
  await p.waitForSelector('.th-item', { timeout: 30000 });
  const r = { url: p.url(), keyInUrl: /k=/.test(p.url()) };
  r.title = await p.locator('.home h1').innerText();
  r.items = await p.locator('.th-item').count();
  r.rows = (await p.locator('.th-row').allInnerTexts()).map((x) => x.replace(/\n+/g, ' | '));
  r.firstScreenText = (await p.locator('.home').innerText()).replace(/\n+/g, ' | ').slice(0, 600);
  r.noDevBox = !/폴더 연결|고급|방 코드|체험|pending-student/.test(r.firstScreenText);
  r.mark = await p.locator('.th-item.next, .th-item.live').count();
  Object.assign(r, { m1: await metrics(p) });
  await p.screenshot({ path: `${OUT}/home-${tag}.png`, fullPage: true });
  // 카드 열기
  await p.locator('.th-row').first().click();
  await p.waitForSelector('.th-card:not([hidden]) .th-col', { timeout: 10000 });
  await p.waitForFunction(() => !document.querySelector('.th-card:not([hidden])')?.textContent.includes('확인 중…'), null, { timeout: 15000 }).catch(() => {});
  r.card = (await p.locator('.th-card:not([hidden])').innerText()).replace(/\n+/g, ' | ');
  r.cols = await p.locator('.th-card:not([hidden]) .th-col h3').allInnerTexts();
  r.m2 = await metrics(p);
  await p.screenshot({ path: `${OUT}/card-${tag}.png`, fullPage: true });
  // 학생 링크 복사
  await p.locator('.th-acts button', { hasText: '학생 링크 복사' }).first().click();
  await p.waitForTimeout(500);
  r.clip = await p.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e);
  r.clipHasKey = /k=|tk=/.test(String(r.clip));
  // 설정
  await p.locator('.th-icon').click();
  r.settings = (await p.locator('.th-settings').innerText()).replace(/\n+/g, ' | ');
  r.m3 = await metrics(p);
  await p.screenshot({ path: `${OUT}/settings-${tag}.png`, fullPage: true });
  await p.locator('.th-icon').click();
  // 학생 전체 → 학생 카드
  await p.locator('.th-all > summary').click();
  await p.waitForSelector('.th-all .rs-card, .th-all .student-row', { timeout: 15000 });
  r.rosterCards = await p.locator('.th-all .rs-card').count();
  await p.locator('.th-all .rs-card').first().click();
  await p.waitForSelector('.stu-panel .th-col', { timeout: 15000 });
  r.m4 = await metrics(p);
  await p.screenshot({ path: `${OUT}/all-${tag}.png`, fullPage: true });
  // 판 열기
  await p.locator('.th-row').first().scrollIntoViewIfNeeded();
  await p.locator('.th-acts button.primary').first().click();
  await p.waitForSelector('.board-doc', { timeout: 20000 });
  r.opened = p.url().replace(/\?.*/, '');
  res['home_' + tag] = r;
  await ctx.close();
}
// 숙제 연결이 없는 기기: 과제 칩은 없고 안내 한 줄
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  await init(ctx, false);
  const p = await ctx.newPage();
  watch('nohub', p);
  await p.goto(`${BASE}/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
  await p.waitForSelector('.th-item', { timeout: 30000 });
  res.nohub = { chips: await p.locator('.th-chip').allInnerTexts(), foot: await p.locator('.th-foot').innerText().catch(() => '') };
  await ctx.close();
}
// 연결 안 된 기기(열쇠 없음) / 드라이브 오류
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  watch('nokey', p);
  await p.goto(`${BASE}/#/`);
  await p.waitForSelector('.th-empty', { timeout: 15000 });
  res.nokey = { text: (await p.locator('.home').innerText()).replace(/\n+/g, ' | '), m: await metrics(p) };
  await p.screenshot({ path: `${OUT}/nokey-phone.png`, fullPage: true });
  await ctx.close();
  const c2 = await b.newContext({ viewport: { width: 390, height: 780 } });
  await init(c2, false);
  await fetch(`http://localhost:${PORT}/__fail?on=1`);
  const q = await c2.newPage();
  watch('fail', q);
  await q.goto(`${BASE}/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
  await q.waitForSelector('.th-empty', { timeout: 40000 });
  res.fail = { text: (await q.locator('.home').innerText()).replace(/\n+/g, ' | '), m: await metrics(q) };
  await q.screenshot({ path: `${OUT}/error-phone.png`, fullPage: true });
  await fetch(`http://localhost:${PORT}/__fail?on=0`);
  await c2.close();
}
await b.close();
res.errs = errs;
gas.kill();
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
