// 페이지 위에 놓는 것들: 글상자 · 사진 · 웹 학습지. 페이지 좌표(px)로 저장되어 페이지와 함께 움직인다.
// 옮기기: 위쪽 손잡이(⠿) 또는 사진은 그대로 끌기. 크기: 오른쪽 아래 모서리. 사진은 비율을 지킨다.
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { createPageEditor } from './editor';
import { htmlWithBridge } from './importer';
import type { BoardStore, PageObject, Role } from './store';
import { h } from './ui';

export interface ObjectHost {
  store: BoardStore;
  role: Role;
  undo: Y.UndoManager;
  scale(): number; // 화면 px / 페이지 px
  canEdit(): boolean; // 옮기기·크기·지우기
  canType(): boolean; // 글상자에 쓰기
  interactive(): boolean; // 지금 도구에서 손댈 수 있나 (펜일 때는 아니다)
  selectMode(): boolean; // 선택 도구: 상자·학습지도 몸통을 끌어 옮긴다
  selected(): string | null;
  select(pageId: string, id: string | null): void;
  onText(pageId: string, block: string, kind: string, text: string): void;
  onBoxFocus(editor: Editor, pageId: string): void;
  onHtmlEvent(pageId: string, mid: string, d: { type?: string; name?: string; value?: unknown; score?: unknown; text?: string }): void;
}

interface ObjView {
  el: HTMLElement;
  data: PageObject;
  editor?: Editor;
  frame?: HTMLIFrameElement;
}

export const BOX_W = 260;

export class PageObjects {
  readonly host: HTMLElement;
  private views = new Map<string, ObjView>();
  private arr: Y.Array<Y.Map<unknown>>;
  private obs: () => void;
  readonly editors = new Map<string, Editor>();

  constructor(
    private pageId: string,
    pageEl: HTMLElement,
    private ctx: ObjectHost,
  ) {
    this.host = h('div', { class: 'page-objs' });
    pageEl.append(this.host);
    this.arr = ctx.store.objs(pageId);
    ctx.undo.addToScope([this.arr]);
    this.obs = () => this.render();
    this.arr.observeDeep(this.obs);
    this.render();
  }

  private render() {
    const list = this.ctx.store.objList(this.pageId);
    const ids = new Set(list.map((o) => o.id));
    for (const [id, v] of this.views) {
      if (!ids.has(id)) {
        if (v.editor) {
          v.editor.destroy();
          // 편집기를 없애면 Tiptap 이 공용 UndoManager 를 멈춘다 → 바로 되살린다
          (this.ctx.undo as unknown as { restore?: () => void }).restore?.();
          this.editors.delete(id);
        }
        (v as ObjView & { off?: () => void }).off?.();
        v.el.remove();
        this.views.delete(id);
      }
    }
    for (const o of list) {
      const v = this.views.get(o.id);
      if (!v) this.create(o);
      else {
        v.data = o;
        this.place(v);
      }
    }
    this.refreshSelection();
  }

  private place(v: ObjView) {
    const o = v.data;
    v.el.style.left = o.x + 'px';
    v.el.style.top = o.y + 'px';
    v.el.style.width = o.w + 'px';
    if (o.type === 'box') v.el.style.minHeight = o.h + 'px';
    else v.el.style.height = o.h + 'px';
  }

  refreshSelection() {
    const sel = this.ctx.selected();
    for (const [id, v] of this.views) v.el.classList.toggle('sel', id === sel);
  }

  setEditable(on: boolean) {
    for (const ed of this.editors.values()) ed.setEditable(on, false);
  }

