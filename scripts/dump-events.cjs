// 읽기 전용: 판 서버 문서의 events 를 뽑아 JSON 으로 쓴다. node scripts/dump-events.cjs <판id> <출력.json>
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WS = require('ws');
const fs = require('fs');
const [id, out] = process.argv.slice(2);
const SERVER = process.env.KWD_BOARD_WS || 'wss://kwd-board-sync.impressive261.workers.dev';
const doc = new Y.Doc();
const { roomWt } = require('./wt.cjs'); // T136ak 쓰기 토큰(읽기에도 연결에 필요)
let prov = null;
const fin = (c) => { if (prov) prov.destroy(); process.exit(c); };
setTimeout(() => { console.log('timeout'); fin(1); }, 25000);
roomWt(SERVER, 'kwd-' + id).then((wt) => {
prov = new WebsocketProvider(SERVER, 'kwd-' + id, doc, { WebSocketPolyfill: WS, awareness: undefined, params: wt ? { wt } : {} });
prov.on('sync', (ok) => {
  if (!ok) return;
  const ev = doc.getArray('events').toArray();
  const pages = doc.getArray('pages').toArray().map((p) => p.toJSON ? p.toJSON() : p);
  fs.writeFileSync(out, JSON.stringify({ n: ev.length, pages, materials: doc.getMap('materials').toJSON(), events: ev }, null, 0));
  console.log('events', ev.length, 'pages', pages.length);
  setTimeout(() => fin(0), 500);
});
}, (e) => { console.log('blocked', e.message); fin(1); });
