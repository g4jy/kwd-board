// 교정 차이: 음절 단위 LCS + 바뀐 음절의 자모 비교(es-hangul)
import { disassembleCompleteCharacter } from 'es-hangul';

export type DiffOp =
  | { op: 'eq'; a: string }
  | { op: 'del'; a: string }
  | { op: 'ins'; b: string }
  | { op: 'sub'; a: string; b: string; part: '받침' | '모음' | '자음' | '글자' };

function lcsOps(a: string[], b: string[]): Array<'eq' | 'del' | 'ins'> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<'eq' | 'del' | 'ins'> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('eq');
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push('del');
      i++;
    } else {
      ops.push('ins');
      j++;
    }
  }
  while (i < n) {
    ops.push('del');
    i++;
  }
  while (j < m) {
    ops.push('ins');
    j++;
  }
  return ops;
}

type Part = '받침' | '모음' | '자음' | '글자';

function jamoPart(a: string, b: string): Part {
  const da = disassembleCompleteCharacter(a);
  const db = disassembleCompleteCharacter(b);
  if (!da || !db) return '글자';
  const diffs: string[] = [];
  if (da.choseong !== db.choseong) diffs.push('자음');
  if (da.jungseong !== db.jungseong) diffs.push('모음');
  if (da.jongseong !== db.jongseong) diffs.push('받침');
  if (diffs.length === 1) return diffs[0] as '받침' | '모음' | '자음';
  return '글자';
}

export function diffSentences(original: string, corrected: string): DiffOp[] {
  const a = Array.from(original);
  const b = Array.from(corrected);
  const raw = lcsOps(a, b);
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < raw.length) {
    const op = raw[k];
    if (op === 'eq') {
      out.push({ op: 'eq', a: a[i] });
      i++;
      j++;
      k++;
      continue;
    }
    // del 뭉치와 ins 뭉치를 모아서 같은 길이면 교체로 본다
    const dels: string[] = [];
    const inss: string[] = [];
    while (k < raw.length && raw[k] !== 'eq') {
      if (raw[k] === 'del') dels.push(a[i++]);
      else inss.push(b[j++]);
      k++;
    }
    if (dels.length === inss.length) {
      for (let x = 0; x < dels.length; x++) out.push({ op: 'sub', a: dels[x], b: inss[x], part: jamoPart(dels[x], inss[x]) });
    } else {
      for (const d of dels) out.push({ op: 'del', a: d });
      for (const s of inss) out.push({ op: 'ins', b: s });
    }
  }
  return out;
}

// 원문(윗줄)에 표시할 HTML. 삭제·교체 글자를 표시한다.
export function renderOriginal(ops: DiffOp[]): string {
  return ops
    .map((o) => {
      if (o.op === 'eq') return esc(o.a);
      if (o.op === 'del') return `<s class="d-del">${esc(o.a)}</s>`;
      if (o.op === 'sub') return `<mark class="d-sub" title="${o.part}">${esc(o.a)}</mark>`;
      return '';
    })
    .join('');
}

// 고친 문장(아랫줄)에서 강조할 범위: [from, to) 는 아랫줄 글자 인덱스
export function correctedRanges(ops: DiffOp[]): Array<{ from: number; to: number; part?: string }> {
  const ranges: Array<{ from: number; to: number; part?: string }> = [];
  let pos = 0;
  for (const o of ops) {
    if (o.op === 'eq') pos += o.a.length;
    else if (o.op === 'ins') {
      ranges.push({ from: pos, to: pos + o.b.length });
      pos += o.b.length;
    } else if (o.op === 'sub') {
      ranges.push({ from: pos, to: pos + o.b.length, part: o.part });
      pos += o.b.length;
    }
  }
  return ranges;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
