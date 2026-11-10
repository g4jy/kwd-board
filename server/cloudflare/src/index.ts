// KWD 수업 판 동기화 서버 — Cloudflare Workers + Durable Objects (y-websocket 프로토콜)
// 방(판) 하나 = Durable Object 하나. 문서·자료 그림·학생 메모리는 DO 저장소(SQLite)에 조각으로 남는다.
// Workers Free: 하루 요청 10만(웹소켓 메시지 포함) — 수업 5~8회/일까지 무료.
//   WS  /<room>                          y-websocket
//   GET /time                            서버 시각 (판의 시각 보정)
//   GET /rooms/<room>/export             판 내보내기 (선생님 열쇠)
//   PUT·GET /rooms/<room>/blobs/<key>    자료 그림 (판 id = 권한)
//   PUT·GET /students/<번호>/<memory|next>.json  학생 메모리 (선생님 열쇠)
//   GET /turn?room=<room>                교실 통화 중계(TURN) 임시 열쇠 — Cloudflare Realtime TURN, 비밀은 워커에만
//   GET /wt?room=<room>                  방 쓰기 토큰 (T136ak A07-F09). 끊은 코드면 403
//   GET /rooms/<room>/snaps              하루 한 번 스냅샷 목록 (선생님 열쇠) · export?snap=<YYMMDD> 로 그날 내용
//   GET /admin/blocked · POST /admin/block|unblock {code}   끊은 교실 코드 목록 (선생님 열쇠, T136ak A07-F10)
// 스위치(wrangler.toml [vars]): WRITE_GUARD=on → 쓰기 토큰 없는 연결·자료 올리기 거절
//                               TEACHER_GUARD=on → 지난 날짜 교실 판은 선생님 토큰 연결만 쓰기 (A05-F17, 기본 꺼짐)
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  TEACHER_TOKEN?: string;
  TURN_KEY_ID?: string; // Cloudflare 대시보드 → Realtime → TURN 키 (wrangler secret put)
  TURN_KEY_API_TOKEN?: string;
  ROOM_SECRET?: string; // 쓰기 토큰 서명 열쇠. 없으면 TEACHER_TOKEN 으로 서명
  WRITE_GUARD?: string; // 'on' | 'off'
  TEACHER_GUARD?: string; // 'on' | 'off'
  TEST_SHIFT_MS?: string; // 시험(wrangler dev)에서만: 스냅샷의 '오늘'을 밀어 하루 넘김을 흉내. 실서버에는 두지 않는다
}

