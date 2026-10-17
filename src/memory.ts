// 학생 메모리: 밤 루틴이 만든 students/<번호>/memory.json 을 선생님 기기만 읽는다 (기획안 v3 5절).
// Yjs 문서에는 절대 넣지 않는다 → 학생 기기로 가지 않는다.
import { getServerUrl, getToken, httpBase } from './store';

export interface MemVocab {
  kr: string;
  en?: string;
  first?: string;
  last?: string;
  count?: number;
  status?: 'learning' | 'known' | 'review' | 'old';
  age?: number;
  due?: string;
  lesson?: string;
}
export interface MemGrammar {
  pattern: string;
  name?: string;
  first?: string;
  last?: string;
  count?: number;
  examples?: string[];
}
export interface MemError {
  type: string;
  pattern?: string;
  wrong?: string;
  right?: string;
  count?: number;
  last?: string;
}
export interface MemHomework {
  given?: string;
  due?: string;
  status?: string;
  text: string;
}
export interface MemLesson {
  id: string;
  date: string;
  summary?: string;
  board?: string;
}
export interface StudentMemory {
  schema?: string;
  student: string;
  updatedAt?: string;
  profile?: { name?: string; level?: string; interests?: string[]; goals?: string[]; lessons?: number };
  vocab: MemVocab[];
  grammar: MemGrammar[];
  errors: MemError[];
  homework: MemHomework[];
  lessons: MemLesson[];
  next?: { focus?: string[]; review?: string[]; checkErrors?: string[]; homework?: string[] };
}

const DB = 'kwd-memory';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function cacheGet(student: string): Promise<StudentMemory | null> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction('m').objectStore('m').get(student);
      q.onsuccess = () => res((q.result as StudentMemory) || null);
      q.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
export async function cacheSet(m: StudentMemory) {
  try {
    const db = await idb();
    await new Promise<void>((res) => {
      const tx = db.transaction('m', 'readwrite');
      tx.objectStore('m').put(m, m.student);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore */
  }
}

export function normalize(raw: unknown, student: string): StudentMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<StudentMemory>;
  return {
    schema: r.schema || 'kwd-memory/v1',
    student: String(r.student || student),
    updatedAt: r.updatedAt,
    profile: r.profile || {},
    vocab: Array.isArray(r.vocab) ? r.vocab.filter((v) => v && v.kr) : [],
    grammar: Array.isArray(r.grammar) ? r.grammar.filter((g) => g && g.pattern) : [],
    errors: Array.isArray(r.errors) ? r.errors : [],
    homework: Array.isArray(r.homework) ? r.homework : [],
    lessons: Array.isArray(r.lessons) ? r.lessons : [],
    next: r.next || {},
  };
}

// 서버 → 없으면 기기 캐시
export async function loadMemory(student: string): Promise<{ mem: StudentMemory | null; from: 'server' | 'cache' | 'none' }> {
  if (!student) return { mem: null, from: 'none' };
  const srv = getServerUrl();
  const tk = getToken();
  if (srv && tk) {
    try {
      const r = await fetch(`${httpBase(srv)}/students/${encodeURIComponent(student)}/memory.json`, { headers: { authorization: 'Bearer ' + tk }, cache: 'no-store' });
      if (r.ok) {
        const m = normalize(await r.json(), student);
        if (m) {
          await cacheSet(m);
          return { mem: m, from: 'server' };
        }
      }
    } catch {
      /* 오프라인 */
    }
  }
  const c = await cacheGet(student);
  return { mem: c ? normalize(c, student) : null, from: c ? 'cache' : 'none' };
}

// 머리말: 학생 화면에도 보이는 부분만 (지난 오류는 넣지 않는다)
export function headerLines(m: StudentMemory): { title: string; lines: string[] } {
  const lines: string[] = [];
  const focus = m.next?.focus?.filter(Boolean) || [];
  const review = m.next?.review?.length ? m.next.review : m.vocab.filter((v) => v.status === 'review').map((v) => v.kr);
  const hw = m.next?.homework?.length ? m.next.homework : m.homework.filter((h) => h.status !== 'done').map((h) => h.text);
  if (focus.length) lines.push('오늘: ' + focus.join(' · '));
  if (review.length) lines.push('복습: ' + review.slice(0, 10).join(', '));
  if (hw.length) lines.push('과제 확인: ' + hw.slice(0, 3).join(' / '));
  return { title: '오늘 짚을 것', lines };
}

export function vocabNote(v: MemVocab): string {
  const parts = [v.en, v.first ? `${v.first} 처음` : '', v.count && v.count > 1 ? `${v.count}번 나옴` : '', v.status === 'review' ? '오늘 복습' : v.status === 'known' ? '아는 단어' : v.status === 'old' ? '오래전' : ''].filter(Boolean);
  return parts.join(' · ');
}

export const SAMPLE_MEMORY = (student: string): StudentMemory => ({
  schema: 'kwd-memory/v1',
  student,
  updatedAt: new Date().toISOString(),
  profile: { level: '초중급', interests: ['요리', '해리포터'], lessons: 34 },
  vocab: [
    { kr: '송편', en: 'half-moon rice cake', first: '9/24', last: '9/24', count: 1, status: 'review' },
    { kr: '성묘', en: 'visiting ancestral graves', first: '9/24', last: '9/24', count: 1, status: 'review' },
    { kr: '만족해요', en: 'to be satisfied', first: '9/12', last: '10/1', count: 3, status: 'learning' },
    { kr: '모여요', en: 'to gather', first: '9/24', last: '9/24', count: 1, status: 'review' },
    { kr: '반죽', en: 'dough', first: '9/12', last: '9/12', count: 1, status: 'learning' },
    { kr: '마셔요', en: 'drink', first: '6/2', last: '9/30', count: 6, status: 'known' },
  ],
  grammar: [
    { pattern: '-기를 바랍니다', name: 'wish (formal)', first: '9/24', count: 1, examples: ['가시기를 바랍니다'] },
    { pattern: '-(으)려고 해요', name: 'intention', first: '9/12', count: 2, examples: ['한국에 가려고 해요'] },
  ],
  errors: [
    { type: '조사', pattern: '에게/께', wrong: '원장님에게 말했어요', right: '원장님께 말씀드렸어요', count: 2, last: '9/24' },
    { type: '받침', pattern: 'ㅂ/ㅁ', wrong: '갑니다→감니다', right: '갑니다', count: 1, last: '9/12' },
  ],
  homework: [{ given: '9/24', due: '10/1', status: 'open', text: '피자 이야기 녹음' }],
  lessons: [
    { id: 'L34', date: '9/24', summary: '추석 · -기를 바랍니다 · 높임' },
    { id: 'L33', date: '9/12', summary: '피자 만들기 순서 · -(으)려고 해요' },
  ],
  next: { focus: ['-기를 바랍니다 복습', '에게/께'], review: ['송편', '성묘', '모여요', '만족해요'], homework: ['피자 이야기 녹음'] },
});
