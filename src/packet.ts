// 수업 묶음 lesson_packet/v1 (C:\KWD\biz\수업시스템\contracts) — 수업 직전 PC 자동화가 만든 것을 읽기만 한다.
// 판은 로드맵·대화 재료·시간 배분을 만들지 않는다. 묶음은 이 창의 메모리에만 두고 Yjs(학생 기기·동기 서버)로 보내지 않는다.
// 선생님이 '판에 깔기'를 누른 카드 글만 판에 들어간다.

export interface PacketSegment {
  key: string; // talk | hw_feedback | main | wrap
  label_ko: string;
  minutes: number;
  range?: [number, number];
  plan?: string[];
}
export interface RoadStep {
  id: string;
  title: string;
  status: 'done' | 'now' | 'next' | 'later';
  can_do?: string;
  units?: string[];
  done?: number;
  total?: number;
  target_date?: string | null;
  done_date?: string | null;
}
export interface PacketRoadmap {
  unit_id?: string;
  unit_title?: string;
  status?: string;
  core_progress?: { done: number; total: number; ratio?: number };
  why_now?: string;
  next_units?: string[];
  goal_line?: string;
  goal_start?: { text: string; set_on?: string; why?: string; horizon?: string };
  path?: RoadStep[];
  nearest?: { id?: string; title?: string; target_date?: string | null; left_units?: number; left_lessons?: number | null };
  pace?: { label?: 'ahead' | 'on_track' | 'behind' | 'unknown'; label_ko?: string; lessons_done?: number; lessons_expected?: number | null; units_done?: number; units_expected?: number | null; hw_days_ratio?: number | null; note_ko?: string };
  today?: string[];
  this_week?: string[];
}
export interface TalkKit {
  share_ok?: boolean;
  topic?: string;
  words: Array<{ w: string; en?: string; from?: string; srs?: string }>;
  expressions: Array<{ pattern: string; meaning?: string; from?: string; examples: Array<{ ko: string; en?: string }> }>;
}
export interface LessonPacket {
  schema: string;
  packet_id: string;
  mode?: string;
  lesson?: { date?: string; duration_min?: number; lesson_no?: number; next_lesson_date?: string };
  student?: { student_no?: string; folder_ref?: string; level_label?: string; goals?: string[] };
  roadmap?: PacketRoadmap;
  homework?: { feedback_pick?: Array<{ item: string; why?: string; kind?: string }>; split_inputs?: { days_expected?: number; days_done?: number; student_questions?: number } };
  review?: { warmup_questions?: Array<{ q: string; targets?: string[] }>; review_words?: string[] };
  time_split?: { total_min: number; segments: PacketSegment[]; reasons_ko?: string[] };
  talk_kit?: TalkKit;
  teacher_notes?: { watch_out?: string[]; ask?: string[] };
}

export function validPacket(j: unknown): j is LessonPacket {
  const p = j as LessonPacket;
  return !!p && typeof p === 'object' && p.schema === 'kwd/lesson-packet/v1' && typeof p.packet_id === 'string';
}

// _index.json 의 한 줄에서 학생 폴더와 파일 이름 찾기 (모양이 조금 달라도 읽는다)
export function indexEntries(j: unknown): Array<{ folder: string; file: string }> {
  const arr = Array.isArray(j) ? j : Array.isArray((j as { packets?: unknown[] })?.packets) ? (j as { packets: unknown[] }).packets : [];
  const out: Array<{ folder: string; file: string }> = [];
  for (const e of arr as Array<Record<string, unknown>>) {
    const folder = String(e.folder || e.folder_ref || e.student_folder || '');
    const file = String(e.file || e.path || e.packet || '');
    if (folder && file) out.push({ folder, file: file.split(/[\\/]/).pop()! });
  }
  return out;
}

// 학생 화면에 깔 대화 재료 (이름·사적 메모 없음: share_ok 일 때만)
export function talkKitMarkdown(k: TalkKit): string {
  const lines: string[] = ['### 오늘 대화'];
  if (k.topic) lines.push(k.topic);
  if (k.words.length) lines.push('', '**전에 배운 말**', k.words.map((w) => w.w).join(' · '));
  for (const e of k.expressions) {
    lines.push('', `**${e.pattern}**${e.meaning ? ` — ${e.meaning}` : ''}`);
    for (const x of e.examples.slice(0, 4)) lines.push(`- ${x.ko}`);
  }
  return lines.join('\n');
}

export const PACE_KO: Record<string, string> = { ahead: '빠름', on_track: '계획대로', behind: '조금 늦음', unknown: '아직 모름' };
