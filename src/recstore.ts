// 녹화 조각 보관 (T083b): 폴더에 못 쓰는 수업은 조각을 브라우저 저장소(IndexedDB)에도 1초마다 남긴다.
// 탭이 닫히거나 내려받기가 막혀도 '지난 녹화 다시 받기'로 되살린다. 복사본일 뿐이다 (원본·학생 데이터 아님).
const DB = 'kwd-rec';
const KEEP = 3; // 가장 최근 수업 3개만 (나머지 복사본은 정리)

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => {
      q.result.createObjectStore('chunks');
      q.result.createObjectStore('sessions', { keyPath: 'id' });
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = tx.onabort = () => rej(tx.error))));

export interface RecSession {
  id: string;
  tag: string; // 파일 이름 앞에 붙는 학생 번호
  stem: string;
  startedAt: number;
  tracks: Record<string, { mime: string; n: number }>;
  ended?: boolean;
  up?: Record<string, number>; // 드라이브에 올린 조각 수(트랙별, 앞에서부터 이어서)
  uploaded?: boolean; // 끝까지 다 올림 (_done 표시까지)
  meta?: string; // 끝에 저장한 _rec.json 이름
  upErr?: string; // 마지막 올리기 실패 이유
  holdUntil?: number; // 판 기록(zip)을 얹는 동안 '끝' 표시를 미룬다
  lastAt?: number; // 마지막 조각을 받은 시각 (탭이 닫혀 끝 표시가 없는 수업을 가려낸다)
  localOk?: boolean; // 이 기기에서 폴더 저장·내려받기를 마침 (드라이브에 안 올리는 수업)
  orphan?: boolean; // 탭이 닫혀 수업 끝 처리가 없었다 → 다시 열 때 _rec.json 을 만들어 닫음 (T136x)
}

// 오래된 복사본 정리 대상 (T136x A07-F03): 최근 KEEP 개 밖에서, 드라이브에 다 올렸거나 이 기기에서 저장을 마친 것만.
// 올리지도 저장하지도 못한 녹화는 날짜와 상관없이 지우지 않는다 (예전: 14일 지나면 지움). 직접 지우기는 '지난 녹화' 메뉴
export function prunable(all: RecSession[]): string[] {
  return [...all]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(KEEP)
    .filter((s) => s.uploaded || s.localOk)
    .map((s) => s.id);
}

export async function beginSession(s: RecSession) {
  try {
    const db = await open();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(s);
    await done(tx);
    // 오래된 복사본 정리: 드라이브에 다 올라간 것만 (아직 못 올린 녹화는 14일까지 지킨다)
    for (const id of prunable(await listSessions())) await dropSession(id);
  } catch (e) {
    console.warn('recstore', e);
  }
}

// 조각 하나 저장. 실패하면 false (저장소 가득 참 등) — 부르는 쪽이 화면에 알린다
export async function putChunk(id: string, name: string, n: number, blob: Blob): Promise<boolean> {
  try {
    const db = await open();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    tx.objectStore('chunks').put(blob, `${id}|${name}|${String(n).padStart(7, '0')}`);
    const g = tx.objectStore('sessions').get(id);
    g.onsuccess = () => {
      const s = g.result as RecSession | undefined;
      if (s && s.tracks[name]) {
        s.tracks[name].n = Math.max(s.tracks[name].n, n + 1);
        s.lastAt = Date.now();
        tx.objectStore('sessions').put(s);
      }
    };
    await done(tx);
    return true;
  } catch (e) {
    console.warn('recstore chunk', e);
    return false;
  }
}

export async function markEnded(id: string) {
  try {
    const db = await open();
    const tx = db.transaction('sessions', 'readwrite');
    const g = tx.objectStore('sessions').get(id);
    g.onsuccess = () => g.result && tx.objectStore('sessions').put({ ...g.result, ended: true });
    await done(tx);
  } catch (e) {
    console.warn('recstore end', e);
  }
}

