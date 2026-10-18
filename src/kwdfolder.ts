// KWD 폴더 연결: 선생님 PC의 work 폴더(C:\KWD\work 또는 구글 드라이브 거울)를 한 번 고르면
// 오늘 수업(intake/<날짜>/brief_data.json)과 학생 폴더(Student_Lessons/<이름 (번호)>)를 판이 직접 읽는다.
// AI·서버 없이 브라우저 안에서만 읽고, 학생 기기로는 아무것도 보내지 않는다.
import { validPacket, indexEntries, type LessonPacket } from './packet';
import type { StudentMemory, MemVocab, MemGrammar, MemError, MemHomework, MemLesson } from './memory';

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
  values?: () => AsyncIterableIterator<FileSystemHandle>;
};

const DB = 'kwd-folder';
let testHandle: DirHandle | null = null; // 시험용 또는 이번 창에서만 쓰는 폴더(파일 목록으로 고른 것)

export const PICKER_BLOCKED = '이 창에서는 폴더·파일 고르기 창이 열리지 않아요 (Claude 앱 안 브라우저 등). 크롬이나 엣지에서 이 주소를 여세요. 또는 폴더를 이 화면에 끌어다 놓아도 돼요.';

// 파일 목록(<input webkitdirectory> 또는 끌어다 놓기)으로 만든 가짜 폴더 손잡이 — 이번 창에서만
class VFile {
  readonly kind = 'file';
  constructor(readonly name: string, private f: File) {}
  async getFile() {
    return this.f;
  }
}
class VDir {
  readonly kind = 'directory';
  dirs = new Map<string, VDir>();
  files = new Map<string, VFile>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(n: string) {
    const d = this.dirs.get(n);
    if (!d) throw new DOMException('not found', 'NotFoundError');
    return d;
  }
  async getFileHandle(n: string) {
    const f = this.files.get(n);
    if (!f) throw new DOMException('not found', 'NotFoundError');
    return f;
  }
  async *entries(): AsyncIterableIterator<[string, VDir | VFile]> {
    for (const [k, v] of this.dirs) yield [k, v];
    for (const [k, v] of this.files) yield [k, v];
  }
}
function vdirFromFiles(files: File[]): VDir | null {
  let root: VDir | null = null;
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    if (!root) root = new VDir(parts[0]);
    let d = root;
    for (const seg of parts.slice(1, -1)) {
      if (!d.dirs.has(seg)) d.dirs.set(seg, new VDir(seg));
      d = d.dirs.get(seg)!;
    }
    d.files.set(parts[parts.length - 1], new VFile(parts[parts.length - 1], f));
  }
  return root;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction('h').objectStore('h').get(key);
      q.onsuccess = () => res((q.result as T) || null);
      q.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
