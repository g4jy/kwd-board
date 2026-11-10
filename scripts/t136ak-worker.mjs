// T136ak 시험: Cloudflare 워커(server/cloudflare)를 이 PC에서(wrangler dev --local) 띄워 접근 통제를 확인한다.
// ① 방 쓰기 토큰(/wt): 토큰 없는·위조 연결과 자료 올리기는 거절, 받은 토큰이면 쓰기·저장 ② 지난 날짜 교실 판은 학생 읽기만(TEACHER_GUARD)
// ③ 끊은 교실 코드: 막을 목록에 넣으면 /wt·연결·/turn·자료 403, 빼면 다시 됨 ④ export 의 _server(저장 실패 수)·snaps
// 시험 값 열쇠만 쓴다. 진짜 서버·비밀값은 건드리지 않는다.  node scripts/t136ak-worker.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WS from 'ws';

const PORT = Number(process.env.PORT || 8791);
const TT = 'testtoken-worker';
const dir = path.resolve('server/cloudflare');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'kwd-t136ak-'));
const bin = path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let dev = null;
let devLog = '';
let HTTP = '';
let WSU = '';
const killDev = () => {
  try {
    if (dev && process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(dev.pid)], { stdio: 'ignore' });
    else if (dev) dev.kill();
  } catch {}
};
async function startDev(port, extra = []) {
  HTTP = `http://127.0.0.1:${port}`;
  WSU = `ws://127.0.0.1:${port}`;
  dev = spawn(process.execPath, [bin, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--var', 'WRITE_GUARD:on', '--var', 'TEACHER_GUARD:on', '--var', 'TEACHER_TOKEN:' + TT, ...extra, '--show-interactive-dev-session=false'], { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  dev.stdout.on('data', (d) => (devLog += d));
  dev.stderr.on('data', (d) => (devLog += d));
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(HTTP + '/')).ok) return;
    } catch {}
    await sleep(1000);
  }
}
const stop = (c) => {
  killDev();
  setTimeout(() => {
    try {
      fs.rmSync(persist, { recursive: true, force: true });
    } catch {}
    process.exit(c);
  }, 2000);
};
const hard = setTimeout(() => {
  console.log(JSON.stringify({ pass: false, error: 'timeout', log: devLog.slice(-800) }));
  stop(1);
}, 200_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { authorization: 'Bearer ' + TT };
const j = (u, o) => fetch(HTTP + u, o).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

await startDev(PORT);

// 서울 수업일(새벽 4시 바뀜) YYMMDD — 워커 lessonDay 와 같은 셈
const day = (t = Date.now()) => new Date(t + 5 * 3600_000).toISOString().slice(2, 10).replace(/-/g, '');
const wsStatus = (room, wt) =>
  new Promise((res) => {
    const s = new WS(`${WSU}/${room}${wt ? '?wt=' + encodeURIComponent(wt) : ''}`);
    s.on('open', () => (s.close(), res(101)));
    s.on('unexpected-response', (_q, r) => res(r.statusCode));
    s.on('error', () => res(-1));
  });
// y-websocket 으로 붙어 글 하나 쓰고 동기 기다림
async function writeVia(room, wt, text) {
  const doc = new Y.Doc();
  const p = new WebsocketProvider(WSU, room, doc, { WebSocketPolyfill: WS, params: wt ? { wt } : {}, disableBc: true });
  await new Promise((res) => {
    const t = setTimeout(res, 8000);
    p.on('sync', (ok) => ok && (clearTimeout(t), res()));
  });
  doc.getMap('meta').set('t136ak', text);
  await sleep(2500); // 서버 저장(1.5초 미룸) 지나게
  p.destroy();
  doc.destroy();
}

const r = {};
const room = 'kwd-t136akroom1';
const w = await j(`/wt?room=${room}`);
r.wt_student = w.body?.kind === 'w' && /^w\./.test(w.body?.wt || '') && w.body?.guard === true;
const wt = w.body?.wt || '';
const tw = await j(`/wt?room=${room}`, { headers: auth });
r.wt_teacher = tw.body?.kind === 't';
r.ws_no_token = await wsStatus(room, '');
r.ws_forged = await wsStatus(room, 'w.AAAAAAAAAAAAAAAAAAAAAA');
r.ws_other_room_token = await wsStatus('kwd-t136akroom2', wt);
r.ws_ok = await wsStatus(room, wt);
r.ws_admin_room = await wsStatus('__admin', '');
await writeVia(room, wt, 'hello');
const ex = await j(`/rooms/${room}/export`, { headers: auth });
r.export_written = ex.body?.meta?.t136ak === 'hello';
r.export_server = ex.body?._server && ex.body._server.saveFails === 0 && ex.body._server.savedAt > 0;
r.export_no_auth = (await j(`/rooms/${room}/export`)).status;
r.snaps = (await j(`/rooms/${room}/snaps`, { headers: auth })).body;
// 자료 그림 올리기
const put = (q) => fetch(`${HTTP}/rooms/${room}/blobs/t1.jpg${q}`, { method: 'PUT', body: 'img', headers: { 'content-type': 'image/jpeg' } }).then((x) => x.status);
r.blob_put_no_token = await put('');
r.blob_put_ok = await put('?wt=' + encodeURIComponent(wt));
r.blob_get = (await fetch(`${HTTP}/rooms/${room}/blobs/t1.jpg`)).status;

// 지난 날짜 교실 판: 학생 = 읽기만(r), 어제·오늘 = 쓰기
const code = 'k2345678m';
const old = `kwd-${code}d${day(Date.now() - 5 * 86400_000)}`;
const ro = await j(`/wt?room=${old}`);
r.past_student_kind = ro.body?.kind;
r.past_teacher_kind = (await j(`/wt?room=${old}`, { headers: auth })).body?.kind;
r.today_student_kind = (await j(`/wt?room=kwd-${code}d${day()}`)).body?.kind;
r.yesterday_student_kind = (await j(`/wt?room=kwd-${code}d${day(Date.now() - 86400_000)}`)).body?.kind;
const twOld = (await j(`/wt?room=${old}`, { headers: auth })).body?.wt;
await writeVia(old, twOld, 'teacher');
await writeVia(old, ro.body?.wt, 'student');
r.past_after_student_write = (await j(`/rooms/${old}/export`, { headers: auth })).body?.meta?.t136ak; // 'teacher' 여야 함
r.past_blob_put_ro = await fetch(`${HTTP}/rooms/${old}/blobs/t2.jpg?wt=${encodeURIComponent(ro.body?.wt || '')}`, { method: 'PUT', body: 'x' }).then((x) => x.status);

// 끊은 코드
const today = `kwd-${code}d${day()}`;
const twT = (await j(`/wt?room=${today}`)).body?.wt;
r.block_no_auth = (await j('/admin/block', { method: 'POST', body: JSON.stringify({ code }) })).status;
r.block_bad_code = (await j('/admin/block', { method: 'POST', headers: auth, body: JSON.stringify({ code: 'nope' }) })).status;
r.block = (await j('/admin/block', { method: 'POST', headers: auth, body: JSON.stringify({ code }) })).body;
r.blocked_list = (await j('/admin/blocked', { headers: auth })).body;
r.blocked_wt = (await j(`/wt?room=${today}`)).status;
r.blocked_ws = await wsStatus(today, twT);
r.blocked_turn = (await j(`/turn?room=${today}`)).status;
r.blocked_blob = (await fetch(`${HTTP}/rooms/${today}/blobs/t1.jpg`)).status;
r.other_room_unaffected = (await j(`/wt?room=${room}`)).status;
r.unblock = (await j('/admin/unblock', { method: 'POST', headers: auth, body: JSON.stringify({ code }) })).body;
r.unblocked_wt = (await j(`/wt?room=${today}`)).status;
r.unblocked_ws = await wsStatus(today, twT);

// 하루 스냅샷: 같은 저장소로 '내일'(TEST_SHIFT_MS) 서버를 다시 띄워 쓰면, 어제 끝 상태가 snap-<어제> 로 남는다
killDev();
await sleep(3000);
await startDev(PORT + 1, ['--var', 'TEST_SHIFT_MS:' + 86400_000]);
const wt2 = (await j(`/wt?room=${room}`)).body?.wt;
await writeVia(room, wt2, 'nextday');
const sn = (await j(`/rooms/${room}/snaps`, { headers: auth })).body?.snaps || [];
r.snap_days = sn;
r.snap_content = sn.length ? (await j(`/rooms/${room}/export?snap=${sn[0]}`, { headers: auth })).body?.meta?.t136ak : null; // 'hello'
r.live_content = (await j(`/rooms/${room}/export`, { headers: auth })).body?.meta?.t136ak; // 'nextday'
await writeVia(room, wt2, 'nextday2');
r.snap_once = ((await j(`/rooms/${room}/snaps`, { headers: auth })).body?.snaps || []).length; // 1 (하루 한 번)
r.snap_bad = (await j(`/rooms/${room}/export?snap=../x`, { headers: auth })).status;
// 수업 전 자료 넣기(seed-board.cjs)·기록 뽑기(dump-events.cjs)도 토큰을 받아 그대로 된다
const htmlF = path.join(persist, 'm.html');
fs.writeFileSync(htmlF, '<p>t136ak</p>');
const run = (args) => new Promise((res) => {
  const c = spawn(process.execPath, args, { env: { ...process.env, KWD_BOARD_WS: WSU }, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  c.stdout.on('data', (d) => (o += d));
  c.on('exit', () => res(o.trim()));
});
r.seed = (await run(['scripts/seed-board.cjs', code, htmlF, '#1 t136ak', day()])).slice(0, 7);
r.seed_check = /materials=\["#1 t136ak"\]/.test(await run(['scripts/seed-board.cjs', code, htmlF, '#1 t136ak', day(), '--check']));
r.dump = (await run(['scripts/dump-events.cjs', `${code}d${day()}`, path.join(persist, 'ev.json')])).slice(0, 6);
await j('/admin/block', { method: 'POST', headers: auth, body: JSON.stringify({ code }) });
r.seed_blocked = (await run(['scripts/seed-board.cjs', code, htmlF, '#2 t136ak', day()])).slice(0, 7);

const pass =
  r.wt_student && r.wt_teacher && r.ws_no_token === 403 && r.ws_forged === 403 && r.ws_other_room_token === 403 && r.ws_ok === 101 && r.ws_admin_room === 400 &&
  r.export_written && r.export_server && r.export_no_auth === 401 && Array.isArray(r.snaps?.snaps) &&
  r.blob_put_no_token === 403 && r.blob_put_ok === 200 && r.blob_get === 200 &&
  r.past_student_kind === 'r' && r.past_teacher_kind === 't' && r.today_student_kind === 'w' && r.yesterday_student_kind === 'w' &&
  r.past_after_student_write === 'teacher' && r.past_blob_put_ro === 403 &&
  r.block_no_auth === 401 && r.block_bad_code === 400 && r.block?.codes?.includes(code) && r.blocked_list?.codes?.includes(code) &&
  r.blocked_wt === 403 && r.blocked_ws === 403 && r.blocked_turn === 403 && r.blocked_blob === 403 && r.other_room_unaffected === 200 &&
  !r.unblock?.codes?.includes(code) && r.unblocked_wt === 200 && r.unblocked_ws === 101 &&
  JSON.stringify(r.snap_days) === JSON.stringify([day()]) && r.snap_content === 'hello' && r.live_content === 'nextday' && r.snap_once === 1 && r.snap_bad === 400 &&
  r.seed === 'seeded ' && r.seed_check && r.dump === 'events' && r.seed_blocked === 'blocked';
clearTimeout(hard);
console.log(JSON.stringify({ pass, ...r }));
stop(pass ? 0 : 1);
