// 빈칸: `___` 를 치거나 글자를 고르고 '빈칸'을 누르면 생긴다.
// 학생은 빈칸 안에 바로 친다(권한과 무관). 선생님은 정답/오답·답 보기·힌트를 누른다.
import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import type { NodeViewRenderer } from '@tiptap/core';
import type { Role } from '../store';

export interface BlankOptions {
  role: () => Role;
  onChange?: (kind: 'blank' | 'result', data: Record<string, unknown>) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blank: {
      selectionToBlank: () => ReturnType;
      setBlankAttrs: (pos: number, attrs: Record<string, unknown>) => ReturnType;
    };
  }
}

export const Blank = Node.create<BlankOptions>({
  name: 'blank',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { role: () => 'teacher', onChange: undefined };
  },

  addAttributes() {
    return {
      answer: { default: '' },
      hint: { default: '' },
      value: { default: '' }, // 학생이 친 것
      result: { default: '' }, // '', 'ok', 'no'
      revealed: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-blank]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-blank': '', class: 'blank' }), node.attrs.value || '______'];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /___$/,
        handler: ({ state, range }) => {
          const node = state.schema.nodes.blank.create({ answer: '' });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addCommands() {
    return {
      selectionToBlank:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection;
          if (empty) return false;
          const text = state.doc.textBetween(from, to, ' ');
          if (!text.trim()) return false;
          if (dispatch) {
            const node = state.schema.nodes.blank.create({ answer: text.trim() });
            tr.replaceWith(from, to, node);
            this.options.onChange?.('blank', { answer: text.trim() });
          }
          return true;
        },
      setBlankAttrs:
        (pos, attrs) =>
        ({ state, tr, dispatch }) => {
          const n = state.doc.nodeAt(pos);
          if (!n || n.type.name !== 'blank') return false;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs });
          return true;
        },
    };
  },

  addNodeView(): NodeViewRenderer {
    return ({ node, getPos, editor }) => {
      const role = this.options.role;
      const dom = document.createElement('span');
      dom.className = 'blank';
      dom.setAttribute('data-blank', '');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'blank-input';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('lang', 'ko');
      input.placeholder = ' ';

      const answerEl = document.createElement('span');
      answerEl.className = 'blank-answer';

      const tools = document.createElement('span');
      tools.className = 'blank-tools';
      const ok = mkBtn('○', '정답', 'ok');
      const no = mkBtn('✗', '오답', 'no');
      const eye = mkBtn('답', '답 보기/숨기기', 'eye');
      const hintBtn = mkBtn('힌', '첫 글자 힌트', 'hint');
      tools.append(ok, no, eye, hintBtn);

      dom.append(input, answerEl, tools);

      const posOf = () => (typeof getPos === 'function' ? getPos() : null);
      const setAttrs = (attrs: Record<string, unknown>) => {
        const pos = posOf();
        if (pos == null) return;
        editor.commands.setBlankAttrs(pos, attrs);
      };

      let composing = false;
      input.addEventListener('compositionstart', () => (composing = true));
      input.addEventListener('compositionend', () => {
        composing = false;
        setAttrs({ value: input.value });
      });
      input.addEventListener('input', () => {
        if (composing) return;
        setAttrs({ value: input.value });
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
        e.stopPropagation();
      });
      input.addEventListener('blur', () => {
        if (input.value !== (current.attrs.value || '')) setAttrs({ value: input.value });
        if (role() === 'student' && input.value) this.options.onChange?.('blank', { value: input.value });
      });

      ok.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = current.attrs.result === 'ok' ? '' : 'ok';
        setAttrs({ result: next });
        this.options.onChange?.('result', { answer: current.attrs.answer, value: current.attrs.value, result: next });
      });
      no.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = current.attrs.result === 'no' ? '' : 'no';
        setAttrs({ result: next });
        this.options.onChange?.('result', { answer: current.attrs.answer, value: current.attrs.value, result: next });
      });
      eye.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setAttrs({ revealed: !current.attrs.revealed });
      });
      hintBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const a: string = current.attrs.answer || '';
        const first = Array.from(a)[0] || '';
        setAttrs({ hint: current.attrs.hint ? '' : first });
      });
      [ok, no, eye, hintBtn].forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

      let current = node;
      const render = (n: typeof node) => {
        current = n;
        const r = role();
        dom.classList.toggle('ok', n.attrs.result === 'ok');
        dom.classList.toggle('no', n.attrs.result === 'no');
        dom.classList.toggle('revealed', !!n.attrs.revealed);
        dom.classList.toggle('teacher', r !== 'student');
        if (document.activeElement !== input && input.value !== (n.attrs.value || '')) input.value = n.attrs.value || '';
        input.readOnly = r === 'assist';
        const width = Math.max(4, Array.from(String(n.attrs.answer || n.attrs.value || '')).length + 2);
        input.style.width = width + 'ch';
        input.placeholder = n.attrs.hint ? n.attrs.hint + '…' : ' ';
        answerEl.textContent = n.attrs.revealed && n.attrs.answer ? n.attrs.answer : '';
        answerEl.style.display = n.attrs.revealed && n.attrs.answer ? '' : 'none';
        ok.classList.toggle('on', n.attrs.result === 'ok');
        no.classList.toggle('on', n.attrs.result === 'no');
        eye.classList.toggle('on', !!n.attrs.revealed);
        hintBtn.classList.toggle('on', !!n.attrs.hint);
        tools.style.display = r === 'teacher' ? '' : 'none';
        eye.title = n.attrs.answer ? `답: ${n.attrs.answer}` : '정답이 없는 빈칸';
      };
      render(node);

      return {
        dom,
        update(n) {
          if (n.type.name !== 'blank') return false;
          render(n);
          return true;
        },
        stopEvent: (e) => {
          const t = e.target as HTMLElement;
          return t === input || tools.contains(t);
        },
        ignoreMutation: () => true,
      };
    };
  },
});

function mkBtn(label: string, title: string, cls: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bk ' + cls;
  b.textContent = label;
  b.title = title;
  b.tabIndex = -1;
  return b;
}
