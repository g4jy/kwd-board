// 수업 기록 묶음 lesson_<학생>_<일시>.kwd.zip — 밤 루틴이 화면 캡처 없이 읽는 형식 (기획안 v3 2.1)
import JSZip from 'jszip';
import type { Editor } from '@tiptap/core';
import type { BoardStore } from './store';
import { pageMarkdown } from './exportmd';
import { joinText } from './importer';

export const APP_VERSION = '0.3.0';

export interface RecordInput {
  store: BoardStore;
  editors: Map<string, Editor>;
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function bundleName(store: BoardStore): string {
  const st = String(store.meta.get('student') || 'x').replace(/[^\w가-힣-]/g, '');
  const t = Number(store.meta.get('startedAt') || store.meta.get('createdAt') || Date.now());
  return `lesson_${st}_${stamp(t)}.kwd.zip`;
}

export function boardMarkdown({ store, editors }: RecordInput): string {
  const out: string[] = [];
  const pages = store.pageList();
  pages.forEach((p, i) => {
    if (i > 0) out.push('---', '');
    if (p.kind === 'text') {
      const ed = editors.get(p.id);
      out.push(`<!-- page ${i + 1} ${p.id} -->`);
      out.push(ed ? pageMarkdown(ed) : xmlText(store, p.id));
    } else {
      const mat = p.mid ? store.materials.get(p.mid) : undefined;
      out.push(`<!-- page ${i + 1} ${p.id} -->`);
      out.push(`[자료 ${p.mid} p${p.n}] ${mat?.name || ''}`);
      const md = store.matdata.get(`${p.mid}/${p.n}`);
      if (md?.text?.length) out.push('', joinText(md.text));
    }
    // 이 페이지의 잉크를 글로
    const inkLines = inkSummary(store, p.id);
    if (inkLines.length) out.push('', ...inkLines.map((l) => `> ✎ ${l}`));
    out.push('');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function xmlText(store: BoardStore, pageId: string): string {
  return store
    .fragment(pageId)
    .toString()
    .replace(/<\/(paragraph|heading|listItem|tableRow)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function inkSummary(store: BoardStore, pageId: string): string[] {
  const alive = new Set(store.ink(pageId).toArray().map((s) => s.id));
  const lines: string[] = [];
  for (const e of store.events.toArray()) {
    if (e.kind !== 'ink' || e.page !== pageId || !e.id || !alive.has(e.id)) continue;
    lines.push(describeInk(e));
  }
  return lines;
}

const SHAPE_KO: Record<string, string> = { underline: '밑줄', circle: '동그라미', line: '선', scribble: '손글씨/낙서', free: '그림' };
export function colorKo(c: string): string {
  const m: Record<string, string> = { '#222222': '검정', '#d32f2f': '빨강', '#1565c0': '파랑', '#2e7d32': '초록', '#ffd400': '노랑 형광', '#ef6c00': '주황' };
  return m[(c || '').toLowerCase()] || c;
}
export function describeInk(e: { text?: string; data?: Record<string, unknown> }): string {
  const d = e.data || {};
  const shape = SHAPE_KO[String(d.shape || 'free')] || '그림';
  const col = colorKo(String(d.color || '')) + (d.hl && !String(colorKo(String(d.color))).includes('형광') ? ' 형광' : '');
  if (e.text) return `'${e.text}' ${shape} (${col})`;
  return `${shape} (${col}, 영역 ${(d.bbox as number[] | undefined)?.join(',') || ''})`;
}

export async function buildBundle(input: RecordInput): Promise<{ name: string; blob: Blob; files: Record<string, string> }> {
  const { store, editors } = input;
  store.flushText();
  const zip = new JSZip();
  const pages = store.pageList();
  const startedAt = Number(store.meta.get('startedAt') || 0);
  const endedAt = Number(store.meta.get('lastAt') || 0);
  const roles = new Set<string>();
  for (const e of store.events.toArray()) roles.add(e.role);
  const manifest = {
    schema: 'kwd-lesson-bundle/v1',
    app: APP_VERSION,
    board: store.id,
    student: store.meta.get('student') || '',
    createdAt: store.meta.get('createdAt') || null,
    startedAt: startedAt || null,
    endedAt: endedAt || null,
    startedAtIso: startedAt ? new Date(startedAt).toISOString() : null,
    endedAtIso: endedAt ? new Date(endedAt).toISOString() : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clock: { offsetMs: store.clockOffset, rttMs: store.clockRtt, basis: store.clockRtt >= 0 ? 'server' : 'device' },
    roles: Array.from(roles),
    pages: pages.map((p, i) => ({ no: i + 1, id: p.id, kind: p.kind, material: p.mid, materialPage: p.n })),
    materials: Array.from(store.materials.values()).map((m) => ({ id: m.id, name: m.name, type: m.type, pages: m.pages })),
    counts: { events: store.events.length, ink: pages.reduce((a, p) => a + store.ink(p.id).length, 0) },
    exportedAt: new Date().toISOString(),
  };
  const md = boardMarkdown(input);
  const boardJson = {
    pages: pages.map((p) => ({
      ...p,
      doc: p.kind === 'text' ? editors.get(p.id)?.getJSON() || null : null,
      ink: store.ink(p.id).toArray(),
    })),
    settings: store.settings.toJSON(),
  };
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(manifest, null, 1),
    'board.md': md,
    'events.ndjson': store.eventsNdjson(),
    'board.json': JSON.stringify(boardJson),
  };
  for (const [k, v] of Object.entries(files)) zip.file(k, v);
  for (const m of store.materials.values()) {
    const textPages: Array<{ n: number; text: string }> = [];
    for (let n = 1; n <= m.pages; n++) {
      const d = store.matdata.get(`${m.id}/${n}`);
      if (!d) continue;
      if (m.type === 'html' && d.html) {
        zip.file(`materials/${m.id}.html`, d.html);
        continue;
      }
      const t = joinText(d.text);
      textPages.push({ n, text: t });
      if (!t && d.img) {
        if (d.img.startsWith('data:')) zip.file(`materials/${m.id}/p${n}.jpg`, d.img.split(',')[1], { base64: true });
        else {
          try {
            const r = await fetch(store.resolveImg(d.img));
            if (r.ok) zip.file(`materials/${m.id}/p${n}.jpg`, await r.arrayBuffer());
          } catch {
            /* 서버에 못 닿으면 그림은 빠진다 (글자층 없음 표시만) */
          }
        }
      }
    }
    if (m.type === 'pdf') zip.file(`materials/${m.id}.text.json`, JSON.stringify({ id: m.id, name: m.name, pages: textPages }));
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { name: bundleName(store), blob, files };
}

// ---- Drive 작업중 폴더에 자동 저장 (Chrome·Edge, File System Access) ----
type DirHandle = { name: string; getFileHandle(n: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>; queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };

const DB = 'kwd-handles';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet<T>(k: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res) => {
    const q = db.transaction('h').objectStore('h').get(k);
    q.onsuccess = () => res(q.result as T);
    q.onerror = () => res(undefined);
  });
}
async function idbSet(k: string, v: unknown) {
  const db = await idb();
  return new Promise<void>((res) => {
    const tx = db.transaction('h', 'readwrite');
    tx.objectStore('h').put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

export const canPickFolder = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export async function pickFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) return null;
  const handle = await picker({ mode: 'readwrite', id: 'kwd-record' });
  await idbSet('record-dir', handle);
  return handle.name;
}

export async function folderName(): Promise<string | null> {
  try {
    const h = await idbGet<DirHandle>('record-dir');
    return h?.name || null;
  } catch {
    return null;
  }
}

export async function writeToFolder(name: string, blob: Blob, ask = false): Promise<boolean> {
  try {
    const h = await idbGet<DirHandle>('record-dir');
    if (!h) return false;
    const opts = { mode: 'readwrite' };
    let perm = h.queryPermission ? await h.queryPermission(opts) : 'granted';
    if (perm !== 'granted' && ask && h.requestPermission) perm = await h.requestPermission(opts);
    if (perm !== 'granted') return false;
    const fh = await h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch {
    return false;
  }
}
