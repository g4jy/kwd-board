// 녹화 조각을 구글 드라이브 '작업중'으로 올린다 (T083d).
// 조각은 먼저 브라우저 저장소(recstore)에 남고, 여기서 앞에서부터 이어서 올린다. 인터넷이 끊기면 다음 차례에 이어서 올리고,
// 탭을 닫았다가 다시 열어도 이어서 올린다. 같은 조각을 두 번 보내도 안전하다(드라이브 쪽이 이름으로 건너뜀).
import { gasCall, gasReady, GasError } from './gas';
import { listSessions, patchSession, readChunks, getSession, putChunk, type RecSession } from './recstore';

const PART_MAX = 4 * 1024 * 1024; // 한 번에 보내는 최대 크기(올리기 전 원본 바이트)
const MIN_BATCH = 3 * 1024 * 1024; // 녹화 중에는 이만큼 쌓이거나
const MAX_WAIT = 45_000; // 이 시간이 지나면 보낸다
export type UploadState = { id: string; pending: number; uploaded: boolean; error: string };

let running = false;
let lastSend = 0;
const listeners = new Set<(s: UploadState) => void>();
export const onUploadState = (f: (s: UploadState) => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
const emit = (s: UploadState) => listeners.forEach((f) => f(s));

const isClosed = (s: RecSession) => !!s.ended && !(s.holdUntil && s.holdUntil > Date.now());
export const driveFolderOf = (s: RecSession) => `${s.stem}_${s.id.split('-')[1] || s.id}`.replace(/[\/:*?"<>|]/g, '_');

async function b64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 한 수업 세션을 한 번 훑는다. 올릴 게 없으면 false
async function pumpOne(s: RecSession, force: boolean): Promise<boolean> {
  const up = { ...(s.up || {}) };
  const names = Object.keys(s.tracks);
  let sent = false;
  for (;;) {
    // 이번 묶음: 트랙마다 앞에서부터 이어서, 합쳐서 PART_MAX 안
    const parts: Array<{ n: string; s: number; e: number; blob: Blob }> = [];
    let size = 0;
    for (const name of names) {
      const have = s.tracks[name].n;
      const from = up[name] || 0;
      if (from >= have) continue;
      let to = from;
      const blobs: Blob[] = [];
      let bytes = 0;
      // 조각은 1초 단위: 남은 크기 안에서 최대한 모은다
      const chunks = await readChunks(s.id, name, from, Math.min(have, from + 400));
      for (const c of chunks) {
        if (blobs.length && size + bytes + c.size > PART_MAX) break;
        blobs.push(c);
        bytes += c.size;
        to++;
      }
      if (!blobs.length) continue;
      parts.push({ n: name, s: from, e: to, blob: new Blob(blobs) });
      size += bytes;
      if (size >= PART_MAX) break;
    }
    if (!parts.length) break;
    // 녹화 중에는 조금 모아서 보낸다 (호출 횟수 줄이기)
    const ended = isClosed(s);
    if (!ended && !force && size < MIN_BATCH && Date.now() - lastSend < MAX_WAIT) break;
    const body = { id: driveFolderOf(s), parts: await Promise.all(parts.map(async (p) => ({ n: p.n, s: p.s, e: p.e, b: await b64(p.blob) }))) };
    await gasCall('rec_put', body, 120_000);
    lastSend = Date.now();
    for (const p of parts) up[p.n] = p.e;
    await patchSession(s.id, (cur) => ({ up: { ...(cur.up || {}), ...up }, upErr: '' }));
    s = { ...s, up };
    sent = true;
  }
  // 다 올렸으면 끝 표시
  const fresh = (await getSession(s.id)) || s;
  const left = Object.keys(fresh.tracks).some((n) => (fresh.up?.[n] || 0) < fresh.tracks[n].n);
  if (isClosed(fresh) && !left && !fresh.uploaded) {
    const tracks: Record<string, number> = {};
    for (const n of Object.keys(fresh.tracks)) tracks[n] = fresh.tracks[n].n;
    await gasCall('rec_done', { id: driveFolderOf(fresh), tracks, meta: fresh.meta || '' });
    await patchSession(fresh.id, { uploaded: true, upErr: '' });
    emit({ id: fresh.id, pending: 0, uploaded: true, error: '' });
    sent = true;
  }
  return sent;
}

// 올릴 것이 있는 세션을 모두 훑는다. 한 번에 하나만 돈다
export async function pumpUploads(force = false): Promise<void> {
  if (running || !gasReady() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  running = true;
  try {
    const all = (await listSessions()).filter((s) => !s.uploaded && Object.keys(s.tracks).length);
    for (const s of all) {
      try {
        await pumpOne(s, force);
        const cur = (await getSession(s.id)) || s;
        emit({ id: s.id, pending: Object.keys(cur.tracks).reduce((a, n) => a + Math.max(0, cur.tracks[n].n - (cur.up?.[n] || 0)), 0), uploaded: !!cur.uploaded, error: '' });
      } catch (e) {
        const code = e instanceof GasError ? e.code : 'fail';
        await patchSession(s.id, { upErr: code });
        emit({ id: s.id, pending: 1, uploaded: false, error: code });
        if (code === 'auth') break; // 열쇠가 틀리면 다른 세션도 같다
      }
    }
  } finally {
    running = false;
  }
}

let timer = 0;
export function startUploadLoop() {
  if (timer || typeof window === 'undefined') return;
  timer = window.setInterval(() => void pumpUploads(), 15_000);
  window.addEventListener('online', () => void pumpUploads(true));
  void pumpUploads(true); // 판을 열 때: 지난번에 못 올린 것 이어서
}

// 끝난 수업: 남은 것을 모두 올리고 기다린다 (최대 waitMs). 다 올랐으면 true
export async function finishUpload(sid: string, waitMs = 90_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    await pumpUploads(true);
    const s = await getSession(sid);
    if (!s) return false;
    if (s.uploaded) return true;
    if (Date.now() - t0 > waitMs || s.upErr === 'auth') return false;
    await new Promise((r) => window.setTimeout(r, 2000));
  }
}

// 수업이 끝난 뒤 판 기록(kwd.zip) 같은 파일 하나를 같은 세션에 얹는다 (2MB씩 나눠서). 얹은 뒤에야 '끝' 표시가 나간다
export async function attachFile(sid: string, name: string, blob: Blob) {
  const STEP = 2 * 1024 * 1024;
  let n = 0;
  for (let at = 0; at < blob.size || n === 0; at += STEP) await putChunk(sid, name, n++, blob.slice(at, at + STEP));
  await patchSession(sid, (s) => ({ tracks: { ...s.tracks, [name]: { mime: blob.type || 'application/zip', n } }, uploaded: false, holdUntil: 0 }));
}
export const holdOpen = (sid: string) => patchSession(sid, { holdUntil: Date.now() + 120_000 });
export const releaseHold = (sid: string) => patchSession(sid, { holdUntil: 0 });
