// 교정 블록: 학생 문장을 윗줄에 그대로 두고, 아랫줄에 맞는 문장을 친다.
// 윗줄에는 틀린 글자, 아랫줄에는 고친 글자가 표시된다(음절 LCS + 자모 비교).
import { Node, mergeAttributes } from '@tiptap/core';
import type { NodeViewRenderer } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffSentences, renderOriginal, correctedRanges } from '../diff';

export interface CorrectionOptions {
  onChange?: (kind: 'correction', data: Record<string, unknown>) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    correction: {
      paragraphToCorrection: () => ReturnType;
    };
  }
}

const key = new PluginKey('correctionDiff');

export const Correction = Node.create<CorrectionOptions>({
  name: 'correction',
  group: 'block',
  content: 'inline*',
  defining: true,

  addOptions() {
    return { onChange: undefined };
  },

  addAttributes() {
    return { original: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'div[data-correction]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-correction': '', class: 'correction' }), ['div', { class: 'corr-fixed' }, 0]];
  },

  addNodeView(): NodeViewRenderer {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'correction';
      dom.setAttribute('data-correction', '');
      const orig = document.createElement('div');
      orig.className = 'corr-orig';
      orig.contentEditable = 'false';
      const fixed = document.createElement('div');
      fixed.className = 'corr-fixed';
      dom.append(orig, fixed);
      const render = (n: typeof node) => {
        const ops = diffSentences(String(n.attrs.original || ''), n.textContent);
        orig.innerHTML = renderOriginal(ops) || '&nbsp;';
      };
      render(node);
      return {
        dom,
        contentDOM: fixed,
        update(n) {
          if (n.type.name !== 'correction') return false;
          render(n);
          return true;
        },
        ignoreMutation: (m) => m.type !== 'selection' && !fixed.contains(m.target),
      };
    };
  },

  addCommands() {
    return {
      paragraphToCorrection:
        () =>
        ({ state, tr, dispatch }) => {
          const { $from } = state.selection;
          const para = $from.parent;
          if (para.type.name !== 'paragraph' || !para.textContent.trim()) return false;
          const start = $from.before();
          const end = $from.after();
          if (dispatch) {
            const original = para.textContent;
            const node = state.schema.nodes.correction.create({ original }, para.content);
            tr.replaceWith(start, end, node);
            tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize - 1));
            this.options.onChange?.('correction', { original });
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const build = (doc: Parameters<typeof DecorationSet.create>[0]) => {
      const decos: Decoration[] = [];
      doc.descendants((n, pos) => {
        if (n.type.name !== 'correction') return true;
        const ops = diffSentences(String(n.attrs.original || ''), n.textContent);
        const base = pos + 1;
        // 아랫줄 글자 인덱스 → 문서 위치 (inline 노드는 길이 1로 셈)
        const idxToPos: number[] = [];
        let p = base;
        n.forEach((child) => {
          if (child.isText) {
            for (const ch of Array.from(child.text || '')) {
              idxToPos.push(p);
              p += ch.length;
            }
          } else {
            idxToPos.push(p);
            p += child.nodeSize;
          }
        });
        idxToPos.push(p);
        for (const r of correctedRanges(ops)) {
          const from = idxToPos[Math.min(r.from, idxToPos.length - 1)];
          const to = idxToPos[Math.min(r.to, idxToPos.length - 1)];
          if (from == null || to == null || from >= to) continue;
          decos.push(Decoration.inline(from, to, { class: 'd-ins', title: r.part || '' }));
        }
        return false;
      });
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => build(doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
