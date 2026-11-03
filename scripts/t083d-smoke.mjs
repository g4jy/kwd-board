// T083d 시험: 선생님 열쇠 링크 → 폴더 고르기 없이 드라이브에서 학생 매트릭스 · 이름 누르면 학생 교실 ·
// 녹화 → 조각이 드라이브 작업중으로 (인터넷 끊김 흉내 포함) · 소리 막대 · 무음 경고 · _rec.json 무음 비율
// 가짜 구글(mock-gas.mjs)을 쓴다. 실제 학생 자료·진짜 구글은 건드리지 않는다.
//   MODE=home|rec|silent|all  BASE=http://localhost:4173  WS=ws://localhost:1234  REC_S=120
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = process.env.WS || 'ws://localhost:1234';
const MODE = process.env.MODE || 'all';
const REC_S = Number(process.env.REC_S || 120);
const OUT = path.resolve(process.env.OUT || 'test-results/t083d');
const KEY = 'testkey-0123456789abcdef';
const PORT = 8799;
fs.rmSync(OUT, { recursive: true, force: true });
const mirror = path.join(OUT, 'mirror');
const landing = path.join(OUT, 'landing');
fs.mkdirSync(landing, { recursive: true });
// 거울 = 체험 폴더(가짜 학생)
const today = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayTok = (t) => t.replace(/@D([-+])(\d+)@/g, (_m, sg, n) => ymd(new Date(today.getTime() - (sg === '-' ? 1 : -1) * Number(n) * 86400000)));
const man = JSON.parse(fs.readFileSync('public/demo/manifest.json', 'utf8'));
for (const { p, f } of man.files) {
  const rel = dayTok(p.replace('intake/TODAY/', `intake/${ymd(today)}/`).replace('lesson_packets/TODAY/', `lesson_packets/${ymd(today)}/`));
  const dest = path.join(mirror, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let buf = fs.readFileSync(path.join('public/demo/work', f));
  if (/\.(json|md|txt)$/.test(p)) buf = Buffer.from(dayTok(buf.toString('utf8').replace(/TODAY/g, ymd(today))));
  fs.writeFileSync(dest, buf);
}
const gas = spawn('node', ['scripts/mock-gas.mjs', String(PORT), mirror, landing, KEY], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const mock = (q) => fetch(`http://localhost:${PORT}/${q}`).then((r) => r.json());
// 무음 파일 (가짜 마이크가 이걸 읽는다)
const silent = path.join(OUT, 'silence.wav');
{
  const sr = 48000, n = sr * 5, ch = 2;
  const b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  fs.writeFileSync(silent, b);
}
const res = {};
const errs = [];
const watch = (n, p) => {
  p.on('pageerror', (e) => errs.push(n + ': ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|ERR_CONNECTION|Failed to load resource|net::/.test(m.text()) && errs.push(n + ' console: ' + m.text()));
};
const keyed = (ctx) => ctx.addInitScript(([k, u]) => { try { localStorage.setItem('kwd.gasKey', k); localStorage.setItem('kwd.gasUrl', u); } catch (e) { /* */ } }, [KEY, `http://localhost:${PORT}/`]);

// ---------- 1) 선생님 첫 화면 ----------
if (MODE === 'home' || MODE === 'all') {
  const b = await chromium.launch({ channel: 'chrome' });
  for (const [tag, vp] of [['pc', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    watch('home-' + tag, p);
    await p.goto(`${BASE}/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
    await p.waitForSelector('.roster-grid', { timeout: 30000 });
    const r = { url: p.url(), keyInUrl: /k=/.test(p.url()), text: await p.locator('.home').innerText(), cards: await p.locator('.rs-card .rs-name').allInnerTexts(), cols: await p.locator('.rg-col span').allInnerTexts(), rows: await p.locator('.rg-row span').allInnerTexts() };
    r.folderBtn = /폴더 연결하기|KWD 폴더 열기/.test(r.text);
    r.overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    r.minFont = await p.evaluate(() => Math.min(...[...document.querySelectorAll('.home *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(getComputedStyle(e).fontSize))));
    await p.screenshot({ path: `${OUT}/home-${tag}.png`, fullPage: true });
    await p.locator('.rs-card').first().click();
    await p.waitForSelector('.stu-panel h2', { timeout: 20000 });
    await p.waitForFunction(() => ![...document.querySelectorAll('.stu-panel .empty')].some((e) => e.textContent.includes('불러오는')), null, { timeout: 30000 });
    r.panel = (await p.locator('.stu-panel').innerText()).replace(/\n+/g, ' | ');
    r.openBtn = await p.locator('.stu-panel .primary').innerText();
    r.overflowPanel = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await p.screenshot({ path: `${OUT}/panel-${tag}.png` });
    res['home_' + tag] = r;
    await ctx.close();
  }
  // 열쇠가 없는 기기: 이름은 하나도 안 보이고 안내만
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  watch('nokey', p);
  await p.goto(`${BASE}/#/`);
  await p.waitForSelector('.home-card');
  res.nokey = { text: (await p.locator('.home').innerText()).replace(/\n+/g, ' | '), cards: await p.locator('.rs-card').count() };
  await b.close();
}

// ---------- 2) 녹화 → 드라이브 ----------
async function lesson({ name, args, long, silentMode, code }) {
  const b = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required', ...args] });
  const ctxT = await b.newContext({ viewport: { width: 1366, height: 820 }, permissions: ['camera', 'microphone'] });
  const ctxS = await b.newContext({ viewport: { width: 390, height: 780 }, permissions: ['camera', 'microphone'], isMobile: true, hasTouch: true });
  await keyed(ctxT);
  const t = await ctxT.newPage();
  const s = await ctxS.newPage();
  watch(name + '-T', t);
  watch(name + '-S', s);
  const known = new Set(fs.readdirSync(landing));
  const id = 'z' + Date.now().toString(36);
  await t.goto(code ? `${BASE}/#/t/${code}?st=9999999&srv=${encodeURIComponent(WS)}&tk=testtoken` : `${BASE}/#/b/${id}?r=t&srv=${encodeURIComponent(WS)}&tk=testtoken`);
  await t.waitForSelector('.board-doc');
  const r = {};
  // 마이크를 켜기 전에 '수업 시작' → 마이크를 저절로 켜야 한다
  r.micBefore = await t.evaluate(() => !!document.querySelector('.cam-local')?.srcObject);
  await t.click('.lesson-btn');
  await t.waitForFunction(() => document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 20000 });
  r.micAfter = await t.evaluate(() => document.querySelector('.cam-local')?.srcObject?.getAudioTracks().length || 0);
  // 학생 입장
  await s.goto(code ? `${BASE}/#/c/${code}?srv=${encodeURIComponent(WS)}` : `${BASE}/#/b/${id}?r=s&srv=${encodeURIComponent(WS)}`);
  await s.waitForSelector('.join .join-go', { timeout: 15000 });
  await s.waitForFunction(() => document.querySelector('.join-preview')?.srcObject, null, { timeout: 10000 });
  await s.click('.join .join-go');
  await t.waitForTimeout(3000);
  r.meterShown = await t.locator('.rec-meter').isVisible();
  r.meter = await t.evaluate(() => [...document.querySelectorAll('.rec-meter .rm-l')].map((e) => ({ k: e.dataset.k, w: e.firstElementChild.style.width, warn: e.dataset.warn })));
  if (silentMode) {
    await t.waitForSelector('.rec-warn', { timeout: 30000 });
    r.warn = await t.locator('.rec-warn').innerText();
    await t.screenshot({ path: `${OUT}/${name}-warn.png` });
  }
  const t0 = Date.now();
  let cut = false;
  while ((Date.now() - t0) / 1000 < (long ? REC_S : 14)) {
    await t.waitForTimeout(1000);
    const el = (Date.now() - t0) / 1000;
    if (long && !cut && el > 35) { await mock('__fail?on=1'); cut = true; r.cutAt = el; }
    if (long && cut && !r.backAt && el > 70) { await mock('__fail?on=0'); r.backAt = el; }
  }
  if (long) await mock('__fail?on=0');
  r.meterMid = await t.evaluate(() => [...document.querySelectorAll('.rec-meter .rm-l')].map((e) => ({ k: e.dataset.k, w: e.firstElementChild.style.width, warn: e.dataset.warn })));
  await t.screenshot({ path: `${OUT}/${name}-rec.png` });
  await t.click('.lesson-btn');
  await t.click('.lesson-btn');
  await t.waitForFunction(() => !document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 20000 });
  // 올리기가 끝날 때까지
  const t1 = Date.now();
  for (;;) {
    const d = fs.readdirSync(landing).filter((x) => !known.has(x) && fs.existsSync(path.join(landing, x, '_done.json')));
    if (d.length || Date.now() - t1 > 120000) { r.done = d; break; }
    await t.waitForTimeout(1500);
  }
  r.stat = await mock('__stat');
  r.toast = await t.locator('.toast').allInnerTexts().catch(() => []);
  await b.close();
  return r;
}
if (MODE === 'rec' || MODE === 'all') {
  res.rec = await lesson({ name: 'rec', args: [], long: true, code: 'ktestcode' });
  const dirs = fs.readdirSync(landing).filter((x) => !x.startsWith('_'));
  res.landingDirs = dirs;
  if (dirs[0]) {
    const d = path.join(landing, dirs[0]);
    res.partFiles = fs.readdirSync(d).length;
    res.doneJson = JSON.parse(fs.readFileSync(path.join(d, '_done.json'), 'utf8'));
  }
}
if ((MODE === 'rec' || MODE === 'all') && res.landingDirs?.[0]) {
  // PC 쪽: 조각 합치기 → 학생 녹화 폴더 → rec_folder 가 찾는지 (가짜 학생 폴더, 진짜 Student_Lessons 는 건드리지 않음)
  const root = path.join(OUT, 'sl', 'Student_Lessons');
  const sd = path.join(root, 'Test S (9999999)');
  fs.mkdirSync(path.join(sd, 'kwd-board'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'kwd-board', 'classroom.json'), JSON.stringify({ code: 'ktestcode' }));
  const MERGE = 'C:/KWD/discord-bridge/office/agents/classroom/results/T083d_rec_parts_merge.py';
  const py = (a) => spawnSync('python', ['-I', ...a], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const m = py([MERGE, '--landing', landing, '--root', root, '--receipt', path.join(OUT, 'rl.jsonl'), '--min-age-minutes', '0']);
  res.merge = m.stdout.trim().split('\n').pop();
  res.mergeErr = m.stderr.slice(-300);
  const rf = path.join('C:/KWD/work/intake/lifecycle/rec_folder.py');
  res.recFolderList = py(['-B', rf, 'list', '--root', root]).stdout.slice(0, 700);
  const rec = path.join(sd, '녹화');
  if (fs.existsSync(rec)) {
    res.recDirFiles = fs.readdirSync(path.join(rec, fs.readdirSync(rec)[0]));
    const vol = (f) => (spawnSync('C:/ffmpeg/bin/ffmpeg.exe', ['-hide_banner', '-nostats', '-i', f, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+) dB/) || [])[1];
    const dir = path.join(rec, fs.readdirSync(rec)[0]);
    res.meanVolume = {};
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.webm'))) res.meanVolume[f.replace(/^.*?(_Teacher|_Student|_Media)?\.webm$/, (_m, k) => k || 'video')] = vol(path.join(dir, f));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((x) => x.endsWith('_rec.json'))), 'utf8'));
    res.audioCheck = meta.audio_check;
  }
}
if (MODE === 'silent' || MODE === 'all') {
  const before = new Set(fs.readdirSync(landing));
  res.silent = await lesson({ name: 'silent', args: [`--use-file-for-fake-audio-capture=${silent}`], long: false, silentMode: true });
  res.silentDirs = fs.readdirSync(landing).filter((x) => !before.has(x));
}
res.errs = errs;
gas.kill();
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