// ---- 쓰기 토큰: <종류>.<서명>  종류 w=쓰기 r=읽기만 t=선생님. 서명 = HMAC-SHA256(열쇠, 종류|방) ----
type Kind = 'w' | 'r' | 't';
const ROOM_RE = /^[\w-]{4,64}$/;
const okRoom = (r: string) => ROOM_RE.test(r) && !r.startsWith('__');
const signKey = (env: Env) => env.ROOM_SECRET || env.TEACHER_TOKEN || '';
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(env: Env, kind: Kind, room: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(signKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return kind + '.' + b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(kind + '|' + room))).slice(0, 22);
}
async function verify(env: Env, wt: string, room: string): Promise<Kind | null> {
  const kind = wt.charAt(0) as Kind;
  if (!signKey(env) || !'wrt'.includes(kind) || wt.charAt(1) !== '.') return null;
  const want = await sign(env, kind, room);
  if (want.length !== wt.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ wt.charCodeAt(i);
  return d === 0 ? kind : null;
}
const guardOn = (env: Env) => env.WRITE_GUARD === 'on' && !!signKey(env);
// 수업일(서울 시간 새벽 4시에 바뀜, src/kwdfolder.ts lessonDay 와 같은 셈) YYMMDD
export function lessonDay(t = Date.now()): string {
  return new Date(t + (9 - 4) * 3600_000).toISOString().slice(2, 10).replace(/-/g, '');
}
// 교실 판 방 이름 kwd-<코드 9자>d<YYMMDD>
const classRoom = (room: string) => /^kwd-(k[a-z0-9]{8})d(\d{6})$/.exec(room);

// ---- 끊은 교실 코드 (관리 DO '__admin' 에 저장, 워커는 30초 기억) ----
let blockedCache: { at: number; set: Set<string> } | null = null;
async function blockedSet(env: Env): Promise<Set<string>> {
  if (blockedCache && Date.now() - blockedCache.at < 30_000) return blockedCache.set;
  try {
    const r = await env.ROOMS.get(env.ROOMS.idFromName('__admin')).fetch('https://do/admin/blocked');
    const j = (await r.json()) as { codes?: string[] };
    blockedCache = { at: Date.now(), set: new Set(j.codes || []) };
  } catch (e) {
    console.error('[kwd] blocked list read failed', e);
    if (!blockedCache) return new Set();
  }
  return blockedCache!.set;
}
async function isBlocked(env: Env, room: string): Promise<boolean> {
  const m = classRoom(room);
  return !!m && (await blockedSet(env)).has(m[1]);
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 1500;
const CHUNK = 120 * 1024; // DO 저장 값 한도 안쪽으로 나눠 저장

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/time') return json({ t: Date.now() });
    if (url.pathname === '/turn') {
      // 판 id(방)를 아는 기기만 쓸 수 있게 방 이름 꼴만 확인. 열쇠는 1시간짜리
      const room = url.searchParams.get('room') || '';
      if (!okRoom(room)) return json({ error: 'room required' }, 400);
      if (await isBlocked(env, room)) return json({ error: 'blocked' }, 403);
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: false });
      // 붙여 넣을 때 딸려 온 공백·줄바꿈·따옴표를 걷어 낸다
      const clean = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
      const keyId = clean(env.TURN_KEY_ID), token = clean(env.TURN_KEY_API_TOKEN);
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 4 * 3600 }), // 수업 하나보다 넉넉히
      });
      if (!r.ok) {
        // 진단용: 값 자체는 내보내지 않고 길이와 Cloudflare 오류 문구만
        const why = (await r.text()).slice(0, 200);
        return json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: false, status: r.status, why, id_len: keyId.length, token_len: token.length });
      }
      const j = (await r.json()) as { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> };
      // 후보를 한 번에 모아 보내므로(trickle 없음) 53번 포트 주소는 빼서 기다림을 줄인다
      const ice = (j.iceServers || []).map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }));
      return json({ iceServers: ice, turn: true });
    }
    const authed = !!env.TEACHER_TOKEN && req.headers.get('authorization') === 'Bearer ' + env.TEACHER_TOKEN;
    if (url.pathname === '/wt') {
      const room = url.searchParams.get('room') || '';
      if (!okRoom(room)) return json({ error: 'room required' }, 400);
      if (await isBlocked(env, room)) return json({ error: 'blocked' }, 403);
      if (!signKey(env)) return json({ wt: '', kind: 'w', guard: false });
      let kind: Kind = authed ? 't' : 'w';
      const cm = classRoom(room);
      // A05-F17(스위치): 지난 날짜 교실 판은 선생님만 쓴다. 어제 판까지는 밤 수업이 넘어올 수 있어 허용
      if (kind === 'w' && env.TEACHER_GUARD === 'on' && cm && cm[2] !== lessonDay() && cm[2] !== lessonDay(Date.now() - 86400_000)) kind = 'r';
      return json({ wt: await sign(env, kind, room), kind, guard: guardOn(env) });
    }
    let m = /^\/admin\/(blocked|block|unblock)$/.exec(url.pathname);
    if (m) {
      if (!authed) return json({ error: 'teacher token required' }, 401);
      blockedCache = null;
      return env.ROOMS.get(env.ROOMS.idFromName('__admin')).fetch(new Request(`https://do/admin/${m[1]}`, req));
    }
    m = /^\/rooms\/([\w-]{4,64})\/(export|snaps|blobs\/[\w.-]{1,80})$/.exec(url.pathname);
    if (m) {
      if (!okRoom(m[1])) return json({ error: 'bad room' }, 400);
      if ((m[2] === 'export' || m[2] === 'snaps') && !authed) return json({ error: 'teacher token required' }, 401);
      if (m[2].startsWith('blobs/')) {
        if (await isBlocked(env, m[1])) return json({ error: 'blocked' }, 403);
        if (req.method === 'PUT' && guardOn(env)) {
          const k = await verify(env, url.searchParams.get('wt') || '', m[1]);
          if (k !== 'w' && k !== 't') return json({ error: 'write token required' }, 403);
        }
      }
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(new Request(`https://do/${m[2]}${url.search}`, req));
    }
    m = /^\/students\/([\w-]{1,40})\/(memory|next)\.json$/.exec(url.pathname);
    if (m) {
      if (!authed) return json({ error: 'teacher token required' }, 401);
      return env.ROOMS.get(env.ROOMS.idFromName('student-' + m[1])).fetch(new Request(`https://do/file/${m[2]}`, req));
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('kwd-board sync (y-websocket)\n', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    const room = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
    if (!okRoom(room)) return new Response('bad room', { status: 400 });
    if (await isBlocked(env, room)) return new Response('blocked', { status: 403 });
    // 쓰기 토큰: 맞으면 그 종류로, 없거나 틀리면 스위치가 켜졌을 때 거절(꺼졌으면 예전처럼 쓰기)
    const wt = url.searchParams.get('wt') || '';
    let kind: Kind | null = wt ? await verify(env, wt, room) : null;
    if (!kind) {
      if (guardOn(env)) return new Response('write token required', { status: 403 });
      kind = 'w';
    }
    const hd = new Headers(req.headers);
    hd.set('x-kwd-kind', kind);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(req, { headers: hd }));
  },
};

