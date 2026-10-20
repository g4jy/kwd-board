// KWD 숙제(Apps Script 웹 앱)에서 학생이 낸 과제 가져오기 — 선생님 기기에서만.
// 주소와 선생님 키는 이 기기(localStorage)에만 저장한다. 채팅·판 문서에는 넣지 않는다.
const KEY = 'kwd.hw';

export interface HwConfig {
  url: string;
  key: string;
}
export function hwConfig(): HwConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || 'null') as HwConfig | null;
    return c && c.url && c.key ? c : null;
  } catch {
    return null;
  }
}
export function setHwConfig(c: HwConfig | null) {
  try {
    if (c && c.url && c.key) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const c = hwConfig();
  if (!c) throw new Error('숙제 연결이 없어요');
  const r = await fetch(c.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, tkey: c.key, ...payload }) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = (await r.json()) as { ok: boolean; data?: T; error?: string };
  if (!j.ok) throw new Error(j.error || '숙제 서버 오류');
  return j.data as T;
}

export interface HwStep {
  step_id: string;
  kind: string;
  label_ko?: string;
  q?: string;
  sub?: { submission_id: string; grade_status: string; answer?: Record<string, unknown>; media_file_id?: string | null; media2_file_id?: string | null; media_purged?: boolean; submitted_at?: string } | null;
}
export interface HwGroup {
  key: string;
  task_id: string;
  student_id: string;
  student_name?: string;
  oldest?: string;
  task?: { title_ko?: string; type?: string; prompt_ko?: string; prompt_en?: string };
  steps: HwStep[];
}

// 학생 이름(또는 Preply 번호)으로 숙제 학생 찾기 → 검토 대기 과제
export async function homeworkFor(name: string, preply: string): Promise<{ student?: { student_id: string; name: string }; groups: HwGroup[] }> {
  const board = await call<{ students: Array<{ student_id: string; name: string; preply_id?: string }> }>('teacher.board');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const n = norm(name);
  const st =
    board.students.find((s) => preply && (s.preply_id === preply || s.student_id === preply)) ||
    board.students.find((s) => norm(s.name) === n) ||
    board.students.find((s) => n && (norm(s.name).startsWith(n) || n.startsWith(norm(s.name))));
  if (!st) return { groups: [] };
  const q = await call<{ queue: HwGroup[] }>('teacher.queue');
  return { student: st, groups: (q.queue || []).filter((g) => g.student_id === st.student_id) };
}

export async function hwMedia(fileId: string): Promise<{ mime: string; dataUrl: string }> {
  const m = await call<{ mime: string; b64: string }>('media.get', { file_id: fileId });
  return { mime: m.mime, dataUrl: `data:${m.mime};base64,${m.b64}` };
}

// 답을 한 줄 글로
export function answerText(a: Record<string, unknown> | undefined): string {
  if (!a) return '';
  for (const k of ['text', 'value', 'answer', 'typed', 'transcript', 'ko']) if (typeof a[k] === 'string' && a[k]) return String(a[k]);
  if (Array.isArray(a.order)) return (a.order as unknown[]).join(' ');
  return '';
}

// ---- 과제 기록 (판의 '과제' 탭이 쓰는 한 가지 모양) ----
// 출처: ① 학생 폴더의 과제/hw_history.json (숙제 플랫폼이 내보낸 것 · 체험) ② KWD 숙제 웹 앱(teacher.history → 없으면 teacher.student + teacher.day)
export interface HwMedia {
  kind: 'img' | 'audio';
  src?: string; // 폴더: 과제/ 안의 파일 이름
  fileId?: string; // 숙제 앱: media.get 으로 받는 id
  name?: string;
}
export interface HwItem {
  label: string; // 단계 이름·질문
  q?: string;
  kind?: string; // write · hand · speak · choose …
  text?: string; // 학생 답 (글)
  media?: HwMedia[];
  ai?: string; // AI 초안 피드백
  teacher?: string; // 선생님 피드백
  model?: string; // 모범 답
  status?: string; // ok · fix · wait (확인 기다림) · skip
  score?: number; // 0~1
  at?: string;
}
export interface HwTask {
  title: string;
  type?: string;
  items: HwItem[];
}
export interface HwDay {
  date: string; // YYYY-MM-DD
  status: string; // done · late · partial · skipped · none · rest
  minutes?: number;
  note?: string;
  tasks: HwTask[];
}
export interface HwHistory {
  student?: string;
  lastLesson?: string; // YYYY-MM-DD
  days: HwDay[]; // 최근 것이 먼저
  source: 'folder' | 'app';
}

