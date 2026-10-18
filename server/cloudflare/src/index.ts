// KWD 수업 판 동기화 서버 — Cloudflare Workers + Durable Objects (y-websocket 프로토콜)
// 방(판) 하나 = Durable Object 하나. 문서·자료 그림·학생 메모리는 DO 저장소(SQLite)에 조각으로 남는다.
// Workers Free: 하루 요청 10만(웹소켓 메시지 포함) — 수업 5~8회/일까지 무료.
//   WS  /<room>                          y-websocket
//   GET /time                            서버 시각 (판의 시각 보정)
//   GET /rooms/<room>/export             판 내보내기 (선생님 열쇠)
//   PUT·GET /rooms/<room>/blobs/<key>    자료 그림 (판 id = 권한)
//   PUT·GET /students/<번호>/<memory|next>.json  학생 메모리 (선생님 열쇠)
//   GET /turn?room=<room>                교실 통화 중계(TURN) 임시 열쇠 — Cloudflare Realtime TURN, 비밀은 워커에만
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
}

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 1500;
const CHUNK = 120 * 1024; // DO 저장 값 한도 안쪽으로 나눠 저장

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/time') return json({ t: Date.now() });
    if (url.pathname === '/turn') {
      // 판 id(방)를 아는 기기만 쓸 수 있게 방 이름 꼴만 확인. 열쇠는 1시간짜리
      const room = url.searchParams.get('room') || '';
      if (!/^[\w-]{4,64}$/.test(room)) return json({ error: 'room required' }, 400);
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
    let m = /^\/rooms\/([\w-]{4,64})\/(export|blobs\/[\w.-]{1,80})$/.exec(url.pathname);
    if (m) {
      if (m[2] === 'export' && !authed) return json({ error: 'teacher token required' }, 401);
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(new Request(`https://do/${m[2]}`, req));
    }
    m = /^\/students\/([\w-]{1,40})\/(memory|next)\.json$/.exec(url.pathname);
    if (m) {
      if (!authed) return json({ error: 'teacher token required' }, 401);
      return env.ROOMS.get(env.ROOMS.idFromName('student-' + m[1])).fetch(new Request(`https://do/file/${m[2]}`, req));
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('kwd-board sync (y-websocket)\n', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
    const room = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
    if (!/^[\w-]{4,64}$/.test(room)) return new Response('bad room', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
  },
};

export class Room extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

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
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save() {
    if (!this.doc || !this.dirty) return;
    this.dirty = false;
    await this.putChunks('doc', Y.encodeStateAsUpdate(this.doc));
    await this.ctx.storage.put('savedAt', Date.now());
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
    if (req.headers.get('Upgrade') === 'websocket') return this.openSocket();
    const path = url.pathname.replace(/^\/+/, '');
    if (path === 'export') {
      const { doc } = await this.ensureDoc();
      const pages = doc.getArray<Y.Map<unknown>>('pages').toArray().map((m) => m.toJSON());
      const text: Record<string, string> = {};
      const ink: Record<string, unknown[]> = {};
      for (const p of pages as Array<{ id: string; kind: string }>) {
        if (p.kind === 'text') text[p.id] = doc.getXmlFragment('text:' + p.id).toString();
        ink[p.id] = doc.getArray('ink:' + p.id).toArray();
      }
      return json({ meta: doc.getMap('meta').toJSON(), pages, text, ink, materials: doc.getMap('materials').toJSON(), events: doc.getArray('events').toArray() });
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

  private async openSocket(): Promise<Response> {
    const { doc, awareness } = await this.ensureDoc();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ids: [] as number[] });
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
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, doc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        const before = new Set(awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
        const after = awareness.getStates();
        const att = (ws.deserializeAttachment() as { ids: number[] } | null) || { ids: [] };
        const ids = new Set(att.ids);
        for (const id of after.keys()) if (!before.has(id)) ids.add(id);
        for (const id of ids) if (!after.has(id)) ids.delete(id);
        ws.serializeAttachment({ ids: Array.from(ids) });
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
    await this.save();
  }
}