async function idbSet(key: string, v: unknown) {
  try {
    const db = await idb();
    await new Promise<void>((res) => {
      const tx = db.transaction('h', 'readwrite');
      if (v == null) tx.objectStore('h').delete(key);
      else tx.objectStore('h').put(v, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore */
  }
}

export const canUseFolder = (): boolean => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' || !!testHandle;

// 시험용: 실제 폴더 대신 쓸 손잡이 (OPFS 등)
export function setWorkHandleForTest(h: FileSystemDirectoryHandle | null) {
  testHandle = h as DirHandle | null;
  cache.students = null;
}

// ---- 체험: public/demo 의 가짜 work 폴더 (이 탭에서만, 진짜 연결은 그대로 둔다) ----
const DEMO_KEY = 'kwd.demo';
export function isDemo(): boolean {
  try {
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}
export function setDemo(on: boolean) {
  try {
    if (on) sessionStorage.setItem(DEMO_KEY, '1');
    else sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* ignore */
  }
  if (!on && testHandle && testHandle.name.endsWith('(체험)')) {
    testHandle = null;
    cache.students = null;
  }
}
export async function useDemoFolder(): Promise<boolean> {
  try {
    const base = import.meta.env.BASE_URL || './';
    const man = (await (await fetch(base + 'demo/manifest.json')).json()) as { files: Array<{ p: string; f: string }> };
    const today = ymd();
    const now = new Date();
    const hm = (add: number) => {
      const d = new Date(now.getTime() + add * 60000);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const root = new VDir('work (체험)');
    await Promise.all(
      man.files.map(async ({ p, f }, i) => {
        const r = await fetch(base + 'demo/work/' + f);
        if (!r.ok || (r.headers.get('content-type') || '').startsWith('text/html') !== /\.html?$/.test(p)) return;
        let blob: Blob = await r.blob();
        // @D-7@ = 오늘에서 7일 전 (체험은 언제 열어도 '지난 수업 뒤 6일')
        const dd = (n: number) => ymd(new Date(now.getTime() - n * 86400000));
        const tok = (t: string) => t.replace(/@D([-+])(\d+)@/g, (_m, sg, n) => dd(sg === '-' ? Number(n) : -Number(n)));
        const path = tok(p.replace('intake/TODAY/', `intake/${today}/`).replace('lesson_packets/TODAY/', `lesson_packets/${today}/`)).split('/');
        if (/\.(json|md|txt)$/.test(p)) blob = new Blob([tok((await blob.text()).replace(/TODAY/g, today).replace(/NOW\+(\d+)/g, (_m, n) => hm(Number(n))))], { type: blob.type || 'text/plain' });
        let d = root;
        for (const seg of path.slice(0, -1)) {
          if (!d.dirs.has(seg)) d.dirs.set(seg, new VDir(seg));
          d = d.dirs.get(seg)!;
        }
        const name = path[path.length - 1];
        d.files.set(name, new VFile(name, new File([blob], name, { type: blob.type, lastModified: now.getTime() - i * 3600000 })));
      }),
    );
    testHandle = root as unknown as DirHandle;
    cache.students = null;
    return true;
  } catch (e) {
    console.warn('demo', e);
    return false;
  }
}

export async function storedWork(): Promise<DirHandle | null> {
  if (testHandle) return testHandle;
  return idbGet<DirHandle>('work');
}

export type FolderState = 'none' | 'prompt' | 'granted' | 'denied';
export async function folderState(): Promise<{ state: FolderState; name: string }> {
  const h = await storedWork();
  if (!h) return { state: 'none', name: '' };
  if (testHandle) return { state: 'granted', name: h.name };
  try {
    const p = (await h.queryPermission?.({ mode: 'read' })) || 'granted';
    return { state: p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt', name: h.name };
  } catch {
    return { state: 'prompt', name: h.name };
  }
}

// 사용자 동작(클릭) 안에서 불러야 한다
export async function reopenFolder(): Promise<boolean> {
  const h = await storedWork();
  if (!h) return false;
  try {
    const p = (await h.requestPermission?.({ mode: 'read' })) || 'granted';
    return p === 'granted';
  } catch {
    return false;
  }
}

// 폴더 고르기: work 자체, 그 위(C:\KWD, 거울 폴더), Student_Lessons 를 골라도 알아서 work 를 찾는다
export async function pickWorkFolder(): Promise<{ ok: boolean; name?: string; message?: string }> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) return pickWorkFolderByList();
  let picked: DirHandle;
  const t0 = performance.now();
  try {
    picked = await picker.call(window, { id: 'kwd-work', mode: 'read' });
  } catch (e) {
    // 창이 뜨지도 않고 곧바로 취소되면: 고르기 창이 막힌 브라우저
    if ((e as Error).name === 'AbortError' && performance.now() - t0 < 600) return { ok: false, message: PICKER_BLOCKED };
    if ((e as Error).name === 'AbortError') return { ok: false };
    return { ok: false, message: '폴더를 열지 못했어요: ' + ((e as Error).message || e) };
  }
  return useWorkHandle(picked);
}

export async function useWorkHandle(picked: DirHandle, persist = true): Promise<{ ok: boolean; name?: string; message?: string }> {
  const work = await findWork(picked);
  if (!work) return { ok: false, message: `'${picked.name}' 안에서 Student_Lessons 폴더를 찾지 못했어요. KWD 의 work 폴더를 골라 주세요.` };
  if (persist && !(work instanceof VDir)) await idbSet('work', work);
  else testHandle = work;
  cache.students = null;
  return { ok: true, name: work.name };
}

// 고르기 창 대신: 파일 목록으로 폴더 받기 (이번 창에서만, 다시 열면 다시 골라야 함)
export function pickWorkFolderByList(): Promise<{ ok: boolean; name?: string; message?: string }> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    const t0 = performance.now();
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      const root = vdirFromFiles(files);
      if (!root) return res({ ok: false });
      res(await useWorkHandle(root as unknown as DirHandle, false));
    });
    input.addEventListener('cancel', () => res(performance.now() - t0 < 600 ? { ok: false, message: PICKER_BLOCKED } : { ok: false }));
    input.click();
  });
}

