// 페이지 위에 놓는 것들: 글상자 · 사진 · 웹 학습지. 페이지 좌표(px)로 저장되어 페이지와 함께 움직인다.
// 옮기기: 위쪽 손잡이(⠿) 또는 사진은 그대로 끌기. 크기: 오른쪽 아래 모서리. 사진은 비율을 지킨다.
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { createPageEditor } from './editor';
import { htmlWithBridge } from './importer';
import type { BoardStore, PageObject, Role } from './store';
import { h } from './ui';
import { icon } from './icons';

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
  openPopup(pageId: string, id: string): void; // 모두의 화면에 크게
  focusObj(pageId: string, id: string): void; // 화면에 꽉 차게 (선생님: 학생 화면도 '여기 보세요')
  canDrive(): boolean; // 웹 학습지 단계를 넘기고 고를 수 있나 (선생님, 또는 허락받은 학생)
  addWsBox?(layerId: string, x: number, y: number): void; // 학습지 위 글상자
  saveWs?(pageId: string, objId: string): void; // 필기 넣은 학습지 저장
  onHtmlEvent(pageId: string, mid: string, d: { type?: string; name?: string; value?: unknown; score?: unknown; text?: string }): void;
}

interface ObjView {
  el: HTMLElement;
  data: PageObject;
  editor?: Editor;
  frame?: HTMLIFrameElement;
  ws?: { layer: HTMLElement; objs: PageObjects | null; step: number; frameStep: number; stepEl: HTMLElement };
}

