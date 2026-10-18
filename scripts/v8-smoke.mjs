// v8 교실: 선생님 카메라 켜기 → 학생 입장 화면 → 들어가기 → 서로 영상·소리 → 얼굴 크게(학생도) → 수업 시작(녹화) → 끝내기 → 파일
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const WS = process.env.WS || 'ws://localhost:1234';
const OUT = process.env.OUT || 'test-results/v8';
fs.mkdirSync(OUT, { recursive: true });
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required'];
const b = await chromium.launch({ args });
const res = {};
const errs = [];
const id = 'v8' + Date.now().toString(36);
const ctxT = await b.newContext({ viewport: { width: 1366, height: 820 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
const ctxS = await b.newContext({ viewport: { width: 390, height: 780 }, permissions: ['camera', 'microphone'], isMobile: true, hasTouch: true });
const t = await ctxT.newPage();
const s = await ctxS.newPage();
for (const [n, p] of [['T', t], ['S', s]]) {
  p.on('pageerror', (e) => errs.push(n + ': ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND/.test(m.text()) && errs.push(n + ' console: ' + m.text()));
}
await t.goto(`${BASE}/#/b/${id}?r=t&srv=${encodeURIComponent(WS)}&tk=testtoken`);
await t.waitForSelector('.board-doc');
await s.goto(`${BASE}/#/b/${id}?r=s&srv=${encodeURIComponent(WS)}`);
await s.waitForSelector('.board-doc');
await t.waitForTimeout(800);
// v8.1: 학생은 링크로 들어오자마자 입장 화면 (선생님보다 먼저 와도 됨). 선생님 카메라는 아직 꺼짐
res.joinBefore = await s.locator('.join').count();
res.dockBefore = await t.locator('.cam-dock').getAttribute('data-state');
// 판만 보기 → 카메라 칸에 '카메라 켜기' → 다시 입장 화면
await s.click('.join-board');
res.studentCamBtn = await s.locator('.cam-dock .cam-b.primary').innerText();
await s.click('.cam-dock .cam-b.primary');
await s.waitForSelector('.join .join-go', { timeout: 8000 });
await s.waitForFunction(() => document.querySelector('.join-preview')?.srcObject, null, { timeout: 8000 });
await s.screenshot({ path: `${OUT}/1-student-join.png` });
res.joinText = (await s.locator('.join-note').innerText()).slice(0, 40);
await s.click('.join .join-go');
// 학생이 들어오면 선생님 카메라가 저절로 켜진다 (이 PC에서 허용해 둔 경우)
await t.waitForFunction(() => document.querySelector('.cam-dock')?.dataset.state !== 'off', null, { timeout: 8000 });
res.teacherAuto = true;
// 연결
const live = (p) => p.waitForFunction(() => { const v = document.querySelector('.cam-remote'); return document.querySelector('.cam-dock')?.dataset.state === 'live' && v && v.videoWidth > 0; }, null, { timeout: 20000 });
await Promise.all([live(t), live(s)]);
res.connected = true;
await t.waitForTimeout(3500);
res.statusT = await t.locator('.cam-status').innerText();
res.audioTracks = await t.evaluate(() => document.querySelector('.cam-remote').srcObject.getAudioTracks().length);
await t.screenshot({ path: `${OUT}/2-teacher-live.png` });
await s.screenshot({ path: `${OUT}/3-student-live.png` });
// 학생이 마이크 끄면 선생님에게 표시
await s.click('.cam-b:has-text("마이크 끄기")');
await t.waitForTimeout(800);
res.peerMicOff = (await t.locator('.cam-status').innerText()).includes('상대 마이크 꺼짐');
await s.click('.cam-b:has-text("마이크 켜기")');
// 얼굴 크게 → 학생도
await t.click('.cam-b:has-text("얼굴 크게")');
await s.waitForSelector('.cam-dock.big', { timeout: 5000 });
res.bigBoth = (await t.locator('.cam-dock.big').count()) + (await s.locator('.cam-dock.big').count());
await t.screenshot({ path: `${OUT}/4-teacher-big.png` });
await s.screenshot({ path: `${OUT}/5-student-big.png` });
await t.click('.cam-b:has-text("판 보기")');
await s.waitForFunction(() => !document.querySelector('.cam-dock.big'), null, { timeout: 5000 });
// 카메라 칸 배치: 나란히 → 끌어서 옮기기 → 모서리로 키우기 → 새로 열어도 그대로 (이 기기만)
await t.click('.cam-b.lay-b');
await t.click('.cam-lay .cam-b[data-mode="side"]');
res.layMode = await t.locator('.cam-dock').getAttribute('data-layout');
const tb = await t.locator('.cam-tiles').boundingBox();
await t.mouse.move(tb.x + 40, tb.y + 30); await t.mouse.down(); await t.mouse.move(tb.x - 300, tb.y + 330, { steps: 8 }); await t.mouse.up();
const gb = await t.locator('.cam-grip').boundingBox();
await t.mouse.move(gb.x + 9, gb.y + 9); await t.mouse.down(); await t.mouse.move(gb.x + 129, gb.y + 69, { steps: 8 }); await t.mouse.up();
res.layAfter = await t.evaluate(() => { const r = document.querySelector('.cam-dock').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), saved: JSON.parse(localStorage.getItem('kwd.camLayout.teacher')) }; });
res.studentLayout = await s.locator('.cam-dock').getAttribute('data-layout'); // 학생 화면은 그대로
await t.screenshot({ path: `${OUT}/4b-teacher-layout.png` });
// 수업 시작 (녹화)
await t.click('.lesson-btn');
await t.waitForFunction(() => document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 10000 });
res.recLabel = await t.locator('.lesson-btn').innerText();
res.crop = await t.evaluate(() => window.__kwd.store.meta.get('recording')?.crop);
await t.keyboard.type('녹화 중에 쓴 글');
// 녹화 중 판 자료(소리 파일) 재생 → 자료 줄 + 재생 구간
const tone = fs.readFileSync('tests/fixtures/tone.webm').toString('base64');
await t.evaluate((b) => window.__kwd.insertMediaBytes(b, '듣기 자료', 'audio'), tone);
await t.waitForSelector('.obj audio', { state: 'attached', timeout: 8000 });
await t.evaluate(() => { const a = document.querySelector('.obj audio'); a.muted = false; return a.play(); });
await t.waitForTimeout(3000);
await t.evaluate(() => document.querySelector('.obj audio').pause());
await t.waitForTimeout(1500);
await t.screenshot({ path: `${OUT}/6-recording.png` });
// 끝내기: 두 번
const downloads = [];
t.on('download', (d) => downloads.push(d));
await t.click('.lesson-btn');
res.confirm = await t.locator('.lesson-btn').innerText();
await t.click('.lesson-btn');
await t.waitForFunction(() => !document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 15000 });
await t.waitForTimeout(2500);
res.files = [];
for (const d of downloads) {
  const p = `${OUT}/dl_${d.suggestedFilename().replace(/[^\w.#-]/g, '_')}`;
  await d.saveAs(p);
  res.files.push({ name: d.suggestedFilename(), bytes: fs.statSync(p).size });
  if (/_Media\.webm$/.test(d.suggestedFilename())) res.mediaPath = p;
  if (/_rec\.json$/.test(d.suggestedFilename())) res.meta = JSON.parse(fs.readFileSync(p, 'utf8'));
}
res.events = await t.evaluate(() => window.__kwd.store.events.toArray().filter((e) => e.kind === 'lesson' || e.kind === 'call' || e.kind === 'media').map((e) => e.kind + ':' + (e.data?.op || '')));
// 학생이 나가면 선생님은 기다림으로
await s.close();
await t.waitForTimeout(3000);
res.afterLeave = await t.locator('.cam-dock').getAttribute('data-state');
// 학생 고정 링크 #/c/<코드> → 그날 판(<코드>d<수업일>)에 학생으로
const s2 = await ctxS.newPage();
await s2.goto(`${BASE}/#/c/kabcd2345`);
await s2.waitForSelector('.join', { timeout: 10000 });
res.fixedLink = await s2.evaluate(() => ({ id: window.__kwd.store.id, role: document.body.className, hash: location.hash, join: !!document.querySelector('.join') }));
await s2.close();
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
