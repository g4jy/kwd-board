// 글 페이지 하나의 Tiptap 편집기. 한글 IME 안전: 타자 중에 문서가 스스로 바뀌지 않는다.
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { Blank } from './nodes/blank';
import { Correction } from './nodes/correction';
import { BoardStore, randomId, type Role } from './store';

export const ROLE_COLORS: Record<Role, string> = { teacher: '#1f6feb', student: '#2e9e5b', assist: '#8a5bd6' };
export const ROLE_NAMES: Record<Role, string> = { teacher: '선생님', student: '학생', assist: '보조기기' };

const BLOCK_TYPES = ['paragraph', 'heading', 'correction'];

// 블록 고정 id: 모든 글 블록에 bid. 비었거나 겹치면 새로 준다(선생님 기기만).
const BlockId = Extension.create<{ enabled: boolean }>({
  name: 'blockId',
  addOptions() {
    return { enabled: true };
  },
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          bid: { default: null, parseHTML: () => null, renderHTML: (a) => (a.bid ? { 'data-bid': a.bid } : {}), keepOnSplit: false },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    const enabled = this.options.enabled;
    return [
      new Plugin({
        key: new PluginKey('blockId'),
        appendTransaction(trs, _old, state) {
          if (!enabled || !trs.some((t) => t.docChanged)) return null;
          if (trs.some((t) => t.getMeta(ySyncPluginKey))) {
            // 원격 변경만 있으면 건드리지 않는다
            if (trs.every((t) => t.getMeta(ySyncPluginKey))) return null;
          }
          const seen = new Set<string>();
          let tr = state.tr;
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return true;
            const bid = node.attrs.bid as string | null;
            if (!bid || seen.has(bid)) {
              const nb = randomId(7);
              tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, bid: nb });
              seen.add(nb);
              changed = true;
            } else seen.add(bid);
            return true;
          });
          if (!changed) return null;
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});

// 이미지 파일 → 축소 → dataURL
export async function fileToDataUrl(file: File | Blob, maxSide = 1400): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
}

export function insertImageFiles(editor: Editor, files: FileList | File[], onDone?: (name: string) => void) {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  (async () => {
    for (const f of list) {
      const src = await fileToDataUrl(f);
      editor.chain().focus().setImage({ src, alt: f.name }).run();
      onDone?.(f.name);
    }
  })();
}

const ImagePaste = Extension.create<{ onImage: (name: string) => void }>({
  name: 'imagePaste',
  addOptions() {
    return { onImage: () => undefined };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    const editor = this.editor;
    const isImg = (fl?: FileList | null) => !!fl && Array.from(fl).some((f) => f.type.startsWith('image/'));
    return [
      new Plugin({
        key: new PluginKey('imagePaste'),
        props: {
          handlePaste(_v, e) {
            if (!isImg(e.clipboardData?.files)) return false;
            insertImageFiles(editor, e.clipboardData!.files, opts.onImage);
            return true;
          },
          handleDrop(_v, e) {
            if (!isImg(e.dataTransfer?.files)) return false;
            e.preventDefault();
            insertImageFiles(editor, e.dataTransfer!.files, opts.onImage);
            return true;
          },
        },
      }),
    ];
  },
});

// 학생 메모리 힌트: 선생님 화면에서만, 메모리에 있는 단어에 점선 밑줄
export const hintKey = new PluginKey<DecorationSet>('memoryHints');
export interface HintWord {
  kr: string;
  note: string;
}
export function makeHintPlugin(getWords: () => HintWord[]) {
  const build = (doc: PMNode) => {
    const words = getWords().filter((w) => w.kr.length >= 2);
    if (!words.length) return DecorationSet.empty;
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      const text = node.text;
      for (const w of words) {
        let i = text.indexOf(w.kr);
        while (i >= 0) {
          decos.push(Decoration.inline(pos + i, pos + i + w.kr.length, { class: 'mem-hint', title: w.note }));
          i = text.indexOf(w.kr, i + w.kr.length);
        }
      }
      return false;
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin<DecorationSet>({
    key: hintKey,
    state: {
      init: (_, { doc }) => build(doc),
      apply: (tr, old) => (tr.docChanged || tr.getMeta(hintKey) ? build(tr.doc) : old.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations(state) {
        return hintKey.getState(state);
      },
    },
  });
}

export interface PageEditorHooks {
  onText: (block: string, kind: string, text: string) => void;
  onEvent: (kind: 'blank' | 'result' | 'correction' | 'image', data: Record<string, unknown>) => void;
  scrollToSelection?: (rect: { left: number; top: number; bottom: number }) => void;
  onFocus?: () => void;
}

export function createPageEditor(element: HTMLElement, store: BoardStore, pageId: string, role: Role, undoManager: Y.UndoManager, hooks: PageEditorHooks, placeholder: string): Editor {
  const fragment = store.fragment(pageId);
  const editor = new Editor({
    element,
    editable: role === 'teacher',
    extensions: [
      StarterKit.configure({ undoRedo: false, link: false, codeBlock: false, code: false, heading: { levels: [1, 2, 3] } }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Image.configure({ allowBase64: true, inline: false, resize: { enabled: true, minWidth: 80 } }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder }),
      Blank.configure({ role: () => role, onChange: (k, d) => hooks.onEvent(k, d) }),
      Correction.configure({ onChange: (k, d) => hooks.onEvent(k, d) }),
      ImagePaste.configure({ onImage: (name) => hooks.onEvent('image', { name }) }),
      BlockId.configure({ enabled: true }),
      Collaboration.configure({ document: store.doc, fragment, yUndoOptions: { undoManager } }),
      CollaborationCaret.configure({ provider: { awareness: store.awareness }, user: { name: ROLE_NAMES[role], color: ROLE_COLORS[role] } }),
    ],
    editorProps: {
      attributes: { class: 'board-doc', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', lang: 'ko' },
      handleScrollToSelection: (view) => {
        if (!hooks.scrollToSelection) return false;
        try {
          hooks.scrollToSelection(view.coordsAtPos(view.state.selection.head));
        } catch {
          /* ignore */
        }
        return true;
      },
    },
    onFocus: () => hooks.onFocus?.(),
    onUpdate: ({ editor: ed, transaction }) => {
      if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey)) return;
      const { $from } = ed.state.selection;
      for (let d = $from.depth; d >= 1; d--) {
        const n = $from.node(d);
        if (BLOCK_TYPES.includes(n.type.name)) {
          const bid = n.attrs.bid as string | null;
          if (bid) {
            const kind = n.type.name === 'heading' ? `h${n.attrs.level}` : $from.depth > 1 && $from.node(1).type.name.endsWith('List') ? $from.node(1).type.name : n.type.name;
            hooks.onText(bid, kind, n.textContent.slice(0, 400));
          }
          break;
        }
      }
    },
  });
  return editor;
}
