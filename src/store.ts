// 판 하나의 데이터: Yjs 문서 + 저장 + 동기화 + 사건 로그.
// v3: 판 = 페이지의 세로 묶음. 페이지마다 글(XmlFragment)과 잉크(Array)가 따로 있다.
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

export type Role = 'teacher' | 'student' | 'assist';

export const LOCAL = 'kwd-local'; // 우리 코드가 만드는 변경의 origin (되돌리기 추적용)

export const TEXT_W = 820;
export const TEXT_H = 1160;

export interface Stroke {
  id: string;
  role: Role;
  color: string;
  size: number; // 굵기(px, 페이지 좌표)
  hl: boolean; // 형광펜
  pts: number[]; // [x,y,p, ...] 페이지 좌표(px)
  t: number;
  k?: PenKind; // 펜 종류 (없으면 만년필)
  o?: number; // 형광펜 진하기 0..1
}

export type PenKind = 'fountain' | 'ball' | 'brush' | 'pencil';

// 페이지 위에 놓이는 것: 글상자·사진·웹 학습지 (페이지 좌표 px)
export interface PageObject {
  id: string;
  type: 'box' | 'img' | 'html' | 'audio' | 'video' | 'youtube';
  url?: string; // youtube: 원래 주소
  x: number;
  y: number;
  w: number;
  h: number; // 글상자는 내용에 따라 자람(최소 높이)
  src?: string; // img: dataURL 또는 'blob:키'
  mid?: string; // html: 자료 id (matdata `${mid}/1`)
  name?: string;
  ratio?: number; // img: 가로/세로 (크기 바꿀 때 유지)
  t: number;
}

export interface PageInfo {
  id: string;
  kind: 'text' | 'material';
  mid?: string; // 자료 id
  n?: number; // 자료 쪽 번호(1부터)
  w: number;
  h: number;
}

export interface MaterialInfo {
  id: string;
  name: string;
  type: 'pdf' | 'html';
  pages: number;
  hasText?: boolean[];
}

export interface MaterialPage {
  img?: string; // dataURL (jpeg)
  w: number;
  h: number;
  text?: Array<{ s: string; x: number; y: number; w: number; h: number }>; // 페이지 좌표
  html?: string; // html 자료
}

export interface InkTarget {
  shape: 'underline' | 'circle' | 'line' | 'scribble' | 'free';
  block?: string; // 블록 id (글 페이지)
  text?: string; // 덮은 글자
  ctx?: string; // 그 블록 전체 글(짧게)
}

export interface BoardEvent {
  t: number;
  role: Role;
  kind:
    | 'text'
    | 'ink'
    | 'erase'
    | 'page'
    | 'material'
    | 'interaction'
    | 'image'
    | 'blank'
    | 'result'
    | 'correction'
    | 'table'
    | 'timer'
    | 'setting'
    | 'presence'
    | 'object';
  page?: string;
  block?: string;
  text?: string;
  id?: string;
  src?: 'memory';
  data?: Record<string, unknown>;
}

export interface BoardIndexEntry {
  id: string;
  student: string;
  createdAt: number;
  lastAt: number;
}

const INDEX_KEY = 'kwd.boards';
const SERVER_KEY = 'kwd.server';
const TOKEN_KEY = 'kwd.token';