export async function listSessions(): Promise<RecSession[]> {
  try {
    const db = await open();
    const tx = db.transaction('sessions');
    const q = tx.objectStore('sessions').getAll();
    await done(tx);
    return (q.result as RecSession[]).sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

export async function loadSession(id: string): Promise<Array<{ name: string; blob: Blob }>> {
  const db = await open();
  const out: Array<{ name: string; blob: Blob }> = [];
  const tx = db.transaction(['chunks', 'sessions']);
  const sq = tx.objectStore('sessions').get(id);
  const rq = tx.objectStore('chunks').getAll(IDBKeyRange.bound(`${id}|`, `${id}|￿`));
  const kq = tx.objectStore('chunks').getAllKeys(IDBKeyRange.bound(`${id}|`, `${id}|￿`));
  await done(tx);
  const s = sq.result as RecSession | undefined;
  if (!s) return out;
  const by = new Map<string, Blob[]>();
  (kq.result as string[]).forEach((k, i) => {
    const name = k.split('|')[1];
    (by.get(name) || by.set(name, []).get(name)!).push((rq.result as Blob[])[i]);
  });
  for (const [name, parts] of by) out.push({ name, blob: new Blob(parts, { type: name.endsWith('.json') ? 'application/json' : s.tracks[name]?.mime || 'video/webm' }) });
  return out;
}

export async function dropSession(id: string) {
  try {
    const db = await open();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    tx.objectStore('chunks').delete(IDBKeyRange.bound(`${id}|`, `${id}|￿`));
    tx.objectStore('sessions').delete(id);
    await done(tx);
  } catch (e) {
    console.warn('recstore drop', e);
  }
}

export async function getSession(id: string): Promise<RecSession | null> {
  try {
    const db = await open();
    const tx = db.transaction('sessions');
    const q = tx.objectStore('sessions').get(id);
    await done(tx);
    return (q.result as RecSession) || null;
  } catch {
    return null;
  }
}

// 일부 칸만 고친다 (읽고 쓰기를 한 번에, 다른 칸은 그대로)
export async function patchSession(id: string, patch: Partial<RecSession> | ((s: RecSession) => Partial<RecSession>)) {
  try {
    const db = await open();
    const tx = db.transaction('sessions', 'readwrite');
    const g = tx.objectStore('sessions').get(id);
    g.onsuccess = () => {
      const s = g.result as RecSession | undefined;
      if (s) tx.objectStore('sessions').put({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) });
    };
    await done(tx);
  } catch (e) {
    console.warn('recstore patch', e);
  }
}

const pad = (n: number) => String(n).padStart(7, '0');
// 한 트랙의 조각 [from, to) 를 순서대로
export async function readChunks(id: string, name: string, from: number, to: number): Promise<Blob[]> {
  if (to <= from) return [];
  const db = await open();
  const tx = db.transaction('chunks');
  const q = tx.objectStore('chunks').getAll(IDBKeyRange.bound(`${id}|${name}|${pad(from)}`, `${id}|${name}|${pad(to - 1)}`));
  await done(tx);
  return q.result as Blob[];
}

// 지금 이 탭에서 녹화 중인 수업 (탭이 닫힌 수업과 구별)
export const liveSessions = new Set<string>();
const orphanMs = () => {
  try {
    return Number(localStorage.getItem('kwd.test.orphanMs')) || 10 * 60_000; // 시험만 짧게
  } catch {
    return 10 * 60_000;
  }
};
// 탭이 닫혀 '끝' 처리가 없던 수업 (T136x A07-F03): 10분 넘게 조각이 없으면 있는 조각으로 _rec.json 을 만들어 끝 표시.
// 그래야 드라이브 올리기가 끝 표시(_done)까지 가고, 묶음에 _rec.json 이 항상 들어간다. 닫은 개수
export async function closeOrphans(now = Date.now()): Promise<number> {
  let n = 0;
  for (const s of await listSessions()) {
    if (s.ended || liveSessions.has(s.id) || now - (s.lastAt || s.startedAt) < orphanMs()) continue;
    const meta = `${s.stem}_rec.json`;
    if (!s.tracks[meta]) {
      const bytes: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.tracks)) bytes[k] = v.n; // 조각 수(1초 단위)
      const text = JSON.stringify({ schema: 'kwd-lesson-rec/v2', orphan: true, note: '탭이 닫혀 수업 끝 처리가 없었음 — 다음에 판을 열 때 만든 기록', started_at: s.startedAt, started_at_iso: new Date(s.startedAt).toISOString(), last_chunk_at_iso: s.lastAt ? new Date(s.lastAt).toISOString() : null, duration_s: s.lastAt ? Math.max(0, Math.round((s.lastAt - s.startedAt) / 1000)) : null, chunks: bytes, crop: 'unknown', faces: { student: null, teacher: null } }, null, 1);
      if (!(await putChunk(s.id, meta, 0, new Blob([text], { type: 'application/json' })))) continue;
      await patchSession(s.id, (c) => ({ tracks: { ...c.tracks, [meta]: { mime: 'application/json', n: 1 } }, meta, orphan: true }));
    }
    await markEnded(s.id);
    n++;
  }
  return n;
}
