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
}

export async function beginSession(s: RecSession) {
  try {
    const db = await open();
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(s);
    await done(tx);
    const all = await listSessions();
    for (const old of all.slice(KEEP)) await dropSession(old.id);
  } catch (e) {
    console.warn('recstore', e);
  }
}

export async function putChunk(id: string, name: string, n: number, blob: Blob) {
  try {
    const db = await open();
    const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
    tx.objectStore('chunks').put(blob, `${id}|${name}|${String(n).padStart(7, '0')}`);
    const g = tx.objectStore('sessions').get(id);
    g.onsuccess = () => {
      const s = g.result as RecSession | undefined;
      if (s && s.tracks[name]) {
        s.tracks[name].n = Math.max(s.tracks[name].n, n + 1);
        tx.objectStore('sessions').put(s);
      }
    };
    await done(tx);
  } catch (e) {
    console.warn('recstore chunk', e);
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