export function randomId(len = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

function lsGet(k: string): string {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
}
function lsSet(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function loadIndex(): BoardIndexEntry[] {
  try {
    return JSON.parse(lsGet(INDEX_KEY) || '[]');
  } catch {
    return [];
  }
}
export function saveIndex(list: BoardIndexEntry[]) {
  lsSet(INDEX_KEY, JSON.stringify(list));
}
export function upsertIndex(entry: BoardIndexEntry) {
  const list = loadIndex().filter((b) => b.id !== entry.id);
  list.unshift(entry);
  saveIndex(list);
}
export const getServerUrl = () => lsGet(SERVER_KEY);
export const setServerUrl = (u: string) => lsSet(SERVER_KEY, u);
export const getToken = () => lsGet(TOKEN_KEY);
export const setToken = (t: string) => lsSet(TOKEN_KEY, t);

export function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
}

export class BoardStore {
  readonly doc: Y.Doc;
  readonly pages: Y.Array<Y.Map<unknown>>;
  readonly events: Y.Array<BoardEvent>;
  readonly meta: Y.Map<unknown>;
  readonly settings: Y.Map<unknown>;
  readonly materials: Y.Map<MaterialInfo>;
  readonly matdata: Y.Map<MaterialPage>;
  readonly awareness: Awareness;
  readonly persistence: IndexeddbPersistence | null;
  provider: WebsocketProvider | null = null;
  readonly id: string;
  readonly role: Role;
  status: 'local' | 'connecting' | 'connected' | 'disconnected' = 'local';
  clockOffset = 0; // 서버 시각 − 이 기기 시각(ms)
  clockRtt = -1;
  dirtySince = 0; // 마지막 기록 묶음 이후 바뀐 시각
  private statusListeners = new Set<(s: BoardStore['status']) => void>();
  private pendingText = new Map<string, { text: string; page: string; kind: string; timer: number }>();
  beforeInkChange: (() => void) | null = null;

  constructor(id: string, role: Role, serverUrl: string) {
    this.id = id;
    this.role = role;
    this.doc = new Y.Doc({ gc: true });
    this.pages = this.doc.getArray('pages');
    this.events = this.doc.getArray<BoardEvent>('events');
    this.meta = this.doc.getMap('meta');
    this.settings = this.doc.getMap('settings');
    this.materials = this.doc.getMap('materials');
    this.matdata = this.doc.getMap('matdata');
    this.awareness = new Awareness(this.doc);
    let persistence: IndexeddbPersistence | null = null;
    try {
      if (typeof indexedDB !== 'undefined') persistence = new IndexeddbPersistence('kwd-board-' + id, this.doc);
    } catch {
      persistence = null;
    }
    this.persistence = persistence;
    this.doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin !== 'export') this.dirtySince = this.dirtySince || Date.now();
    });
    if (serverUrl) this.connect(serverUrl);
    else this.startLocalChannel();
  }

  // 서버가 없을 때: 같은 브라우저의 다른 탭·창(나란히 보기)과 바로 맞춘다
  private bc: BroadcastChannel | null = null;
  private startLocalChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('kwd-board-' + this.id);
    this.bc = bc;
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'bc') bc.postMessage({ t: 'u', u });
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'bc') return;
      bc.postMessage({ t: 'a', a: encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)) });
    });
    bc.onmessage = (e: MessageEvent) => {
      const m = e.data as { t: string; u?: Uint8Array; a?: Uint8Array; sv?: Uint8Array };
      if (m.t === 'u' && m.u) Y.applyUpdate(this.doc, m.u, 'bc');
      else if (m.t === 'a' && m.a) applyAwarenessUpdate(this.awareness, m.a, 'bc');
      else if (m.t === 'hello' && m.sv) {
        bc.postMessage({ t: 'u', u: Y.encodeStateAsUpdate(this.doc, m.sv) });
        bc.postMessage({ t: 'a', a: encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())) });
        bc.postMessage({ t: 'hello2', sv: Y.encodeStateVector(this.doc) });
      } else if (m.t === 'hello2' && m.sv) bc.postMessage({ t: 'u', u: Y.encodeStateAsUpdate(this.doc, m.sv) });
    };
    const hello = () => bc.postMessage({ t: 'hello', sv: Y.encodeStateVector(this.doc) });
    if (this.persistence) void this.persistence.whenSynced.then(hello);
    else hello();
    window.addEventListener('pagehide', () => removeAwarenessStates(this.awareness, [this.doc.clientID], 'leave'));
  }

  now() {
    return Date.now() + this.clockOffset;
  }

  whenLoaded(): Promise<void> {
    if (!this.persistence) return Promise.resolve();
    return Promise.race([this.persistence.whenSynced.then(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))]);
  }

  // ---- 페이지 ----
  fragment(pageId: string): Y.XmlFragment {
    return this.doc.getXmlFragment('text:' + pageId);
  }
  ink(pageId: string): Y.Array<Stroke> {
    return this.doc.getArray<Stroke>('ink:' + pageId);
  }
  objs(pageId: string): Y.Array<Y.Map<unknown>> {
    return this.doc.getArray<Y.Map<unknown>>('obj:' + pageId);
  }
  boxFragment(objId: string): Y.XmlFragment {
    return this.doc.getXmlFragment('box:' + objId);
  }
  objList(pageId: string): PageObject[] {
    return this.objs(pageId).toArray().map((m) => m.toJSON() as PageObject);
  }
  findObj(pageId: string, id: string): Y.Map<unknown> | null {
    return this.objs(pageId).toArray().find((m) => m.get('id') === id) || null;
  }
  addObj(pageId: string, o: Omit<PageObject, 'id' | 't'> & { id?: string }): PageObject {
    const obj: PageObject = { ...o, id: o.id || randomId(8), t: this.now() } as PageObject;
    const m = new Y.Map<unknown>();
    this.beforeInkChange?.();
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(obj)) if (v !== undefined) m.set(k, v);
      this.objs(pageId).push([m]);
    }, LOCAL);
    this.beforeInkChange?.();
    this.log({ kind: 'object', page: pageId, id: obj.id, data: { op: 'add', type: obj.type, x: Math.round(obj.x), y: Math.round(obj.y), w: Math.round(obj.w), h: Math.round(obj.h), name: obj.name } });
    return obj;
  }
  updateObj(pageId: string, id: string, patch: Partial<PageObject>, log = true) {
    const m = this.findObj(pageId, id);
    if (!m) return;
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) m.set(k, v);
    }, LOCAL);
    if (log) this.log({ kind: 'object', page: pageId, id, data: { op: 'move', ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])) } });
  }
  removeObj(pageId: string, id: string) {
    const arr = this.objs(pageId);
    const idx = arr.toArray().findIndex((m) => m.get('id') === id);
    if (idx < 0) return;
    this.beforeInkChange?.();
    this.doc.transact(() => arr.delete(idx, 1), LOCAL);
    this.beforeInkChange?.();
    this.log({ kind: 'object', page: pageId, id, data: { op: 'delete' } });
  }
  // 획 옮기기 (선택 도구): 한 번에 여러 획을 같은 거리만큼
  moveStrokes(pageId: string, ids: string[], dx: number, dy: number) {
    const arr = this.ink(pageId);
    const set = new Set(ids);
    this.beforeInkChange?.();
    this.doc.transact(() => {
      const list = arr.toArray();
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (!set.has(s.id)) continue;
        const pts = s.pts.map((v, j) => (j % 3 === 0 ? Math.round((v + dx) * 100) / 100 : j % 3 === 1 ? Math.round((v + dy) * 100) / 100 : v));
        arr.delete(i, 1);
        arr.insert(i, [{ ...s, pts }]);
      }
    }, LOCAL);
    this.beforeInkChange?.();
    this.log({ kind: 'ink', page: pageId, data: { op: 'move', ids, dx: Math.round(dx), dy: Math.round(dy) } });
  }
  // 부분 지우개: 획 하나를 남은 조각들로 바꾼다 (되돌리기 한 번에 묶이도록 따로 끊지 않음)
  replaceStroke(pageId: string, id: string, parts: Stroke[]) {
    const arr = this.ink(pageId);
    const idx = arr.toArray().findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.doc.transact(() => {
      arr.delete(idx, 1);
      if (parts.length) arr.insert(idx, parts);
    }, LOCAL);
    this.log({ kind: 'erase', page: pageId, id, data: { part: true, left: parts.length } });
  }
  removeStrokes(pageId: string, ids: string[]) {
    const arr = this.ink(pageId);
    const set = new Set(ids);
    this.beforeInkChange?.();
    this.doc.transact(() => {
      const list = arr.toArray();
      for (let i = list.length - 1; i >= 0; i--) if (set.has(list[i].id)) arr.delete(i, 1);
    }, LOCAL);
    this.beforeInkChange?.();
    for (const id of ids) this.log({ kind: 'erase', page: pageId, id });
  }

  pageList(): PageInfo[] {
    return this.pages.toArray().map((m) => m.toJSON() as PageInfo);
  }
  pageIndex(id: string): number {
    return this.pages.toArray().findIndex((m) => m.get('id') === id);
  }
  addPage(info: Omit<PageInfo, 'id'> & { id?: string }, at?: number): PageInfo {
    const page: PageInfo = { id: info.id || randomId(8), kind: info.kind, w: info.w, h: info.h };
    if (info.mid) page.mid = info.mid;
    if (info.n) page.n = info.n;
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(page)) m.set(k, v);
    const idx = at == null ? this.pages.length : Math.max(0, Math.min(this.pages.length, at));
    this.beforeInkChange?.();
    this.doc.transact(() => this.pages.insert(idx, [m]), LOCAL);
    return page;
  }
  removePage(id: string) {
    const idx = this.pageIndex(id);
    if (idx < 0 || this.pages.length <= 1) return;
    this.beforeInkChange?.();
    this.doc.transact(() => this.pages.delete(idx, 1), LOCAL);
    this.beforeInkChange?.();
    this.log({ kind: 'page', page: id, data: { op: 'delete' } });
  }

  // ---- 자료 그림: 서버가 있으면 문서 밖(서버)에 두고 문서에는 열쇠만 ----
  serverUrl = '';
  blobUrl(key: string): string {
    return `${httpBase(this.serverUrl)}/rooms/kwd-${this.id}/blobs/${encodeURIComponent(key)}`;
  }
  async putBlob(key: string, blob: Blob): Promise<boolean> {
    if (!this.serverUrl || this.status !== 'connected') return false;
    try {
      const r = await fetch(this.blobUrl(key), { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' } });
      return r.ok;
    } catch {
      return false;
    }
  }
  // 'blob:키' 또는 dataURL → 화면에 쓸 주소
  resolveImg(img: string | undefined): string {
    if (!img) return '';
    if (img.startsWith('blob:') && !img.startsWith('blob:http')) return this.blobUrl(img.slice(5));
    return img;
  }

  // ---- 상태 ----
  connect(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.bc?.close();
    this.bc = null;
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    const url = serverUrl.replace(/\/+$/, '');
    this.setStatus('connecting');
    const provider = new WebsocketProvider(url, 'kwd-' + this.id, this.doc, { awareness: this.awareness, maxBackoffTime: 5000 });
    provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        this.setStatus('connected');
        void this.measureClock(url);
      } else if (status === 'connecting') this.setStatus('connecting');
      else this.setStatus('disconnected');
    });
    provider.on('connection-error', () => this.setStatus('disconnected'));
    this.provider = provider;
  }

  async measureClock(wsUrl: string) {
    try {
      const t0 = Date.now();
      const r = await fetch(httpBase(wsUrl) + '/time', { cache: 'no-store' });
      const t1 = Date.now();
      const j = await r.json();
      const rtt = t1 - t0;
      if (this.clockRtt < 0 || rtt < this.clockRtt) {
        this.clockRtt = rtt;
        this.clockOffset = Math.round(j.t - (t0 + rtt / 2));
      }
    } catch {
      /* 서버에 /time 이 없으면 0 */
    }
  }

  disconnect() {
    this.provider?.destroy();
    this.provider = null;
    this.setStatus('local');
  }
  onStatus(fn: (s: BoardStore['status']) => void) {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }
  private setStatus(s: BoardStore['status']) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  getSetting<T>(key: string, fallback: T): T {
    const v = this.settings.get(key);
    return (v === undefined ? fallback : v) as T;
  }
  setSetting(key: string, value: unknown) {
    this.doc.transact(() => this.settings.set(key, value), 'settings');
    this.log({ kind: 'setting', data: { key, value } });
  }

  // ---- 사건 ----
  log(ev: Omit<BoardEvent, 't' | 'role'>) {
    const full: BoardEvent = { t: this.now(), role: this.role, ...ev };
    this.doc.transact(() => {
      this.events.push([full]);
      if (!this.meta.get('startedAt') && ev.kind !== 'setting' && ev.kind !== 'presence') this.meta.set('startedAt', full.t);
      this.meta.set('lastAt', full.t);
    }, 'events');
  }

  // 글: 블록당 3초 멈춤 또는 다른 블록으로 옮길 때 한 줄
  logText(page: string, block: string, kind: string, text: string, src?: 'memory') {
    for (const [b, p] of this.pendingText) {
      if (b !== block) {
        window.clearTimeout(p.timer);
        this.pendingText.delete(b);
        this.log({ kind: 'text', page: p.page, block: b, text: p.text, data: { type: p.kind } });
      }
    }
    if (src) {
      this.log({ kind: 'text', page, block, text, src, data: { type: kind } });
      return;
    }
    const prev = this.pendingText.get(block);
    if (prev) window.clearTimeout(prev.timer);
    const timer = window.setTimeout(() => {
      this.pendingText.delete(block);
      this.log({ kind: 'text', page, block, text, data: { type: kind } });
    }, 3000);
    this.pendingText.set(block, { text, page, kind, timer });
  }
  flushText() {
    for (const [b, p] of this.pendingText) {
      window.clearTimeout(p.timer);
      this.log({ kind: 'text', page: p.page, block: b, text: p.text, data: { type: p.kind } });
    }
    this.pendingText.clear();
  }

  // ---- 잉크 ----
  addStroke(pageId: string, stroke: Stroke, target?: InkTarget) {
    this.beforeInkChange?.();
    this.doc.transact(() => this.ink(pageId).push([stroke]), LOCAL);
    const xs = stroke.pts.filter((_, i) => i % 3 === 0);
    const ys = stroke.pts.filter((_, i) => i % 3 === 1);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
    this.log({ kind: 'ink', page: pageId, id: stroke.id, block: target?.block, text: target?.text, data: { color: stroke.color, hl: stroke.hl, size: stroke.size, kind: stroke.k, bbox, shape: target?.shape || 'free', ctx: target?.ctx } });
  }
  removeStroke(pageId: string, id: string) {
    const arr = this.ink(pageId).toArray();
    const idx = arr.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.beforeInkChange?.();
    this.doc.transact(() => this.ink(pageId).delete(idx, 1), LOCAL);
    this.log({ kind: 'erase', page: pageId, id });
  }
  clearInk(pageId: string) {
    const arr = this.ink(pageId);
    if (!arr.length) return;
    this.beforeInkChange?.();
    this.doc.transact(() => arr.delete(0, arr.length), LOCAL);
    this.log({ kind: 'erase', page: pageId, data: { all: true } });
  }

  eventsNdjson(): string {
    return this.events
      .toArray()
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  }

  destroy() {
    this.flushText();
    this.provider?.destroy();
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'leave');
    this.bc?.close();
    this.persistence?.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
