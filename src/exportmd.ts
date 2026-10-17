// 판 → 마크다운. 밤 루틴이 읽는 형식이므로 꾸밈보다 규칙성을 우선한다.
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

function inline(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText) {
      let t = child.text || '';
      const marks = child.marks.map((m) => m.type.name);
      if (marks.includes('bold')) t = `**${t}**`;
      if (marks.includes('italic')) t = `*${t}*`;
      if (marks.includes('underline')) t = `__${t}__`;
      if (marks.includes('highlight')) t = `==${t}==`;
      const color = child.marks.find((m) => m.type.name === 'textStyle')?.attrs?.color;
      if (color) t = `{${colorName(color)}}${t}{/}`;
      out += t;
    } else if (child.type.name === 'blank') {
      const a = child.attrs.answer ? `(${child.attrs.answer})` : '';
      const v = child.attrs.value ? `[${child.attrs.value}]` : '';
      const r = child.attrs.result === 'ok' ? '○' : child.attrs.result === 'no' ? '✗' : '';
      out += `___${a}${v}${r}`;
    } else if (child.type.name === 'hardBreak') {
      out += '  \n';
    } else if (child.type.name === 'image') {
      out += '![이미지]';
    }
  });
  return out;
}

function colorName(c: string): string {
  const m: Record<string, string> = { '#d32f2f': 'red', '#1565c0': 'blue', '#2e7d32': 'green' };
  return m[c.toLowerCase()] || c;
}

function block(node: PMNode, depth: number, lines: string[], listCtx?: { kind: 'bullet' | 'ordered'; n: number }) {
  const indent = '    '.repeat(depth);
  switch (node.type.name) {
    case 'heading':
      lines.push(`${'#'.repeat(node.attrs.level)} ${inline(node)}`);
      lines.push('');
      break;
    case 'paragraph': {
      const t = inline(node);
      if (listCtx) {
        const marker = listCtx.kind === 'ordered' ? `${listCtx.n}.` : '-';
        lines.push(`${indent}${marker} ${t}`);
      } else {
        lines.push(t);
        lines.push('');
      }
      break;
    }
    case 'bulletList':
    case 'orderedList': {
      let n = 1;
      node.forEach((li) => {
        let first = true;
        li.forEach((c) => {
          if (first && c.type.name === 'paragraph') {
            block(c, depth, lines, { kind: node.type.name === 'orderedList' ? 'ordered' : 'bullet', n });
          } else {
            block(c, depth + 1, lines);
          }
          first = false;
        });
        n++;
      });
      if (!listCtx && depth === 0) lines.push('');
      break;
    }
    case 'wordCard':
      lines.push(`- ${node.attrs.word} : ${node.attrs.meaning}${node.attrs.confirmed ? ' ✓' : ''}`);
      break;
    case 'correction':
      lines.push(`✗ ${node.attrs.original}`);
      lines.push(`✓ ${inline(node)}`);
      lines.push('');
      break;
    case 'blockquote':
      node.forEach((c) => {
        const sub: string[] = [];
        block(c, 0, sub);
        sub.forEach((l) => lines.push(l ? `> ${l}` : '>'));
      });
      lines.push('');
      break;
    case 'image':
      lines.push('![이미지]');
      lines.push('');
      break;
    case 'horizontalRule':
      lines.push('---');
      lines.push('');
      break;
    case 'table': {
      let rowIdx = 0;
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          const parts: string[] = [];
          cell.forEach((c) => parts.push(inline(c)));
          cells.push(parts.join(' ').replace(/\|/g, '\\|'));
        });
        lines.push(`| ${cells.join(' | ')} |`);
        if (rowIdx === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
        rowIdx++;
      });
      lines.push('');
      break;
    }
    default:
      if (node.isTextblock) {
        lines.push(inline(node));
        lines.push('');
      } else {
        node.forEach((c) => block(c, depth, lines));
      }
  }
}

export function toMarkdown(editor: Editor, header?: Record<string, string>): string {
  const lines: string[] = [];
  if (header) {
    lines.push('---');
    for (const [k, v] of Object.entries(header)) lines.push(`${k}: ${v}`);
    lines.push('---');
    lines.push('');
  }
  editor.state.doc.forEach((n) => block(n, 0, lines));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export interface Summary {
  cards: Array<{ word: string; meaning: string; confirmed: boolean }>;
  corrections: Array<{ original: string; corrected: string }>;
  blanks: Array<{ answer: string; value: string; result: string }>;
}

export function summarize(editor: Editor): Summary {
  const s: Summary = { cards: [], corrections: [], blanks: [] };
  editor.state.doc.descendants((n) => {
    if (n.type.name === 'wordCard') s.cards.push({ word: n.attrs.word, meaning: n.attrs.meaning, confirmed: !!n.attrs.confirmed });
    else if (n.type.name === 'correction') s.corrections.push({ original: n.attrs.original, corrected: n.textContent });
    else if (n.type.name === 'blank') s.blanks.push({ answer: n.attrs.answer, value: n.attrs.value, result: n.attrs.result });
    return true;
  });
  return s;
}

export function pageMarkdown(editor: Editor): string {
  return toMarkdown(editor).trim();
}