// ---- 검증 (T044): 수업 시작에 과제 결과를 하나씩 확인·고친 기록. 이름 없이 날짜·문항만. 자동화가 피드백 몫으로 읽는다 ----
export interface VerifyRec {
  schema: 'kwd-verify/v1';
  id: string; // 문항 구분(날짜|과제|문항|제출 시각)
  student?: string; // 번호(이름 아님)
  date: string; // 과제 날짜 YYYY-MM-DD
  task: string;
  label: string;
  kind?: string;
  student_text?: string; // 학생 답 (200자까지)
  ai?: string;
  verdict: 'ok' | 'fix' | 'redo'; // 맞음 · 고침 · 다시 해 와야 함
  correction?: string; // 선생님이 고친 답
  note?: string;
  at: string; // ISO
}

const ymd = (t: string | number | Date) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function historyFromApp(name: string, preply: string): Promise<HwHistory | null> {
  const board = await call<{ students: Array<{ student_id: string; name: string; preply_id?: string }> }>('teacher.board');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const n = norm(name);
  const st = board.students.find((s) => preply && (s.preply_id === preply || s.student_id === preply)) || board.students.find((s) => norm(s.name) === n) || board.students.find((s) => n && (norm(s.name).startsWith(n) || n.startsWith(norm(s.name))));
  if (!st) return null;
  // 숙제 앱에 기록 한 번에 주는 것이 있으면 그것을
  try {
    const h = await call<HwHistory>('teacher.history', { student_id: st.student_id });
    if (h && Array.isArray(h.days)) return { ...h, source: 'app' };
  } catch {
    /* 아직 없는 기능 */
  }
  type Step = { label_ko?: string; q?: string; kind?: string; sub?: { answer?: Record<string, unknown>; media_file_id?: string | null; media2_file_id?: string | null; grade_status?: string; score?: number; submitted_at?: string; feedback?: Array<Record<string, unknown>>; auto?: Record<string, unknown> | null; model?: string } | null };
  const info = await call<{ analytics?: { days?: Array<{ date: string; status: string; dayset_id?: string }>; progress?: { since_lesson?: { lesson_at?: string } } } }>('teacher.student', { student_id: st.student_id });
  const lastLesson = info.analytics?.progress?.since_lesson?.lesson_at;
  const days: HwDay[] = [];
  for (const d of (info.analytics?.days || []).slice(0, 21)) {
    const day: HwDay = { date: d.date, status: d.status, tasks: [] };
    if (d.dayset_id) {
      try {
        const v = await call<{ day: { tasks: Array<{ title_ko?: string; type?: string; steps?: Step[] }> } }>('teacher.day', { student_id: st.student_id, dayset_id: d.dayset_id });
        day.tasks = (v.day.tasks || []).map((t) => ({
          title: t.title_ko || t.type || '과제',
          type: t.type,
          items: (t.steps || []).filter((s) => s.sub).map((s) => {
            const sub = s.sub!;
            const media: HwMedia[] = [];
            if (sub.media_file_id) media.push({ kind: /speak|rec|audio/.test(s.kind || '') ? 'audio' : 'img', fileId: sub.media_file_id });
            if (sub.media2_file_id) media.push({ kind: 'audio', fileId: sub.media2_file_id });
            const tfb = (sub.feedback || []).map((f) => String(f.text || f.comment || '')).filter(Boolean).join(' / ');
            const ai = sub.auto ? String((sub.auto as Record<string, unknown>).comment || (sub.auto as Record<string, unknown>).feedback || '') : '';
            const g = sub.grade_status || '';
            return { label: s.label_ko || s.q || s.kind || '', q: s.q, kind: s.kind, text: answerText(sub.answer), media, ai: ai || undefined, teacher: tfb || undefined, model: sub.model, score: sub.score, at: sub.submitted_at, status: /review|held|pending/.test(g) ? 'wait' : sub.score != null && sub.score < 1 ? 'fix' : 'ok' };
          }),
        }));
      } catch {
        /* 그날은 건너뜀 */
      }
    }
    days.push(day);
  }
  return { student: st.name, lastLesson: lastLesson ? ymd(lastLesson) : undefined, days, source: 'app' };
}
