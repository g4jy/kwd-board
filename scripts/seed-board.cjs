// 수업 전 판에 웹 학습지 미리 넣기 (대표 11/02): 선생님·학생이 같은 판(<교실코드>d<수업일>)에 들어오면 이미 떠 있게
// 이름이 같은 자료가 이미 있으면 다시 넣지 않는다. KWD_BOARD_WS 로 서버 바꿈(시험용)
// node scripts/seed-board.cjs <교실코드> <html 파일> <이름> [수업일 YYMMDD] [--check]
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WS = require('ws');
const fs = require('fs');

const [code, file, name, dayArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const checkOnly = process.argv.includes('--check');
const SERVER = process.env.KWD_BOARD_WS || 'wss://kwd-board-sync.impressive261.workers.dev'; // 시험은 ws://localhost:1234
function lessonDay(d = new Date()) {
  const t = new Date(d.getTime() - 4 * 3600_000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const g = (k) => p.find((x) => x.type === k).value;
  return `${g('year')}${g('month')}${g('day')}`;
}
const rid = (n = 8) => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
const id = `${code}d${dayArg || lessonDay()}`;
const doc = new Y.Doc();
const prov = new WebsocketProvider(SERVER, 'kwd-' + id, doc, { WebSocketPolyfill: WS });
const done = (msg, c = 0) => { console.log(msg); setTimeout(() => { prov.destroy(); process.exit(c); }, 1500); };
setTimeout(() => done('timeout: 서버 동기 안 됨', 1), 20000);
prov.on('sync', (ok) => {
  if (!ok) return;
  const pages = doc.getArray('pages');
  // 같은 id 페이지가 겹쳐 있으면 하나만 남긴다(T083 중복 버그로 생긴 판 정리)
  const seen = new Set();
  doc.transact(() => { for (let i = pages.length - 1; i >= 0; i--) { const p = pages.get(i).get('id'); if (seen.has(p)) pages.delete(i, 1); else seen.add(p); } });
  const materials = doc.getMap('materials');
  const list = () => [...materials.values()].map((m) => m.name);
  if (checkOnly) return done(`board ${id} pages=${pages.length} materials=${JSON.stringify(list())}`);
  const num = (n) => (/^#(\d+)/.exec(n || '') || [])[1];
  if (list().some((n) => n === name || (num(name) && num(n) === num(name)))) return done(`already: ${id} ${name}`);
  const html = fs.readFileSync(file, 'utf8');
  const mid = rid();
  doc.transact(() => {
    let pid;
    if (pages.length === 0) {
      const m = new Y.Map();
      pid = 'p1' + id.slice(0, 4);
      for (const [k, v] of Object.entries({ id: pid, kind: 'text', w: 820, h: 1160 })) m.set(k, v);
      pages.push([m]);
    } else pid = pages.get(0).get('id');
    materials.set(mid, { id: mid, name, type: 'html', pages: 1 });
    doc.getMap('matdata').set(`${mid}/1`, { html, w: 960, h: 600 });
    const o = new Y.Map();
    for (const [k, v] of Object.entries({ type: 'html', x: 900, y: 0, w: 962, h: 634, mid, name, step: 1, steps: 1, id: rid(), t: Date.now() })) o.set(k, v);
    doc.getArray('obj:' + pid).push([o]);
  });
  done(`seeded ${id} page=${pages.get(0).get('id')} mid=${mid} bytes=${html.length}`);
});