export class Room extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saveFails = 0; // A07-F12: 저장 실패 기록 (export 의 _server 에 보임)
  private lastSaveErr = '';

  // ---- 조각 저장 ----
  private async putChunks(prefix: string, data: Uint8Array) {
    const n = Math.ceil(data.byteLength / CHUNK) || 1;
    const old = (await this.ctx.storage.get<number>(prefix + ':n')) || 0;
    const entries: Record<string, ArrayBuffer | number> = { [prefix + ':n']: n };
    for (let i = 0; i < n; i++) entries[`${prefix}:${i}`] = data.slice(i * CHUNK, (i + 1) * CHUNK).buffer;
    await this.ctx.storage.put(entries);
    if (old > n) await this.ctx.storage.delete(Array.from({ length: old - n }, (_, k) => `${prefix}:${n + k}`));
  }
  private async getChunks(prefix: string): Promise<Uint8Array | null> {
    const n = await this.ctx.storage.get<number>(prefix + ':n');
    if (!n) return null;
    const keys = Array.from({ length: n }, (_, i) => `${prefix}:${i}`);
    const got = await this.ctx.storage.get<ArrayBuffer>(keys);
    const parts = keys.map((k) => new Uint8Array(got.get(k) || new ArrayBuffer(0)));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  private async ensureDoc(): Promise<{ doc: Y.Doc; awareness: awarenessProtocol.Awareness }> {
    if (this.doc && this.awareness) return { doc: this.doc, awareness: this.awareness };
    const doc = new Y.Doc();
    const saved = await this.getChunks('doc');
    if (saved) Y.applyUpdate(doc, saved);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc), origin as WebSocket | undefined);
      this.scheduleSave();
    });
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
      this.broadcast(encoding.toUint8Array(enc));
    });
    this.doc = doc;
    this.awareness = awareness;
    return { doc, awareness };
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveLogged();
    }, SAVE_DEBOUNCE_MS);
  }

  // 저장 실패를 삼키지 않는다: 기록하고 5초 뒤 다시 (A07-F12)
  private async saveLogged() {
    try {
      await this.save();
    } catch (e) {
      this.saveFails++;
      this.lastSaveErr = new Date().toISOString() + ' ' + String((e as Error)?.message || e).slice(0, 200);
      console.error('[kwd] room save failed', this.ctx.id.toString(), this.saveFails, e);
      this.dirty = true;
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = null;
          void this.saveLogged();
        }, 5000);
      }
    }
  }

  private async save() {
    if (!this.doc || !this.dirty) return;
    this.dirty = false;
    try {
      await this.snapshotOnce();
      await this.putChunks('doc', Y.encodeStateAsUpdate(this.doc));
      await this.ctx.storage.put('savedAt', Date.now());
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  // 하루 한 번 스냅샷 (A07-F09 ③): 마지막 저장이 지난 수업일이면, 오늘 처음 바뀌기 직전 내용(= 그날 끝 상태)을
  // snap-<그날 YYMMDD> 로 남긴다. 저장마다 savedAt 하나만 읽는다. 최근 7개만 둔다
  private async snapshotOnce() {
    const day = lessonDay(Date.now() + (Number(this.env.TEST_SHIFT_MS) || 0));
    const savedAt = (await this.ctx.storage.get<number>('savedAt')) || 0;
    if (!savedAt || lessonDay(savedAt) === day) return; // 새 판이거나 오늘 이미 저장함
    const snaps = (await this.ctx.storage.get<string[]>('snaps')) || [];
    const was = lessonDay(savedAt);
    if (snaps.includes(was)) return;
    const before = await this.getChunks('doc');
    if (!before || before.byteLength <= 2) return; // 빈 판은 남길 것이 없다
    await this.putChunks('snap-' + was, before);
    snaps.push(was);
    snaps.sort();
    while (snaps.length > 7) await this.deleteChunks('snap-' + snaps.shift()!);
    await this.ctx.storage.put('snaps', snaps);
  }
  private async deleteChunks(prefix: string) {
    const n = (await this.ctx.storage.get<number>(prefix + ':n')) || 0;
    await this.ctx.storage.delete([prefix + ':n', ...Array.from({ length: n }, (_, i) => `${prefix}:${i}`)]);
  }

  private broadcast(msg: Uint8Array, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* 닫힌 소켓 */
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') return this.openSocket((req.headers.get('x-kwd-kind') as Kind) || 'w');
    const path = url.pathname.replace(/^\/+/, '');
    const adm = /^admin\/(blocked|block|unblock)$/.exec(path);
    if (adm) {
      const codes = new Set((await this.ctx.storage.get<string[]>('blocked')) || []);
      if (adm[1] !== 'blocked') {
        if (req.method !== 'POST') return json({ error: 'POST' }, 405);
        const b = (await req.json().catch(() => ({}))) as { code?: string };
        const code = String(b.code || '').toLowerCase();
        if (!/^k[a-z0-9]{8}$/.test(code)) return json({ error: 'bad code' }, 400);
        if (adm[1] === 'block') codes.add(code);
        else codes.delete(code);
        await this.ctx.storage.put('blocked', Array.from(codes).sort());
      }
      return json({ codes: Array.from(codes).sort() });
    }
    if (path === 'snaps') return json({ snaps: (await this.ctx.storage.get<string[]>('snaps')) || [] });
    if (path === 'export') {
      const snap = url.searchParams.get('snap') || '';
      let doc: Y.Doc;
      if (snap) {
        if (!/^\d{6}$/.test(snap)) return json({ error: 'bad snap' }, 400);
        const data = await this.getChunks('snap-' + snap);
        if (!data) return json({ error: 'none' }, 404);
        doc = new Y.Doc();
        Y.applyUpdate(doc, data);
      } else doc = (await this.ensureDoc()).doc;
      const pages = doc.getArray<Y.Map<unknown>>('pages').toArray().map((m) => m.toJSON());
      const text: Record<string, string> = {};
      const ink: Record<string, unknown[]> = {};
      for (const p of pages as Array<{ id: string; kind: string }>) {
        if (p.kind === 'text') text[p.id] = doc.getXmlFragment('text:' + p.id).toString();
        ink[p.id] = doc.getArray('ink:' + p.id).toArray();
      }
      const _server = { savedAt: (await this.ctx.storage.get<number>('savedAt')) || 0, saveFails: this.saveFails, lastSaveErr: this.lastSaveErr, snaps: (await this.ctx.storage.get<string[]>('snaps')) || [], snap: snap || undefined };
      return json({ meta: doc.getMap('meta').toJSON(), pages, text, ink, materials: doc.getMap('materials').toJSON(), events: doc.getArray('events').toArray(), _server });
    }
    const blob = /^blobs\/([\w.-]+)$/.exec(path);
    if (blob) {
      const key = 'blob-' + blob[1];
      if (req.method === 'PUT') {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (buf.byteLength > 8 * 1024 * 1024) return json({ error: 'too large' }, 413);
        await this.putChunks(key, buf);
        return json({ ok: true, bytes: buf.byteLength });
      }
      const data = await this.getChunks(key);
      if (!data) return json({ error: 'none' }, 404);
      return new Response(data, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', ...CORS } });
    }
    const file = /^file\/(memory|next)$/.exec(path);
    if (file) {
      if (req.method === 'PUT') {
        const body = await req.text();
        try {
          JSON.parse(body);
        } catch {
          return json({ error: 'invalid json' }, 400);
        }
        await this.putChunks('file-' + file[1], new TextEncoder().encode(body));
        return json({ ok: true });
      }
      const data = await this.getChunks('file-' + file[1]);
      if (!data) return json({ error: 'none' }, 404);
      return new Response(data, { headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
    }
    return json({ error: 'not found' }, 404);
  }

  private async openSocket(kind: Kind): Promise<Response> {
    const { doc, awareness } = await this.ensureDoc();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ids: [] as number[], ro: kind === 'r' });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, doc);
    server.send(encoding.toUint8Array(enc));
    const states = awareness.getStates();
    if (states.size > 0) {
      const enc2 = encoding.createEncoder();
      encoding.writeVarUint(enc2, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc2, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys())));
      server.send(encoding.toUint8Array(enc2));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') return;
    const { doc, awareness } = await this.ensureDoc();
    try {
      const dec = decoding.createDecoder(new Uint8Array(message));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        // 읽기만 연결: 상태 묻기(step1)만 받고 문서를 바꾸는 step2·update 는 버린다
        const ro = !!(ws.deserializeAttachment() as { ro?: boolean } | null)?.ro;
        if (ro && decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        const before = new Set(awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
        const after = awareness.getStates();
        const att = (ws.deserializeAttachment() as { ids: number[]; ro?: boolean } | null) || { ids: [] };
        const ids = new Set(att.ids);
        for (const id of after.keys()) if (!before.has(id)) ids.add(id);
        for (const id of ids) if (!after.has(id)) ids.delete(id);
        ws.serializeAttachment({ ids: Array.from(ids), ro: !!att.ro });
      }
    } catch (e) {
      console.error('bad message', e);
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.dropConn(ws);
  }
  async webSocketError(ws: WebSocket) {
    await this.dropConn(ws);
  }
  private async dropConn(ws: WebSocket) {
    const { awareness } = await this.ensureDoc();
    const att = (ws.deserializeAttachment() as { ids: number[] } | null) || { ids: [] };
    if (att.ids.length) awarenessProtocol.removeAwarenessStates(awareness, att.ids, null);
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
    await this.saveLogged();
  }
}
