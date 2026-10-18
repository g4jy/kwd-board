// 로컬·개발용 y-websocket 서버 (yjs 13 + y-protocols + ws). `npm run server` → ws://localhost:1234
// 방 하나 = Y.Doc 하나. 메모리에만 두며, 클라이언트가 IndexedDB에 저장하므로 서버가 꺼져도 판은 남는다.
// 실전은 server/cloudflare (무료 티어, 항상 켜짐) 또는 아무 Node 호스트에 이 파일.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 1234);
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(name) {
    this.name = name;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    /** @type {Map<import('ws').WebSocket, Set<number>>} */
    this.conns = new Map();
    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const conn of this.conns.keys()) if (conn !== origin) send(conn, msg);
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      if (origin && this.conns.has(origin)) {
        const ids = this.conns.get(origin);
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const conn of this.conns.keys()) send(conn, msg);
    });
  }
}

function send(conn, msg) {
  if (conn.readyState !== 0 && conn.readyState !== 1) return;
  try {
    conn.send(msg, (err) => err && conn.close());
  } catch {
    conn.close();
  }
}

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = new Room(name);
    rooms.set(name, r);
  }
  return r;
}

function onConnection(conn, req) {
  conn.binaryType = 'arraybuffer';
  const name = decodeURIComponent((req.url || '/').slice(1).split('?')[0]) || 'default';
  const room = getRoom(name);
  room.conns.set(conn, new Set());

  conn.on('message', (data) => {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, room.doc, conn);
        if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), conn);
      }
    } catch (e) {
      console.error('bad message', e);
    }
  });

  const close = () => {
    const ids = room.conns.get(conn);
    room.conns.delete(conn);
    if (ids) awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(ids), null);
    if (room.conns.size === 0) {
      // 아무도 없으면 10분 뒤 방을 비운다 (클라이언트가 다시 오면 IndexedDB에서 채운다)
      setTimeout(() => {
        if (room.conns.size === 0 && rooms.get(name) === room) {
          room.doc.destroy();
          rooms.delete(name);
        }
      }, 10 * 60 * 1000);
    }
  };
  conn.on('close', close);
  conn.on('error', close);

  // ping/pong 로 끊긴 연결 정리
  let alive = true;
  conn.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) {
      clearInterval(ping);
      conn.terminate();
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      clearInterval(ping);
    }
  }, 30000);
  conn.on('close', () => clearInterval(ping));

  // sync step 1 + 현재 awareness
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  send(conn, encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const enc2 = encoding.createEncoder();
    encoding.writeVarUint(enc2, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc2, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys())));
    send(conn, encoding.toUint8Array(enc2));
  }
}

// ---- HTTP: /time · /rooms/<id>/export · /students/<번호>/(memory|next).json ----
const TOKEN = process.env.TEACHER_TOKEN || '';
const DATA = process.env.DATA_DIR || path.resolve('server-data');
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
const reply = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, ...cors });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const authed = (req) => TOKEN && (req.headers.authorization || '') === 'Bearer ' + TOKEN;

function exportRoom(name) {
  const room = rooms.get(name);
  if (!room) return null;
  const doc = room.doc;
  const pages = doc.getArray('pages').toArray().map((m) => m.toJSON());
  const text = {};
  for (const p of pages) if (p.kind === 'text') text[p.id] = doc.getXmlFragment('text:' + p.id).toString();
  const ink = {};
  for (const p of pages) ink[p.id] = doc.getArray('ink:' + p.id).toArray();
  return {
    meta: doc.getMap('meta').toJSON(),
    pages,
    text,
    ink,
    materials: doc.getMap('materials').toJSON(),
    events: doc.getArray('events').toArray(),
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'OPTIONS') return reply(res, 204, '');
  if (url.pathname === '/time') return reply(res, 200, { t: Date.now() });
  // 교실 통화: 로컬 서버는 STUN 만 (TURN_URLS·TURN_USER·TURN_PASS 를 주면 그것도)
  if (url.pathname === '/turn') {
    const ice = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
    if (process.env.TURN_URLS) ice.push({ urls: process.env.TURN_URLS.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
    return reply(res, 200, { iceServers: ice, turn: !!process.env.TURN_URLS });
  }
  let m = /^\/rooms\/([\w-]+)\/export$/.exec(url.pathname);
  if (m) {
    if (!authed(req)) return reply(res, 401, { error: 'teacher token required' });
    const out = exportRoom(m[1].startsWith('kwd-') ? m[1] : 'kwd-' + m[1]);
    return out ? reply(res, 200, out) : reply(res, 404, { error: 'room not loaded' });
  }
  m = /^\/rooms\/([\w-]+)\/blobs\/([\w.-]{1,80})$/.exec(url.pathname);
  if (m) {
    // 자료 그림: 방 id 를 아는 기기만 (판 링크 = 권한)
    const file = path.join(DATA, 'blobs', m[1], m[2]);
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return reply(res, 404, { error: 'none' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ...cors });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'PUT') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.concat(chunks));
        reply(res, 200, { ok: true, bytes: size });
      });
      return;
    }
  }
  m = /^\/students\/([\w-]{1,40})\/(memory|next)\.json$/.exec(url.pathname);
  if (m) {
    if (!authed(req)) return reply(res, 401, { error: 'teacher token required' });
    const file = path.join(DATA, 'students', m[1], m[2] + '.json');
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return reply(res, 404, { error: 'none' });
      return reply(res, 200, fs.readFileSync(file, 'utf8'));
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          JSON.parse(body);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, body);
          reply(res, 200, { ok: true });
        } catch {
          reply(res, 400, { error: 'invalid json' });
        }
      });
      return;
    }
  }
  reply(res, 200, `kwd-board sync server · rooms ${rooms.size}\n`, 'text/plain; charset=utf-8');
});
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', onConnection);
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
server.listen(port, host, () => console.log(`y-websocket listening on ws://${host}:${port}`));