export const wsLayerId = (objId: string, step: number) => `ws:${objId}:${step}`;

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
    if (v.ws) this.syncWs(v);
    v.el.style.left = o.x + 'px';
    v.el.style.top = o.y + 'px';
    v.el.style.width = o.w + 'px';
    if (o.type === 'box') v.el.style.minHeight = o.h + 'px';
    else v.el.style.height = o.h + 'px';
  }

  // 학습지 단계가 바뀌면: iframe 을 그 단계로, 필기층(글상자)을 그 단계 것으로
  private syncWs(v: ObjView) {
    const ws = v.ws!;
    const st = v.data.step || 1;
    ws.stepEl.textContent = v.data.steps && v.data.steps > 1 ? `${st}/${v.data.steps}` : '';
    if (ws.frameStep && ws.frameStep !== st) {
      ws.frameStep = st;
      v.frame?.contentWindow?.postMessage({ type: 'kwd:goto', n: st }, '*');
    }
    if (ws.step !== st) {
      ws.step = st;
      ws.objs?.destroy();
      ws.objs = new PageObjects(wsLayerId(v.data.id, st), ws.layer, this.ctx);
    }
  }

  wsObjects(): PageObjects[] {
    const out: PageObjects[] = [];
    for (const v of this.views.values()) if (v.ws?.objs) out.push(v.ws.objs);
    return out;
  }

  refreshSelection() {
    const sel = this.ctx.selected();
    for (const [id, v] of this.views) {
      v.el.classList.toggle('sel', id === sel);
      v.ws?.objs?.refreshSelection();
    }
  }

  setEditable(on: boolean) {
    for (const ed of this.editors.values()) ed.setEditable(on, false);
    for (const v of this.views.values()) v.ws?.objs?.setEditable(on);
  }

  private create(o: PageObject) {
    const el = h('div', { class: `obj obj-${o.type}`, 'data-obj': o.id });
    const v: ObjView = { el, data: o };
    // 고르면 위에 뜨는 막대 (10/19): 판 배율과 상관없이 화면에서 36px. 옮기기 · 크게 · (학습지) 글상자·저장 · 지우기
    const tools = h('div', { class: 'obj-tools', role: 'toolbar', 'aria-label': '이 자료' });
    tools.addEventListener('pointerdown', (e) => e.stopPropagation());
    const tool = (cls: string, ic: string, title: string, fn?: () => void) => {
      const b = h('button', { type: 'button', class: 'ot ' + cls, title, 'aria-label': title.split(' (')[0] }, icon(ic));
      if (fn) {
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          fn();
        });
      }
      return b;
    };
    const grip = tool('obj-grip', 'move', '끌어서 옮기기');
    const del = tool('obj-del', 'close', '지우기');
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
      tools.append(grip, del);
      el.append(tools, size);
      this.bindMove(v, grip);
      this.bindMove(v, el, true);
      this.bindResize(v, size, false);
    } else if (o.type === 'img') {
      const img = h('img', { class: 'obj-img-el', alt: o.name || '', draggable: 'false' }) as HTMLImageElement;
      img.src = this.ctx.store.resolveImg(o.src);
      const big = tool('obj-big', 'big', '모두의 화면에 크게 보기', () => this.ctx.openPopup(this.pageId, o.id));
      tools.append(big, del);
      el.append(img, tools, size);
      this.bindMove(v, el);
      this.bindResize(v, size, true);
    } else if (o.type === 'slide') {
      // PDF·슬라이드 한 쪽: 판 위의 그림 (필기는 판 좌표로 그 위에 그대로 붙는다)
      const img = h('img', { class: 'obj-img-el slide-img', alt: '', draggable: 'false' }) as HTMLImageElement;
      const setSrc = () => {
        const md = this.ctx.store.matdata.get(`${o.mid}/${o.n}`);
        if (md?.img) img.src = this.ctx.store.resolveImg(md.img);
        return !!md?.img;
      };
      if (!setSrc()) {
        const obs = () => setSrc() && this.ctx.store.matdata.unobserve(obs);
        this.ctx.store.matdata.observe(obs);
      }
      const mat = o.mid ? this.ctx.store.materials.get(o.mid) : null;
      const label = h('div', { class: 'slide-label' }, `${mat?.name || '슬라이드'} · ${o.n}${mat?.pages ? '/' + mat.pages : ''}`);
      const big = tool('obj-big', 'big', this.ctx.role === 'teacher' ? '이 쪽을 크게 (학생 화면도)' : '이 쪽을 크게', () => this.ctx.focusObj(this.pageId, o.id));
      tools.append(big, del);
      el.append(label, img, tools);
      this.bindMove(v, el, true);
    } else if (o.type === 'audio' || o.type === 'video' || o.type === 'youtube') {
      const icon = o.type === 'audio' ? '♪' : '▶';
      const bar = h('div', { class: 'obj-bar' }, h('span', { class: 'obj-name' }, `${icon} ${o.name || (o.type === 'youtube' ? '유튜브' : o.type === 'audio' ? '소리' : '영상')}`));
      let media: HTMLElement;
      if (o.type === 'audio') media = h('audio', { class: 'obj-media', controls: '', preload: 'metadata' });
      else if (o.type === 'video') media = h('video', { class: 'obj-media', controls: '', playsinline: '', preload: 'metadata' });
      else {
        const id = youtubeId(o.url || '') || '';
        media = h('iframe', { class: 'obj-media obj-yt', title: o.name || '유튜브', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin' });
        (media as HTMLIFrameElement).src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
      }
      // 서버(다른 주소)의 파일도 녹화 '자료' 줄로 소리를 뽑을 수 있게 CORS 로 받는다
      if (o.type !== 'youtube') {
        const u = this.ctx.store.resolveImg(o.src);
        if (/^https?:/.test(u) && !u.startsWith(location.origin)) (media as HTMLMediaElement).crossOrigin = 'anonymous';
        (media as HTMLMediaElement).src = u;
      }
      tools.append(grip);
      if (o.type !== 'audio') tools.append(tool('obj-big inbar', 'big', '모두의 화면에 크게 보기', () => this.ctx.openPopup(this.pageId, o.id)));
      tools.append(del);
      el.append(bar, media, tools, size);
      this.bindMove(v, bar);
      this.bindMove(v, grip);
      this.bindResize(v, size, o.type !== 'audio' && o.type !== 'youtube' ? false : false);
    } else {
      // 웹 학습지: 학생이 직접 누르고, 그 위에 필기·글상자. 학습지의 단계(쪽)마다 필기가 따로 남는다.
      const stepEl = h('span', { class: 'ws-step', title: '학습지 단계' });
      const bar = h('div', { class: 'obj-bar' }, h('span', { class: 'obj-name' }, o.name || '웹 학습지'), stepEl);
      const frame = h('iframe', { class: 'mat-frame obj-frame', sandbox: 'allow-scripts allow-forms', title: o.name || '자료' }) as HTMLIFrameElement;
      const md = o.mid ? this.ctx.store.matdata.get(`${o.mid}/1`) : undefined;
      if (md?.html != null) frame.srcdoc = htmlWithBridge(md.html);
      const layer = h('div', { class: 'ws-layer' });
      tools.append(grip);
      if (this.ctx.canType() && this.ctx.addWsBox) tools.append(tool('obj-bt ws-t', 'textbox', '이 단계 위에 글상자', () => this.ctx.addWsBox!(wsLayerId(o.id, v.data.step || 1), Math.max(16, v.data.w / 2 - 130), 40)));
      tools.append(tool('obj-bt', 'big', this.ctx.role === 'teacher' ? '학습지를 크게 (학생 화면도)' : '학습지를 크게', () => this.ctx.focusObj(this.pageId, o.id)));
      if (this.ctx.role === 'teacher' && this.ctx.saveWs) tools.append(tool('obj-bt', 'save', '필기 넣은 학습지 저장 (학생 폴더 또는 내려받기)', () => this.ctx.saveWs!(this.pageId, o.id)));
      tools.append(del);
      el.append(bar, frame, layer, tools, size);
      v.frame = frame;
      v.ws = { layer, objs: null, step: 0, frameStep: 0, stepEl };
      this.bindMove(v, bar);
      this.bindMove(v, grip);
      this.bindMove(v, el, true);
      this.bindResize(v, size, false);
      const states = this.ctx.store.doc.getMap<unknown>('wsstate:' + o.id);
      const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage(msg, '*');
      // 새로 열린 학습지는 먼저 판의 단계로 맞춘다 (그 전에 학습지가 알려 오는 '1단계'로 판을 되돌리지 않게)
      let synced = false;
      let syncTimer = 0;
      const pushAll = () => {
        synced = false;
        window.clearTimeout(syncTimer);
        syncTimer = window.setTimeout(() => (synced = true), 1500);
        for (const [key, val] of states) post({ type: 'kwd:state', key, val });
        const st = v.data.step || 1;
        v.ws!.frameStep = st;
        post({ type: 'kwd:goto', n: st });
      };
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
        const d = e.data as { type?: string; n?: number; total?: number; key?: string; val?: unknown };
        const t = d.type;
        if (t === 'kwd:event' || t === 'kwd:text') this.ctx.onHtmlEvent(this.pageId, o.mid || '', e.data);
        else if (t === 'kwd:hello') pushAll();
        else if (t === 'kwd:step' && typeof d.n === 'number') {
          v.ws!.frameStep = d.n;
          if (!synced) {
            if (d.total && !v.data.steps && this.ctx.role === 'teacher') this.ctx.store.updateObj(this.pageId, o.id, { steps: d.total });
            if (d.n === (v.data.step || 1)) synced = true;
            else post({ type: 'kwd:goto', n: v.data.step || 1 });
            return;
          }
          if (this.ctx.canDrive() && (d.n !== v.data.step || (d.total && d.total !== v.data.steps))) {
            this.ctx.store.updateObj(this.pageId, o.id, { step: d.n, ...(d.total ? { steps: d.total } : {}) });
            this.ctx.onHtmlEvent(this.pageId, o.mid || '', { type: 'kwd:event', name: 'step', value: d.n });
          }
        } else if (t === 'kwd:state' && d.key && this.ctx.canDrive()) {
          if (JSON.stringify(states.get(d.key)) !== JSON.stringify(d.val)) this.ctx.store.doc.transact(() => states.set(d.key!, d.val), 'ws');
        }
      };
      const onState = (ev: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
        if (tr.local) return;
        for (const key of ev.keysChanged) post({ type: 'kwd:state', key, val: states.get(key) });
      };
      states.observe(onState);
      window.addEventListener('message', onMsg);
      (v as ObjView & { off?: () => void }).off = () => {
        window.removeEventListener('message', onMsg);
        states.unobserve(onState);
        v.ws?.objs?.destroy();
      };
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
      v.el.classList.add('resizing'); // 끄는 동안 안쪽 창(iframe)이 마우스를 가로채지 않게
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
        v.el.classList.remove('resizing');
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

// 유튜브 주소 → 영상 id (watch?v=, youtu.be/, shorts/, embed/)
export function youtubeId(url: string): string | null {
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(url.trim());
  if (m) return m[1];
  return /^[\w-]{11}$/.test(url.trim()) ? url.trim() : null;
}
