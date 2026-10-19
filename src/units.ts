// 커리큘럼 v2.3 학생용 단원 파일 (kwd-unit/v1, units/KWD-U###.json) — 읽기만 한다.
// 판은 단원을 만들지 않는다: 수업 묶음 로드맵이 가리키는 단원을 찾아 '판에 놓기' 글로 바꿔 보여 줄 뿐.
export interface UnitBlock {
  id?: string;
  type: string;
  title?: string;
  body_md?: string;
  body_md_en?: string;
  columns?: string[];
  rows?: string[][];
  items?: Array<Record<string, unknown>>;
  pairs?: Array<Record<string, unknown>>;
  instruction_ko?: string;
  renders?: string[];
}
export interface KwdUnit {
  schema?: string;
  unit_id: string;
  title_ko: string;
  stage?: string;
  goal?: string;
  can_do?: string[];
  why_today?: string;
  blocks: UnitBlock[];
}

export function validUnit(j: unknown): j is KwdUnit {
  const u = j as KwdUnit;
  return !!u && typeof u === 'object' && u.schema === 'kwd-unit/v1' && typeof u.unit_id === 'string' && Array.isArray(u.blocks);
}

export const UNIT_BLOCK_LABEL: Record<string, string> = { explain: '설명', table: '형태 표', examples: '예문', vocab: '단어', fill: '빈칸', choice: '고르기', transform: '고쳐 쓰기', order: '순서 맞추기', match: '짝 맞추기', speak: '말하기', culture: '문화' };

const s = (v: unknown) => (typeof v === 'string' ? v : '');

// 선생님 화면에 보이고 판 글상자로 놓을 수 있는 글 (정답은 선생님 화면에만 — 놓을 때는 문제만)
export function blockMd(b: UnitBlock, withAnswer = false): string {
  const head = b.title ? `**${b.title}**\n` : '';
  switch (b.type) {
    case 'explain':
    case 'culture':
      return head + s(b.body_md) + (b.body_md_en ? '\n\n' + s(b.body_md_en) : '');
    case 'table': {
      const cols = b.columns || [];
      if (!cols.length) return head;
      return head + `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n` + (b.rows || []).map((r) => `| ${r.join(' | ')} |`).join('\n');
    }
    case 'examples':
      return (b.items || []).map((i) => `- ${s(i.ko)}${i.en ? ` — ${s(i.en)}` : ''}`).join('\n');
    case 'vocab':
      return (b.items || []).filter((i) => i.role !== 'reserve').map((i) => `- ${s(i.display) || s(i.lemma)} — ${s(i.gloss)}`).join('\n');
    case 'fill':
      return (b.items || []).map((i, n) => `${n + 1}. ${s(i.prompt)}${withAnswer ? `  → ${s(i.answer)}` : ''}`).join('\n');
    case 'choice':
      return (b.items || []).map((i, n) => `${n + 1}. ${s(i.prompt)}  [${((i.options as string[]) || []).join(' / ')}]${withAnswer ? `  → ${((i.options as string[]) || [])[Number(i.answer)] ?? ''}` : ''}`).join('\n');
    case 'transform':
      return (b.items || []).map((i, n) => `${n + 1}. ${s(i.base)}  (${s(i.to)})${withAnswer ? `  → ${s(i.answer)}` : ''}`).join('\n');
    case 'order':
      // 낱말을 섞인 채로(tokens 순서 그대로) 보여 주고, 정답은 선생님 화면에만
      return (b.items || []).map((i, n) => `${n + 1}. ${Array.isArray(i.tokens) ? (i.tokens as string[]).join(' / ') : ''}${withAnswer ? `  → ${s(i.answer)}` : ''}`).join('\n');
    case 'match': {
      const ps = (b.pairs || []) as unknown as string[][];
      if (!ps.length) return '';
      // 문제: 왼쪽 낱말 + 뜻은 거꾸로 섞어서 / 선생님 화면: 짝을 바로
      if (withAnswer) return ps.map((p, n) => `${n + 1}. ${p[0]} ↔ ${p[1]}`).join('\n');
      return ps.map((p, n) => `${n + 1}. ${p[0]}`).join('\n') + '\n\n' + [...ps].reverse().map((p, n) => `${String.fromCharCode(65 + n)}. ${p[1]}`).join('\n');
    }
    case 'speak':
      return (b.items || []).map((i) => `- ${s(i.prompt_ko)}${i.prompt_en ? ` (${s(i.prompt_en)})` : ''}`).join('\n');
    default:
      return '';
  }
}