// 끌어다 놓은 폴더 (크롬은 진짜 손잡이를 준다 → 다음에도 기억)
export async function useDroppedItems(items: DataTransferItemList): Promise<{ ok: boolean; name?: string; message?: string }> {
  const list = Array.from(items).filter((i) => i.kind === 'file');
  for (const it of list) {
    const getH = (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
    if (getH) {
      const hnd = await getH.call(it);
      if (hnd && hnd.kind === 'directory') return useWorkHandle(hnd as DirHandle);
    }
  }
  return { ok: false, message: '폴더를 놓아 주세요 (KWD 의 work 폴더).' };
}

async function findWork(h: DirHandle): Promise<DirHandle | null> {
  if ((h as unknown as VDir) instanceof VDir && !(await sub(h, 'Student_Lessons')) && h.name !== 'work') {
    const w = await sub(h, 'work');
    if (w && (await sub(w, 'Student_Lessons'))) return w;
  }
  if (await sub(h, 'Student_Lessons')) return h;
  if (h.name === 'Student_Lessons') return null; // 위로는 못 올라간다
  const w = await sub(h, 'work');
  if (w && (await sub(w, 'Student_Lessons'))) return w;
  return null;
}

export async function forgetFolder() {
  await idbSet('work', null);
  cache.students = null;
}

// ---- 파일 도우미 ----
async function sub(h: DirHandle, name: string): Promise<DirHandle | null> {
  try {
    return (await h.getDirectoryHandle(name)) as DirHandle;
  } catch {
    return null;
  }
}
async function entries(h: DirHandle): Promise<Array<{ name: string; kind: 'file' | 'directory'; handle: FileSystemHandle }>> {
  const out: Array<{ name: string; kind: 'file' | 'directory'; handle: FileSystemHandle }> = [];
  const it = h.entries ? h.entries() : null;
  if (!it) return out;
  for await (const [name, handle] of it) out.push({ name, kind: handle.kind, handle });
  return out;
}
async function fileOf(h: DirHandle, name: string): Promise<File | null> {
  try {
    return await (await h.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}
async function textOf(h: DirHandle, name: string): Promise<string | null> {
  const f = await fileOf(h, name);
  return f ? f.text() : null;
}

// ---- 학생 목록 ----
export interface StudentEntry {
  folder: string;
  name: string;
  id: string; // Preply 번호 또는 pending-student-…
  key: string; // 판 주소용 (영문·숫자)
  lessons: number;
  lastDate: string; // YYYY-MM-DD
  trial: boolean;
}

const cache: { students: StudentEntry[] | null; at: number } = { students: null, at: 0 };

export function parseFolder(folder: string): { name: string; id: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(folder);
  if (m) return { name: m[1].trim(), id: m[2].trim() };
  return { name: folder.trim(), id: '' };
}

export function studentKey(folder: string): string {
  const { name, id } = parseFolder(folder);
  if (/^\d+$/.test(id)) return 's' + id;
  if (id.startsWith('pending-student-')) return 'p' + id.slice(16).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
  const ascii = (id || name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ascii.length >= 3) return 'n' + ascii.slice(0, 14);
  let hsh = 0;
  for (const ch of folder) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return 'h' + hsh.toString(36);
}

// 판 id: 학생 + 날짜 (같은 날 다시 누르면 같은 판)
export function demoRun(): number {
  try {
    return Number(localStorage.getItem('kwd.demoRun') || '1') || 1;
  } catch {
    return 1;
  }
}
export function nextDemoRun() {
  try {
    localStorage.setItem('kwd.demoRun', String(demoRun() + 1));
  } catch {
    /* ignore */
  }
}
export function boardIdFor(folder: string, d = new Date()): string {
  // 체험 판은 판 모양이 바뀔 때마다 새로 (예전 모양으로 깔린 체험 판을 다시 쓰지 않게)
  if (isDemo()) return `demo71${demoRun()}${studentKey(folder)}`;
  const code = classCodeOf(folder);
  return code ? classBoardId(code, d) : `${studentKey(folder)}d${lessonDay(d)}`;
}

// ---- 학생 고정 교실 링크 (v8.1) ----
// 학생마다 바뀌지 않는 무작위 교실 코드(k + 8자). 학생 링크 #/c/<코드> 는 매번 같고,
// 그날 판 = <코드>d<수업일>. 수업일은 서울 시간 새벽 4시에 바뀐다(밤 수업이 자정을 넘어도 같은 판).
const CODE_KEY = 'kwd.classCodes';
export function lessonDay(d = new Date()): string {
  const t = new Date(d.getTime() - 4 * 3600_000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const g = (k: string) => parts.find((x) => x.type === k)?.value || '';
  return `${g('year')}${g('month')}${g('day')}`;
}
export const classBoardId = (code: string, d = new Date()) => `${code}d${lessonDay(d)}`;
export const isClassCode = (c: string) => /^k[a-z0-9]{8}$/.test(c);
function codeMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CODE_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
export function classCodeOf(folder: string): string {
  return codeMap()[studentKey(folder)] || '';
}
// 이 PC에 없으면 학생 폴더의 kwd-board/classroom.json 에서, 그것도 없으면 새로 만든다
export async function ensureClassCode(folder: string): Promise<string> {
  if (isDemo()) return '';
  const key = studentKey(folder);
  let code = codeMap()[key] || '';
  if (!code) {
    try {
      const f = await readPackFile(folder, ['kwd-board', 'classroom.json']);
      const j = f ? (JSON.parse(await f.text()) as { code?: string }) : null;
      if (j?.code && isClassCode(j.code)) code = j.code;
    } catch {
      /* 없음 */
    }
  }
  const fresh = !code;
  if (!code) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    code = 'k' + Array.from(buf, (b) => a[b % a.length]).join('');
  }
  const m = codeMap();
  m[key] = code;
  try {
    localStorage.setItem(CODE_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
  if (fresh) void saveToStudentFolder(folder, 'kwd-board', 'classroom.json', JSON.stringify({ code, note: '학생 고정 교실 링크 코드. 지우면 학생 링크가 바뀌어요.' }, null, 2));
  return code;
}

const LESSON_RE = /^#(\d+)_.*?(\d{4}-\d{2}-\d{2})/;

export async function listStudents(force = false): Promise<StudentEntry[]> {
  if (cache.students && !force && Date.now() - cache.at < 5 * 60_000) return cache.students;
  const work = await storedWork();
  if (!work) return [];
  const sl = await sub(work, 'Student_Lessons');
  if (!sl) return [];
  const dirs = (await entries(sl)).filter((e) => e.kind === 'directory' && !e.name.startsWith('_') && !e.name.startsWith('.'));
  const out: StudentEntry[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      const files = await entries(d.handle as DirHandle);
      let lessons = 0;
      let last = '';
      let trialPrep = false;
      for (const f of files) {
        const m = LESSON_RE.exec(f.name);
        if (m && f.kind === 'file' && f.name.endsWith('.md')) {
          lessons = Math.max(lessons, Number(m[1]));
          if (m[2] > last) last = m[2];
        }
        if (/^Trial_Prep/i.test(f.name)) trialPrep = true;
      }
      const { name, id } = parseFolder(d.name);
      out.push({ folder: d.name, name, id, key: studentKey(d.name), lessons, lastDate: last, trial: trialPrep || (lessons === 0 && id.startsWith('pending')) });
    }),
  );
  out.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || a.name.localeCompare(b.name));
  cache.students = out;
  cache.at = Date.now();
  return out;
}

// ---- 오늘 수업 (아침 브리핑 데이터) ----
export interface BriefLesson {
  time: string;
  name: string;
  folder: string;
  calendar_title?: string;
  last_lesson?: number;
  last_date?: string;
  next_lesson?: number;
  level_hint?: string;
  rapport?: Array<{ date?: string; lesson?: number; text: string; kind?: string; follow_up?: string | null; sensitive?: boolean }>;
  promises?: { tutor?: Array<{ text: string; status?: string }>; homework?: Array<{ text?: string } | string>; homework_status?: string; submissions?: string; assignment_link?: string };
  next_focus?: string;
  warmup_recent?: Array<{ kr: string; en?: string }>;
  warmup_struggled?: Array<{ kr: string; en?: string } | string>;
  srs_due?: number;
  last_core?: { overview?: string; taught?: string[]; patterns?: string[]; corrections?: string[]; board_only?: string[] };
  prep?: { summary?: string[]; files?: Record<string, { name?: string; link?: string | null }>; plan?: Array<{ part: string; min: number; what?: string }> };
  links?: Record<string, string | null>;
}

export function ymd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 그날 폴더 중 가장 최근에 만든 brief_data.json (2026-10-15, 2026-10-15-2 …)
export async function briefFor(date = ymd()): Promise<{ date: string; generatedAt: string; lessons: BriefLesson[] } | null> {
  const work = await storedWork();
  if (!work) return null;
  const intake = await sub(work, 'intake');
  if (!intake) return null;
  const days = (await entries(intake)).filter((e) => e.kind === 'directory' && (e.name === date || e.name.startsWith(date + '-')));
  let best: { date: string; generatedAt: string; lessons: BriefLesson[] } | null = null;
  for (const d of days) {
    const t = await textOf(d.handle as DirHandle, 'brief_data.json');
    if (!t) continue;
    try {
      const j = JSON.parse(t) as { generated_at?: string; lessons?: BriefLesson[] };
      const g = j.generated_at || '';
      if (!best || g > best.generatedAt) best = { date, generatedAt: g, lessons: Array.isArray(j.lessons) ? j.lessons.filter((l) => l && l.folder) : [] };
    } catch {
      /* 깨진 파일 */
    }
  }
  if (best) best.lessons.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  return best;
}

// ---- 학생 꾸러미 ----
export interface PackFile {
  name: string;
  path: string[]; // 학생 폴더 기준
  kind: 'html' | 'pdf' | 'img' | 'md' | 'audio' | 'video' | 'text';
  mtime?: number;
  size: number;
}
export interface StudentPack {
  folder: string;
  name: string;
  id: string;
  profile?: string;
  roadmap?: string;
  status?: string;
  trialPrep?: { name: string; text: string };
  plan?: { name: string; text: string; n: number };
  homework?: { name: string; text: string };
  files: PackFile[]; // 판에 넣을 수 있는 자료 (최근 수업준비 우선)
  hwFiles: PackFile[]; // 학생이 낸 과제 (학생 폴더의 과제/ 폴더)
  lessons: Array<{ n: number; name: string; date: string }>;
  lessonData: string[]; // .lesson_data_N.json 이름들
  brief?: BriefLesson;
  db?: BoardData; // work/board_data/<폴더>.json (중앙 DB에서 뽑은 전체 단어·문형)
  hwHistory?: import('./homework').HwHistory; // 과제/hw_history.json (숙제 플랫폼이 내보낸 날마다 과제·피드백)
  packet?: LessonPacket; // work/lesson_packets/<오늘>/ (수업 직전 자동화 묶음, 이 창 메모리에만)
}

// night/kwd_board_export.py 가 만든 것
export interface DbWord {
  w: string;
  en: string;
  cat: string;
  pos: string;
  topik?: number | null;
  first?: number | null;
  last?: number | null;
  seen: number;
  status: string;
  chapter?: { code: string; target: string; level: string };
  rel: Record<string, string[]>;
  // 단계(10/18): kwd-app 노트와 맞춘 레벨 1~6 · 단계 이름(씨앗 1 … 나무) · 어디서 · 카드 상태
  note?: string | null;
  level?: number | null;
  step?: string;
  src?: 'lesson' | 'cards' | 'both';
  srs?: 'learning' | 'stable' | 'lapsing' | 'due';
  card_last?: string;
}
export interface DbPattern {
  p: string;
  en: string;
  cat: string;
  sub: string;
  meaning: string;
  ex: string;
  ex_en: string;
  status: string;
  first?: number | null;
  count: number;
  chapter?: { code: string; target: string; level: string };
  rel: Record<string, string[]>;
}
export interface BoardData {
  generated_at: string;
  sources?: { relations: string[]; missing: string[] };
  vocab: DbWord[];
  grammar: DbPattern[];
  stages?: Record<string, string>;
}
async function boardDataFor(folder: string): Promise<BoardData | undefined> {
  const work = await storedWork();
  if (!work) return undefined;
  const bd = await sub(work, 'board_data');
  if (!bd) return undefined;
  const t = await textOf(bd, folder + '.json');
  if (!t) return undefined;
  try {
    const j = JSON.parse(t) as BoardData;
    return Array.isArray(j.vocab) ? j : undefined;
  } catch {
    return undefined;
  }
}

// 오늘 수업 묶음: work/lesson_packets/<오늘>/_index.json → 학생 폴더로 찾기. 없으면 그 폴더의 묶음들을 훑어 student.folder_ref 로
export async function packetFor(folder: string, date = ymd()): Promise<LessonPacket | undefined> {
  const work = await storedWork();
  if (!work) return undefined;
  const lp = await sub(work, 'lesson_packets');
  const day = lp ? await sub(lp, date) : null;
  if (!day) return undefined;
  const read = async (name: string) => {
    const t = await textOf(day, name);
    if (!t) return undefined;
    try {
      const j = JSON.parse(t);
      return validPacket(j) ? j : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const idx = await textOf(day, '_index.json');
    if (idx) {
      const hit = indexEntries(JSON.parse(idx)).find((e) => e.folder === folder);
      if (hit) return await read(hit.file);
    }
  } catch {
    /* 깨진 목록 → 훑기 */
  }
  for (const e of await entries(day)) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name.startsWith('_')) continue;
    const p = await read(e.name);
    if (p?.student?.folder_ref === folder) return p;
  }
  return undefined;
}

async function studentDir(folder: string): Promise<DirHandle | null> {
  const work = await storedWork();
  if (!work) return null;
  const sl = await sub(work, 'Student_Lessons');
  return sl ? sub(sl, folder) : null;
}

export async function loadPack(folder: string, brief?: BriefLesson): Promise<StudentPack | null> {
  const dir = await studentDir(folder);
  if (!dir) return null;
  const { name, id } = parseFolder(folder);
  const pack: StudentPack = { folder, name, id, files: [], hwFiles: [], lessons: [], lessonData: [], brief };
  const top = await entries(dir);
  const fileKind = (n: string): PackFile['kind'] | null =>
    /\.html?$/i.test(n) ? 'html' : /\.pdf$/i.test(n) ? 'pdf' : /\.(png|jpe?g|gif|webp)$/i.test(n) ? 'img' : /\.(mp3|m4a|wav|ogg|aac)$/i.test(n) ? 'audio' : /\.(mp4|webm|mov|m4v)$/i.test(n) ? 'video' : /\.md$/i.test(n) && !/_수업안\.md$|_과제_초안\.md$/.test(n) ? 'md' : null;
  let planN = -1;
  const consider = async (handle: FileSystemHandle, n: string, path: string[], top = false) => {
    const f = await (handle as FileSystemFileHandle).getFile();
    const pm = /^#(\d+)_수업안\.md$/.exec(n);
    if (pm && Number(pm[1]) > planN) {
      planN = Number(pm[1]);
      pack.plan = { name: n, text: await f.text(), n: planN };
    }
    const hm = /^#(\d+)_과제_초안\.md$/.exec(n);
    if (hm && Number(hm[1]) >= planN) pack.homework = { name: n, text: await f.text() };
    const k = fileKind(n);
    if (k && !(top && k === 'md')) pack.files.push({ name: n, path, kind: k, size: f.size });
  };
  for (const e of top) {
    if (e.kind === 'file') {
      const n = e.name;
      if (/^Student_Profile/i.test(n) && n.endsWith('.md')) pack.profile = (await textOf(dir, n)) || undefined;
      else if (n === 'student_roadmap_current.md') pack.roadmap = (await textOf(dir, n)) || undefined;
      else if (n === 'Current_Learning_Status.md') pack.status = (await textOf(dir, n)) || undefined;
      else if (/^Trial_Prep.*\.md$/i.test(n)) {
        if (!pack.trialPrep || n > pack.trialPrep.name) pack.trialPrep = { name: n, text: (await textOf(dir, n)) || '' };
      } else if (/^\.lesson_data_\d+\.json$/.test(n)) pack.lessonData.push(n);
      else {
        const m = LESSON_RE.exec(n);
        if (m && n.endsWith('.md')) pack.lessons.push({ n: Number(m[1]), name: n, date: m[2] });
        else await consider(e.handle, n, [n], true);
      }
    } else if (e.name === '과제' || e.name === 'homework' || e.name === '숙제') {
      const kindOf = (n: string): PackFile['kind'] | null =>
        /\.(png|jpe?g|gif|webp|heic)$/i.test(n) ? 'img' : /\.(mp3|m4a|wav|ogg|webm|aac)$/i.test(n) ? 'audio' : /\.(mp4|mov|m4v)$/i.test(n) ? 'video' : /\.(md|txt)$/i.test(n) ? 'text' : /\.pdf$/i.test(n) ? 'pdf' : null;
      for (const f of await entries(e.handle as DirHandle)) {
        if (f.kind !== 'file') continue;
        if (f.name === 'hw_history.json') {
          try {
            const j = JSON.parse(await (await (f.handle as FileSystemFileHandle).getFile()).text());
            if (Array.isArray(j.days)) pack.hwHistory = { ...j, source: 'folder' };
          } catch {
            /* 깨진 파일은 무시 */
          }
          continue;
        }
        const k = kindOf(f.name);
        if (!k) continue;
        const file = await (f.handle as FileSystemFileHandle).getFile();
        pack.hwFiles.push({ name: f.name, path: [e.name, f.name], kind: k, size: file.size, mtime: file.lastModified });
      }
      pack.hwFiles.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    } else if (e.name === '수업준비' || e.name === '자료' || e.name === 'materials') {
      for (const f of await entries(e.handle as DirHandle)) if (f.kind === 'file') await consider(f.handle, f.name, [e.name, f.name]);
    }
  }
  pack.lessons.sort((a, b) => b.n - a.n || b.date.localeCompare(a.date));
  // 최근 수업 번호의 자료를 위로
  const numOf = (n: string) => Number((/(\d+)/.exec(n) || [])[1] || 0);
  pack.files.sort((a, b) => numOf(b.name) - numOf(a.name) || a.name.localeCompare(b.name));
  pack.lessonData.sort((a, b) => numOf(a) - numOf(b));
  pack.db = await boardDataFor(folder);
  pack.packet = await packetFor(folder);
  return pack;
}

// 학생 폴더에 파일 쓰기 (수업 필기 넣은 학습지 등). 쓰기 허락을 한 번 더 묻는다. 체험·파일 목록 폴더는 못 쓴다 → false
// 학생 폴더 안 파일에 이어 쓰기 (수업 녹화). 체험·파일 목록 폴더는 null
export async function openStudentWriter(folder: string, sub: string, name: string): Promise<FileSystemWritableFileStream | null> {
  const work = await storedWork();
  if (!work || (work as unknown as VDir) instanceof VDir || !folder) return null;
  try {
    const p = (await work.requestPermission?.({ mode: 'readwrite' })) || 'granted';
    if (p !== 'granted') return null;
    const sl = await work.getDirectoryHandle('Student_Lessons');
    const sd = await sl.getDirectoryHandle(folder);
    const dir = await sd.getDirectoryHandle(sub, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    return await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  } catch (e) {
    console.warn('writer', e);
    return null;
  }
}

export async function saveToStudentFolder(folder: string, sub: string, name: string, text: string): Promise<string | null> {
  const work = await storedWork();
  if (!work || (work as unknown as VDir) instanceof VDir) return null;
  try {
    const p = (await work.requestPermission?.({ mode: 'readwrite' })) || 'granted';
    if (p !== 'granted') return null;
    const sl = await work.getDirectoryHandle('Student_Lessons');
    const sd = await sl.getDirectoryHandle(folder);
    const dir = await sd.getDirectoryHandle(sub, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(text);
    await w.close();
    return `${folder}/${sub}/${name}`;
  } catch (e) {
    console.warn('save', e);
    return null;
  }
}

export async function readPackFile(folder: string, path: string[]): Promise<File | null> {
  let dir = await studentDir(folder);
  if (!dir) return null;
  for (const seg of path.slice(0, -1)) {
    dir = await sub(dir, seg);
    if (!dir) return null;
  }
  return fileOf(dir, path[path.length - 1]);
}

// ---- 지난 수업 기록(.lesson_data_N.json) → 단어·문형·오류 (밤 루틴 memory 와 같은 규칙) ----
const REVIEW_DAYS = [1, 3, 7, 14, 30];
const md = (s: string) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? `${Number(m[2])}/${Number(m[3])}` : '';
};

export async function buildMemory(pack: StudentPack): Promise<StudentMemory> {
  const dir = await studentDir(pack.folder);
  type V = MemVocab & { li?: number; lastIso?: string; used?: number; shaky?: boolean };
  const vocab = new Map<string, V>();
  const grammar = new Map<string, MemGrammar>();
  const errors = new Map<string, MemError>();
  const homework: MemHomework[] = [];
  const lessons: MemLesson[] = [];
  let li = -1;
  for (const name of pack.lessonData) {
    const t = dir ? await textOf(dir, name) : null;
    if (!t) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(t);
    } catch {
      continue;
    }
    li++;
    const meta = (data.meta && typeof data.meta === 'object' ? data.meta : {}) as Record<string, unknown>;
    const date = String(meta.date || '');
    const ov = data.lesson_overview as unknown;
    const summary = typeof ov === 'string' ? ov : ov && typeof ov === 'object' ? String((ov as Record<string, unknown>).summary_en || '') : '';
    lessons.push({ id: `L${meta.lesson_number ?? ''}`, date: md(date), summary: summary.slice(0, 160) });
    for (const v of (Array.isArray(data.vocabulary) ? data.vocabulary : []) as Array<Record<string, unknown>>) {
      if (!v || typeof v !== 'object') continue;
      const kr = String(v.kr || '').trim();
      if (!kr) continue;
      let e = vocab.get(kr);
      if (!e) {
        e = { kr, en: String(v.en || ''), first: md(date), count: 0 };
        vocab.set(kr, e);
      }
      e.count = (e.count || 0) + 1;
      e.last = md(date);
      e.lastIso = date;
      e.li = li;
      const st = String(v.student_status || '');
      if (['practiced', 'produced', 'used_correctly', 'mastered'].includes(st)) e.used = (e.used || 0) + (st === 'mastered' ? 3 : 1);
      if (st === 'regressed' || st === 'uncertain') e.shaky = true;
    }
    for (const g of (Array.isArray(data.grammar_patterns) ? data.grammar_patterns : []) as Array<Record<string, unknown>>) {
      if (!g || typeof g !== 'object') continue;
      const pk = String(g.pattern_kr || '').trim();
      if (!pk) continue;
      let e = grammar.get(pk);
      if (!e) {
        e = { pattern: pk, name: String(g.name_en || ''), first: md(date), count: 0, examples: [] };
        grammar.set(pk, e);
      }
      e.count = (e.count || 0) + 1;
      e.last = md(date);
      for (let ex of (Array.isArray(g.examples) ? g.examples : []) as unknown[]) {
        if (ex && typeof ex === 'object') ex = (ex as Record<string, unknown>).kr || (ex as Record<string, unknown>).example_kr || '';
        if (typeof ex === 'string' && ex && !e.examples!.includes(ex) && e.examples!.length < 3) e.examples!.push(ex);
      }
    }
    for (const c of (Array.isArray(data.corrections) ? data.corrections : []) as Array<Record<string, unknown>>) {
      if (!c || typeof c !== 'object') continue;
      const kind = String(c.correction_kind || c.error_type || c.type || '교정');
      const right = String(c.reviewer_normalized_correction_kr || c.correction_kr || c.corrected_kr || c.right || '').trim();
      const wrong = String(c.student_said_kr || c.learner_kr || c.wrong || '').trim();
      const pat = String(c.pattern || c.target || '');
      const key = `${kind}|${pat || right.slice(0, 30)}`;
      let e = errors.get(key);
      if (!e) {
        e = { type: kind, pattern: pat, count: 0 };
        errors.set(key, e);
      }
      e.count = (e.count || 0) + 1;
      e.wrong = wrong.slice(0, 80) || e.wrong;
      e.right = right.slice(0, 80) || e.right;
      e.last = md(date);
    }
    const ns = (data.next_steps && typeof data.next_steps === 'object' ? data.next_steps : {}) as Record<string, unknown>;
    for (const hw of (Array.isArray(ns.homework_items) ? ns.homework_items : []) as unknown[]) {
      const text = typeof hw === 'string' ? hw : hw && typeof hw === 'object' ? String((hw as Record<string, unknown>).task_en || (hw as Record<string, unknown>).task || '') : '';
      if (text && !homework.some((x) => x.text === text.slice(0, 160))) homework.push({ given: md(date), status: 'open', text: text.slice(0, 160) });
    }
  }
  const nLess = li + 1;
  const today = new Date();
  for (const e of vocab.values()) {
    const age = nLess - 1 - (e.li ?? 0);
    if ((e.used || 0) >= 3) e.status = 'known';
    else if (age >= 10) e.status = 'old';
    else {
      e.status = 'learning';
      const last = e.lastIso ? new Date(e.lastIso.slice(0, 10)) : null;
      if (last && !isNaN(+last)) {
        const gap = e.shaky ? 1 : REVIEW_DAYS[Math.min(REVIEW_DAYS.length - 1, (e.count || 1) - 1)];
        const due = new Date(+last + gap * 86400000);
        if (due <= today && (age < 3 || (e.shaky && age < 6))) e.status = 'review';
      }
    }
    e.age = age;
    delete e.li;
    delete e.lastIso;
    delete e.used;
    delete e.shaky;
  }
  const rank: Record<string, number> = { review: 0, learning: 1, known: 2, old: 3 };
  const vlist = Array.from(vocab.values())
    .sort((a, b) => (rank[a.status || 'learning'] ?? 4) - (rank[b.status || 'learning'] ?? 4) || (a.age ?? 99) - (b.age ?? 99) || (b.count || 0) - (a.count || 0))
    .slice(0, 500);
  const elist = Array.from(errors.values()).sort((a, b) => (b.count || 0) - (a.count || 0));
  return {
    schema: 'kwd-memory/v1',
    student: pack.id || pack.folder,
    profile: { name: pack.name, lessons: pack.lessons[0]?.n || lessons.length },
    vocab: vlist,
    grammar: Array.from(grammar.values()),
    errors: elist,
    homework: homework.slice(-5),
    lessons: lessons.slice(-12).reverse(),
    next: { review: pack.brief?.warmup_recent?.length ? pack.brief.warmup_recent.map((w) => w.kr).slice(0, 10) : vlist.filter((v) => v.status === 'review').map((v) => v.kr).slice(0, 10), homework: [] }, // 판 머리말엔 복습 단어만 (과제는 패널에서)
  };
}

// 판 id ↔ 학생 폴더 (이 기기에만)
const MAP_KEY = 'kwd.boardFolder';
export function folderForBoard(boardId: string): string {
  try {
    return (JSON.parse(localStorage.getItem(MAP_KEY) || '{}') as Record<string, string>)[boardId] || '';
  } catch {
    return '';
  }
}
export function rememberBoardFolder(boardId: string, folder: string) {
  try {
    const m = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') as Record<string, string>;
    m[boardId] = folder;
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}
