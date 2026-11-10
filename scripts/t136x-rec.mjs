// T136x 시험: 판 녹화가 조용히 사라지지 않는다 (A07-F03·F11, 무음 검사)
// ① 무음 마이크 + 드라이브 올리기 실패(가짜 구글 끊김) → 수업 중 무음 붉은 줄 · 녹화 중 탭 닫기 경고 ·
//    끝나면 붉은 칸 + '녹화 내려받기' → zip 안에 녹화 4줄 + _rec.json + 판 기록, _rec.json 의 faces·무음·kbps
// ② 탭이 닫혀 끝 처리가 없던 수업 → 판을 다시 열면 _rec.json 을 만들어 드라이브까지 끝 표시(_done)
// 가짜 구글(mock-gas.mjs)과 가짜 학생 번호만 쓴다. 실제 학생 자료·진짜 구글은 건드리지 않는다.
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = process.env.WS || 'ws://localhost:1234';
const OUT = path.resolve(process.env.OUT || 'test-results/t136x');
const KEY = 'testkey-0123456789abcdef';
const PORT = 8798;
fs.rmSync(OUT, { recursive: true, force: true });
const mirror = path.join(OUT, 'mirror');
const landing = path.join(OUT, 'landing');
fs.mkdirSync(mirror, { recursive: true });
fs.mkdirSync(landing, { recursive: true });
const gas = spawn('node', ['scripts/mock-gas.mjs', String(PORT), mirror, landing, KEY], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const mock = (q) => fetch(`http://localhost:${PORT}/${q}`).then((r) => r.json());
const silent = path.join(OUT, 'silence.wav');
{
  const sr = 48000, n = sr * 5, ch = 2;
  const b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  fs.writeFileSync(silent, b);
}
const res = {};
const errs = [];
const b = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${silent}`] });
const ctx = await b.newContext({ viewport: { width: 1366, height: 820 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
await ctx.addInitScript(([k, u]) => { try { localStorage.setItem('kwd.gasKey', k); localStorage.setItem('kwd.gasUrl', u); localStorage.setItem('kwd.test.orphanMs', '3000'); } catch (e) { /* */ } }, [KEY, `http://localhost:${PORT}/`]);
const watch = (n, p) => {
  p.on('pageerror', (e) => errs.push(n + ': ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|ERR_CONNECTION|ERR_EMPTY_RESPONSE|Failed to load resource|net::|Failed to fetch/.test(m.text()) && errs.push(n + ' console: ' + m.text()));
};
const id = 'x' + Date.now().toString(36);
const url = `${BASE}/#/b/${id}?r=t&st=9999999&srv=${encodeURIComponent(WS)}&tk=testtoken`;
const idb = (p) => p.evaluate(() => new Promise((ok) => {
  const q = indexedDB.open('kwd-rec');
  q.onsuccess = () => { const tx = q.result.transaction('sessions'); const a = tx.objectStore('sessions').getAll(); tx.oncomplete = () => ok(a.result.map((s) => ({ ended: !!s.ended, uploaded: !!s.uploaded, orphan: !!s.orphan, meta: s.meta || '', tracks: Object.keys(s.tracks).length }))); };
}));

// ---------- ① 무음 + 올리기 실패 ----------
const t = await ctx.newPage();
watch('fail', t);
await mock('__fail?on=1');
await t.goto(url);
await t.waitForSelector('.board-doc');
await t.click('.lesson-btn');
await t.waitForFunction(() => document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 20000 });
res.crop = await t.evaluate(() => window.__kwd.store.meta.get('recording')?.crop);
res.unloadAsks = await t.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
await t.waitForSelector('.rec-warn', { timeout: 30000 });
await t.waitForTimeout(1500);
res.warn = await t.locator('.rec-warn').innerText();
await t.waitForTimeout(2000);
await t.click('.lesson-btn');
await t.click('.lesson-btn');
await t.waitForFunction(() => !document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 20000 });
res.unloadAfter = await t.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
const t0 = Date.now();
await t.waitForSelector('.rec-fail', { timeout: 90000 });
res.failAfterS = Math.round((Date.now() - t0) / 1000);
res.failText = await t.locator('.rec-fail p').innerText();
res.failOverflow = await t.evaluate(() => { const r = document.querySelector('.rec-fail').getBoundingClientRect(); return r.right > innerWidth || r.left < 0; });
await t.screenshot({ path: `${OUT}/fail.png` });
const dl = t.waitForEvent('download', { timeout: 20000 });
await t.click('.rec-fail .rf-dl');
const d = await dl;
const zp = `${OUT}/fail.zip`;
await d.saveAs(zp);
res.zipName = d.suggestedFilename();
const z = await JSZip.loadAsync(fs.readFileSync(zp));
res.zipFiles = Object.keys(z.files).map((n) => n.replace(/^.*?((_Teacher|_Student|_Media)?\.webm|_rec\.json|\.kwd\.zip)$/, '$1'));
const mf = Object.keys(z.files).find((n) => n.endsWith('_rec.json'));
const meta = mf ? JSON.parse(await z.files[mf].async('string')) : {};
res.meta = { faces: meta.faces, faces_basis: meta.faces_basis, crop: meta.crop, empty: meta.empty, kbps: meta.kbps, teacherSilent: meta.audio_check?.teacher?.silent_ratio, teacherMax: meta.audio_check?.teacher?.max_db, warned: meta.audio_check?.warned, rec_fail: meta.rec_fail };
res.events = await t.evaluate(() => window.__kwd.store.events.toArray().filter((e) => e.kind === 'lesson').map((e) => e.data?.op + (e.data?.what ? ':' + e.data.what : '')));
res.sessionsAfterFail = await idb(t);
// 인터넷이 돌아오면 뒤에서 이어 올려 끝 표시까지
await mock('__fail?on=0');
const t1 = Date.now();
for (;;) {
  const dd = fs.readdirSync(landing).filter((x) => fs.existsSync(path.join(landing, x, '_done.json')));
  if (dd.length || Date.now() - t1 > 90000) { res.doneAfterBack = dd.length; break; }
  await t.waitForTimeout(1500);
}
res.landing1 = fs.readdirSync(landing).map((x) => fs.readdirSync(path.join(landing, x)).filter((f) => /_rec\.json|_done\.json|\.kwd\.zip/.test(f)).map((f) => f.replace(/^.*?(_rec\.json|_done\.json|\.kwd\.zip).*$/, '$1')).sort());
await t.close();

// ---------- ② 탭이 닫힌 수업 ----------
const t2 = await ctx.newPage();
t2.on('pageerror', (e) => errs.push('orphan: ' + String(e)));
await t2.goto(url.replace(id, id + 'o'));
await t2.waitForSelector('.board-doc');
await t2.click('.lesson-btn');
await t2.waitForFunction(() => document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 20000 });
await t2.waitForTimeout(5000);
// 탭이 갑자기 죽음 (끝내기 없이; 보통 탭 닫기는 마무리가 돌기도 해서 강제 종료로 흉내)
const cdp = await ctx.newCDPSession(t2);
void cdp.send('Page.crash').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
await Promise.race([t2.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
await new Promise((r) => setTimeout(r, 4000));
const before = new Set(fs.readdirSync(landing).filter((x) => fs.existsSync(path.join(landing, x, '_done.json'))));
const t3 = await ctx.newPage();
watch('reopen', t3);
await t3.goto(`${BASE}/#/`);
const t4 = Date.now();
for (;;) {
  const dd = fs.readdirSync(landing).filter((x) => !before.has(x) || fs.existsSync(path.join(landing, x, '_done.json')));
  const fresh = dd.filter((x) => !before.has(x) && fs.existsSync(path.join(landing, x, '_done.json')));
  if (fresh.length || Date.now() - t4 > 90000) {
    res.orphanDirs = fresh.length;
    if (fresh[0]) {
      const dir = path.join(landing, fresh[0]);
      res.orphanFiles = [...new Set(fs.readdirSync(dir).map((f) => f.replace(/^.*?((_Teacher|_Student|_Media)?\.webm|_rec\.json|_done\.json).*$/, '$1')))].sort();
      const done = JSON.parse(fs.readFileSync(path.join(dir, '_done.json'), 'utf8'));
      res.orphanDone = { meta: /_rec\.json$/.test(done.meta || '') };
      const rj = fs.readdirSync(dir).find((f) => f.includes('_rec.json'));
      if (rj) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, rj), 'utf8'));
        res.orphanMeta = { orphan: j.orphan, chunks: Object.keys(j.chunks || {}).length };
      }
    }
    break;
  }
  await t3.waitForTimeout(1500);
}
res.sessionsEnd = await idb(t3);
await b.close();
gas.kill();
res.errs = errs;
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