  private create(o: PageObject) {
    const el = h('div', { class: `obj obj-${o.type}`, 'data-obj': o.id });
    const v: ObjView = { el, data: o };
    const grip = h('button', { type: 'button', class: 'obj-grip', title: '끌어서 옮기기', 'aria-label': '옮기기' }, '⠿');
    const del = h('button', { type: 'button', class: 'obj-del', title: '지우기', 'aria-label': '지우기' }, '×');
    const size = h('span', { class: 'obj-size', title: '끌어서 크기 바꾸기' });
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.ctx.canEdit()) return;
      this.ctx.store.removeObj(this.pageId, o.id);
    });
    if (o.type === 'box') {
      const host = h('div', { class: 'obj-box-text' });
      el.append(host);
      const editor = createPageEditor(
        host,
        this.ctx.store,
        this.pageId,
        this.ctx.role,
        this.ctx.undo,
        {
          onText: (block, kind, text) => this.ctx.onText(this.pageId, block, 'box:' + kind, text),
          onEvent: () => undefined,
          onFocus: () => {
            this.ctx.select(this.pageId, o.id);
            this.ctx.onBoxFocus(editor, this.pageId);
          },
          onBlur: () => {
            // 비어 있는 채로 떠나면 상자를 없앤다 (실수로 만든 상자)
            window.setTimeout(() => {
              if (!this.views.has(o.id) || editor.isFocused) return;
              if (!editor.state.doc.textContent.trim() && this.ctx.canEdit() && Date.now() - (v.data.t || 0) < 10 * 60_000) this.ctx.store.removeObj(this.pageId, o.id);
            }, 200);
          },
        },
        '여기에 쓰세요',
        this.ctx.store.boxFragment(o.id),
        'box-doc',
      );
      editor.setEditable(this.ctx.canType(), false);
      v.editor = editor;
      this.editors.set(o.id, editor);
      this.ctx.undo.addToScope([this.ctx.store.boxFragment(o.id)]);
      el.append(grip, del, size);
      this.bindMove(v, grip);
      this.bindMove(v, el, true);
      this.bindResize(v, size, false);
    } else if (o.type === 'img') {
      const img = h('img', { class: 'obj-img-el', alt: o.name || '', draggable: 'false' }) as HTMLImageElement;
      img.src = this.ctx.store.resolveImg(o.src);
      el.append(img, del, size);
      this.bindMove(v, el);
      this.bindResize(v, size, true);
    } else {
      const bar = h('div', { class: 'obj-bar' }, h('span', { class: 'obj-name' }, o.name || '웹 학습지'));
      const frame = h('iframe', { class: 'mat-frame obj-frame', sandbox: 'allow-scripts allow-forms', title: o.name || '자료' }) as HTMLIFrameElement;
      const md = o.mid ? this.ctx.store.matdata.get(`${o.mid}/1`) : undefined;
      if (md?.html != null) frame.srcdoc = htmlWithBridge(md.html);
      bar.prepend(grip);
      bar.append(del);
      el.append(bar, frame, size);
      v.frame = frame;
      this.bindMove(v, bar);
      this.bindMove(v, el, true);
      this.bindResize(v, size, false);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
        const t = (e.data as { type?: string }).type;
        if (t === 'kwd:event' || t === 'kwd:text') this.ctx.onHtmlEvent(this.pageId, o.mid || '', e.data);
      };
      window.addEventListener('message', onMsg);
      (v as ObjView & { off?: () => void }).off = () => window.removeEventListener('message', onMsg);
    }
    el.addEventListener('pointerdown', () => {
      if (this.ctx.interactive()) this.ctx.select(this.pageId, o.id);
    });
    this.views.set(o.id, v);
    this.place(v);
    this.host.append(el);
  }

  focusBox(id: string) {
    const ed = this.editors.get(id);
    if (!ed) return;
    ed.commands.focus('end');
    window.setTimeout(() => !ed.isFocused && ed.commands.focus('end'), 20);
  }

  // 끌어서 옮기기 (손잡이 또는 사진 자체)
  private bindMove(v: ObjView, handle: HTMLElement, selectOnly = false) {
    handle.addEventListener('pointerdown', (e) => {
      if (!this.ctx.canEdit() || !this.ctx.interactive()) return;
      if (selectOnly && !this.ctx.selectMode()) return;
      if (e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest('.obj-del,.obj-size')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.ctx.select(this.pageId, v.data.id);
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      const ox = v.data.x, oy = v.data.y;
      v.el.classList.add('dragging');
      let moved = false;
      const mv = (ev: PointerEvent) => {
        const s = this.ctx.scale();
        const dx = (ev.clientX - sx) / s, dy = (ev.clientY - sy) / s;
        if (!moved && Math.hypot(dx, dy) * s < 3) return;
        moved = true;
        v.el.style.left = ox + dx + 'px';
        v.el.style.top = oy + dy + 'px';
      };
      const up = (ev: PointerEvent) => {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        v.el.classList.remove('dragging');
        if (!moved) return;
        const s = this.ctx.scale();
        this.ctx.store.updateObj(this.pageId, v.data.id, { x: Math.round(ox + (ev.clientX - sx) / s), y: Math.round(oy + (ev.clientY - sy) / s) });
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // 오른쪽 아래 모서리로 크기 바꾸기
  private bindResize(v: ObjView, handle: HTMLElement, keepRatio: boolean) {
    handle.addEventListener('pointerdown', (e) => {
      if (!this.ctx.canEdit() || !this.ctx.interactive()) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      const ow = v.data.w, oh = v.data.h;
      const ratio = v.data.ratio || ow / oh;
      const minW = v.data.type === 'box' ? 80 : 60;
      const calc = (ev: PointerEvent) => {
        const s = this.ctx.scale();
        let w = Math.max(minW, ow + (ev.clientX - sx) / s);
        let hh = Math.max(40, oh + (ev.clientY - sy) / s);
        if (keepRatio) hh = w / ratio;
        if (v.data.type === 'box') hh = oh;
        return { w: Math.round(w), h: Math.round(hh) };
      };
      const mv = (ev: PointerEvent) => {
        const r = calc(ev);
        v.el.style.width = r.w + 'px';
        if (v.data.type !== 'box') v.el.style.height = r.h + 'px';
      };
      const up = (ev: PointerEvent) => {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.ctx.store.updateObj(this.pageId, v.data.id, calc(ev));
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // 선택 도구 네모 안에 다 들어오는 것
  idsInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const out: string[] = [];
    for (const [id, v] of this.views) {
      const o = v.data;
      const hh = o.type === 'box' ? Math.max(o.h, v.el.offsetHeight) : o.h;
      if (o.x >= x0 && o.y >= y0 && o.x + o.w <= x1 && o.y + hh <= y1) out.push(id);
    }
    return out;
  }

  textOf(id: string): string {
    const ed = this.editors.get(id);
    return ed ? ed.getText().trim() : '';
  }

  destroy() {
    this.arr.unobserveDeep(this.obs);
    for (const v of this.views.values()) {
      v.editor?.destroy();
      (v as ObjView & { off?: () => void }).off?.();
    }
    this.views.clear();
    this.host.remove();
  }
}

// 기록용: 편집기가 없어도 글상자 글을 꺼낸다
export function boxPlainText(store: BoardStore, id: string): string {
  return store
    .boxFragment(id)
    .toString()
    .replace(/<\/(paragraph|heading|listItem|tableRow)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}
