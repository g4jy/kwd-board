// 시험용 가짜 구글 드라이브 웹앱 (gas/Code.gs 와 같은 요청·응답). 진짜 구글에 올리지 않고 임시 폴더에 쓴다.
//   node scripts/mock-gas.mjs <포트> <거울 폴더> <작업중 폴더> <열쇠>
// 시험용 스위치: GET /__fail?on=1 (모든 요청 거절 = 인터넷 끊김 흉내) · GET /__fail?on=0 · GET /__stat
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [port, mirror, landing, token] = [Number(process.argv[2] || 8799), process.argv[3], process.argv[4], process.argv[5]];
let fail = false;
let calls = 0;
let denied = 0;
const log = [];
const safe = (n) => String(n).replace(/[\/:*?"<>|]/g, '_');
const send = (res, o, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(o));
};
const ACT = {
  ping: () => ({ t: Date.now() }),
  ls: (q) => {
    const d = path.join(q.r === 'data' ? path.join(mirror, '..', 'data') : mirror, ...(q.p || []));
    if (!fs.existsSync(d)) throw new Error('notfound');
    return { list: fs.readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? { n: e.name, d: 1 } : { n: e.name, d: 0, s: fs.statSync(path.join(d, e.name)).size, m: fs.statSync(path.join(d, e.name)).mtimeMs })) };
  },
  get: (q) => {
    const f = path.join(q.r === 'data' ? path.join(mirror, '..', 'data') : mirror, ...(q.p || []));
    if (!fs.existsSync(f)) throw new Error('notfound');
    return { b: fs.readFileSync(f).toString('base64'), s: fs.statSync(f).size, m: fs.statSync(f).mtimeMs, t: 'application/octet-stream' };
  },
  rec_put: (q) => {
    const d = path.join(landing, safe(q.id));
    fs.mkdirSync(d, { recursive: true });
    let saved = 0, skipped = 0;
    for (const p of q.parts || []) {
      const nm = `${p.n}.p${String(p.s).padStart(7, '0')}_${String(p.e).padStart(7, '0')}`;
      const f = path.join(d, nm);
      if (fs.existsSync(f)) { skipped++; continue; }
      fs.writeFileSync(f, Buffer.from(p.b, 'base64'));
      saved++;
    }
    log.push(`put ${saved}/${skipped}`);
    return { saved, skipped };
  },
  rec_done: (q) => {
    const d = path.join(landing, safe(q.id));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '_done.json'), JSON.stringify({ schema: 'kwd-rec-parts/v1', id: q.id, tracks: q.tracks || {}, meta: q.meta || '', at: new Date().toISOString() }));
    log.push('done');
    return { done: true };
  },
};
http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__fail') { fail = u.searchParams.get('on') === '1'; return send(res, { fail }); }
    if (u.pathname === '/__stat') return send(res, { calls, denied, log });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      if (fail) { denied++; return res.destroy(); }
      try {
        const q = JSON.parse(body);
        if (q.k !== token) return send(res, { ok: false, error: 'auth' });
        const f = ACT[q.a];
        if (!f) return send(res, { ok: false, error: 'action' });
        send(res, { ok: true, ...f(q) });
      } catch (e) {
        send(res, { ok: false, error: String(e.message || e) });
      }
    });
  })
  .listen(port, () => console.log('mock-gas', port));
