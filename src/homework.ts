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
