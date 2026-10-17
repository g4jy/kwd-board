// 판 화면 (시제품 3): 페이지 모델 + 펜 프리셋 + 자료 페이지 + 기록 묶음 + 학생 메모리
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { BoardStore, randomId, getServerUrl, setServerUrl, getToken, setToken, upsertIndex, loadIndex, LOCAL, TEXT_W, TEXT_H, type Role, type PageInfo, type InkTarget } from './store';
import { Viewport } from './viewport';
import { InkLayer, CURSOR_ARROW, CURSOR_TEXT, type Tool, type PageBox } from './ink';
import { PageObjects, BOX_W, type ObjectHost } from './objects';
import { createPageEditor, insertImageFiles, fileToDataUrl, makeHintPlugin, hintKey, ROLE_COLORS, ROLE_NAMES, type HintWord } from './editor';
import { summarize } from './exportmd';
import { buildBundle, bundleName, boardMarkdown, canPickFolder, pickFolder, folderName, writeToFolder } from './record';
import { importPdf, importHtml, htmlWithBridge, joinText } from './importer';
import { loadPrefs, savePrefs, penSlot, renderSlot, buildPenPopover, type PenPrefs } from './palette';
import { loadMemory, cacheSet, normalize, headerLines, vocabNote, SAMPLE_MEMORY, type StudentMemory } from './memory';
import { folderForBoard, folderState, reopenFolder, briefFor, loadPack, buildMemory, readPackFile, type StudentPack, type PackFile } from './kwdfolder';
import { renderStudentPanel, type PanelTab } from './studentpanel';
import { h, download, downloadBlob, fmtDate, fmtClock, toast, EMBEDDED } from './ui';

const GAP = 28; // 페이지 사이
const COLORS = { red: '#d32f2f', blue: '#1565c0', green: '#2e7d32' };

export interface BoardParams {
  id: string;
  role: Role;
  student?: string;
  server?: string;
  token?: string;
}

interface PageView {
  info: PageInfo;
  el: HTMLElement;
  editorHost?: HTMLElement;
  editor?: Editor;
  bg?: HTMLElement;
  objs?: PageObjects;
  y: number;
  h: number;
}

export class BoardScreen {
  readonly root: HTMLElement;
  readonly store: BoardStore;
  private role: Role;
  private params: BoardParams;
  private vp!: Viewport;
  private ink!: InkLayer;
  private undo!: Y.UndoManager;
  private stage!: HTMLElement;
  private world!: HTMLElement;
  private pagesHost!: HTMLElement;
  private views = new Map<string, PageView>();
  private order: string[] = [];
  readonly editors = new Map<string, Editor>();
  private activeEditor: Editor | null = null;
  private currentPage = '';
  private tool: Tool = 'text';
  private prefs: PenPrefs;
  private following = true;
  private teacherView: { cx: number; cy: number; s: number; w: number; h: number; page?: string; mode?: string } | null = null;
  private memory: StudentMemory | null = null;
  // UI
  private toolbar!: HTMLElement;
  private rail!: HTMLElement;
  private zoomEl!: HTMLElement;
  private chip!: HTMLElement;
  private timerEl!: HTMLElement;
  private followBtn!: HTMLElement;
  private bubble!: HTMLElement;
  private popover: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private memPanel: HTMLElement | null = null;
  private memBtn!: HTMLElement;
  private singleNav!: HTMLElement;
  private saveDot!: HTMLElement;
  private disposers: Array<() => void> = [];
  private clockTimer = 0;
  private autosaveTimer = 0;
  private lastViewportPush = 0;
  private pushTimer = 0;
  private lastBundleAt = 0;
  private rotateHinted = false;
  private selObj: { page: string; id: string } | null = null;
  private objHost!: ObjectHost;
  private pack: StudentPack | null = null;
  private packTab: PanelTab = 'today';
  private packFolder = '';

  constructor(params: BoardParams) {
    this.params = params;
    this.role = params.role;
    if (params.server && params.server !== getServerUrl()) setServerUrl(params.server);
    if (params.token && params.role === 'teacher') setToken(params.token);
    this.store = new BoardStore(params.id, params.role, params.server || getServerUrl());
    this.prefs = loadPrefs(params.role);
    this.root = h('div', { class: `board role-${params.role}` });
    this.root.style.setProperty('--cur-arrow', CURSOR_ARROW);
    this.root.style.setProperty('--cur-text', CURSOR_TEXT);
    this.build();
    void this.afterLoad();
  }

  // ================= 구성 =================
  private build() {
    this.stage = h('div', { class: 'stage' });
    this.world = h('div', { class: 'world' });
    this.pagesHost = h('div', { class: 'pages' });
    const canvas = h('canvas', { class: 'ink' }) as HTMLCanvasElement;
    this.world.append(this.pagesHost);
    this.stage.append(this.world, canvas);
    this.vp = new Viewport(this.stage, this.world);
    this.vp.clamp = (v) => this.clampView(v);

    // 글·잉크 한 스택 되돌리기 (페이지가 생기면 scope 에 더한다)
    this.undo = new Y.UndoManager([this.store.pages], { trackedOrigins: new Set([ySyncPluginKey, LOCAL]), captureTimeout: 400 });
    this.store.beforeInkChange = () => this.undo.stopCapturing();

    this.objHost = {
      store: this.store,
      role: this.role,
      undo: this.undo,
      scale: () => this.vp.view.s,
      canEdit: () => this.role === 'teacher' || (this.role === 'student' && this.store.getSetting('studentWrite', false)),
      canType: () => this.role === 'teacher' || (this.role === 'student' && this.store.getSetting('studentWrite', false)),
      interactive: () => this.tool === 'text' || this.tool === 'select',
      selectMode: () => this.tool === 'select',
      selected: () => this.selObj?.id || null,
      select: (page, id) => this.selectObj(page, id),
      onText: (page, block, kind, text) => this.store.logText(page, block, kind, text),
      onBoxFocus: (ed, page) => {
        this.activeEditor = ed;
        this.currentPage = page;
      },
      onHtmlEvent: (page, mid, d) => {
        if (d.type === 'kwd:event') this.store.log({ kind: 'interaction', page, id: mid, data: { name: d.name, value: d.value, score: d.score } });
        else if (d.type === 'kwd:text' && this.role === 'teacher' && d.text && mid) {
          const cur = this.store.matdata.get(`${mid}/1`);
          if (cur && !cur.text?.length) this.store.doc.transact(() => this.store.matdata.set(`${mid}/1`, { ...cur, text: [{ s: d.text!.slice(0, 4000), x: 0, y: 0, w: cur.w, h: cur.h }] }), 'import');
        }
      },
    };
    this.ink = new InkLayer(canvas, this.store, this.vp);
    this.ink.getPages = () => this.pageBoxes();
    this.ink.canDraw = () => this.role !== 'student' || this.store.getSetting('studentInk', false);
    this.ink.locate = (page, pts, screen) => this.locateInk(page, pts, screen);
    this.ink.straighten = this.prefs.straighten;

    const back = h('button', { type: 'button', class: 'back-btn', title: '판 목록으로 (저장은 자동)' }, '← 목록');
    back.addEventListener('click', () => void this.leave());
    this.chip = h('button', { type: 'button', class: 'chip', title: '판 정보·링크' });
    this.saveDot = h('span', { class: 'save-dot', title: '기록' });
    const topLeft = h('div', { class: 'top-left' }, back, this.chip);
    if (this.role === 'student' || this.role === 'assist') back.hidden = true;
    this.timerEl = h('div', { class: 'timer', hidden: '' });
    this.memBtn = h('button', { type: 'button', class: 'mem-btn', hidden: '' }, '이 학생');
    this.memBtn.addEventListener('click', () => {
      if (this.packFolder && !this.pack) void this.loadFolderStudent(true);
      else this.toggleMemPanel();
    });
    const topRight = h('div', { class: 'top-right' }, this.timerEl, this.memBtn);
    this.followBtn = h('button', { type: 'button', class: 'follow-btn', hidden: '' }, '따라가기');
    this.followBtn.addEventListener('click', () => {
      this.following = true;
      this.followBtn.hidden = true;
      this.applyTeacherView();
    });
    this.bubble = h('div', { class: 'bubble', hidden: '' });
    this.toolbar = this.buildToolbar();
    this.rail = h('nav', { class: 'rail', 'aria-label': '페이지' });
    this.zoomEl = this.buildZoom();
    this.singleNav = this.buildSingleNav();

    this.root.append(this.stage, topLeft, topRight, this.rail, this.zoomEl, this.singleNav, this.followBtn, this.bubble, this.toolbar);
    this.chip.addEventListener('click', () => this.openLinks());

    this.bindViewport();
    this.bindSelectAndBoxes();
    this.bindAwareness();
    this.bindKeys();
    const pagesObs = () => this.syncPages();
    this.store.pages.observeDeep(pagesObs);
    this.disposers.push(() => this.store.pages.unobserveDeep(pagesObs));
    const setObs = () => this.applySettings();
    this.store.settings.observe(setObs);
    this.disposers.push(() => this.store.settings.unobserve(setObs));
    this.disposers.push(this.store.onStatus(() => this.renderChip()));
    this.clockTimer = window.setInterval(() => {
      this.renderChip();
      this.renderTimer();
    }, 1000);
    if (this.role === 'teacher') this.autosaveTimer = window.setInterval(() => void this.autosave(), 60_000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void this.autosave(true);
    };
    document.addEventListener('visibilitychange', onHide);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onHide));

    this.setTool('text');
    this.applySettings();

    (window as unknown as { __kwd?: unknown }).__kwd = {
      store: this.store,
      vp: this.vp,
      ink: this.ink,
      undo: this.undo,
      editors: this.editors,
      editor: () => this.activeEditor || this.editors.get(this.order.find((id) => this.views.get(id)?.info.kind === 'text') || ''),
      pages: () => this.store.pageList(),
      boxes: () => this.pageBoxes(),
      current: () => this.currentPage,
      following: () => this.following,
      tool: () => this.tool,
      prefs: () => this.prefs,
      memory: () => this.memory,
      bundle: () => buildBundle({ store: this.store, editors: this.editors }),
      importPdfBytes: (b64: string, name: string) => this.importPdfBytes(b64, name),
      importHtmlText: (html: string, name: string) => importHtml(this.store, html, name, this.order.indexOf(this.currentPage)),
      setMemory: (m: unknown) => this.setMemory(normalize(m, this.studentNo())),
      goto: (id: string) => this.gotoPage(id),
      placeHtml: (html: string, name: string) => this.placeHtml(html, name),
      addBox: (page: string, x: number, y: number) => this.addBox(page, x, y),
      objs: (page: string) => this.store.objList(page),
      selection: () => ({ ink: this.ink.selection, obj: this.selObj }),
      setTool: (t: Tool) => this.setTool(t),
    };
  }

  private studentNo(): string {
    return String(this.store.meta.get('student') || this.params.student || '');
  }

  private async afterLoad() {
    await this.store.whenLoaded();
    if (this.role === 'teacher') {
      if (this.params.student && !this.store.meta.get('student')) this.store.doc.transact(() => this.store.meta.set('student', this.params.student), 'meta');
      if (!this.store.meta.get('createdAt')) this.store.doc.transact(() => this.store.meta.set('createdAt', Date.now()), 'meta');
      if (this.store.pages.length === 0) {
        this.store.doc.transact(() => {
          const m = new Y.Map<unknown>();
          for (const [k, v] of Object.entries({ id: 'p1' + this.store.id.slice(0, 4), kind: 'text', w: TEXT_W, h: TEXT_H })) m.set(k, v);
          this.store.pages.push([m]);
        }, 'init');
      }
      this.touchIndex();
      this.store.meta.observe(() => this.touchIndex());
      const st = this.studentNo();
      this.packFolder = folderForBoard(this.store.id);
      if (this.packFolder) void this.loadFolderStudent(false);
      else {
        const { mem } = await loadMemory(st);
        if (mem) this.setMemory(mem);
      }
    }
    this.syncPages();
    // 폰 학생은 처음부터 큰 글씨 (46% 축소면 글이 8px 남짓)
    if (this.role === 'student' && window.innerWidth < 640) this.setReflow(true);
    this.initialView();
    this.renderChip();
    if (this.role === 'teacher') {
      const first = this.editors.get(this.order[0]);
      window.setTimeout(() => first?.commands.focus('end'), 60);
    }
    this.store.log({ kind: 'presence', data: { op: 'join', ua: navigator.userAgent.slice(0, 80) } });
  }

  private touchIndex() {
    const prev = loadIndex().find((b) => b.id === this.params.id);
    upsertIndex({
      id: this.params.id,
      student: this.studentNo() || prev?.student || '',
      createdAt: Number(this.store.meta.get('createdAt') || prev?.createdAt || Date.now()),
      lastAt: Number(this.store.meta.get('lastAt') || prev?.lastAt || Date.now()),
    });
  }

  // ================= 페이지 =================
  private syncPages() {
    const list = this.store.pageList();
    const ids = list.map((p) => p.id);
    // 지워진 페이지
    for (const [id, v] of this.views) {
      if (!ids.includes(id)) {
        v.objs?.destroy();
        v.editor?.destroy();
        // 편집기를 없애면 Tiptap 이 공용 UndoManager 를 멈춘다 → 바로 되살린다
        (this.undo as unknown as { restore?: () => void }).restore?.();
        this.editors.delete(id);
        v.el.remove();
        this.views.delete(id);
      }
    }
    for (const info of list) {
      if (!this.views.has(info.id)) this.createPageView(info);
    }
    this.order = ids;
    // DOM 순서
    for (const id of ids) this.pagesHost.append(this.views.get(id)!.el);
    if (!this.currentPage || !ids.includes(this.currentPage)) this.currentPage = ids[0] || '';
    this.layout();
    this.renderRail();
  }

  private createPageView(info: PageInfo) {
    const el = h('section', { class: `page page-${info.kind}`, 'data-page': info.id });
    el.style.width = info.w + 'px';
    const view: PageView = { info, el, y: 0, h: info.h };
    if (info.kind === 'text') {
      const host = h('div', { class: 'page-text' });
      el.append(host);
      view.editorHost = host;
      this.undo.addToScope([this.store.fragment(info.id), this.store.ink(info.id)]);
      const isFirst = this.store.pageIndex(info.id) === 0;
      const editor = createPageEditor(host, this.store, info.id, this.role, this.undo, {
        onText: (block, kind, text) => this.store.logText(info.id, block, kind, text),
        onEvent: (kind, data) => this.store.log({ kind, page: info.id, data }),
        scrollToSelection: (c) => this.keepVisible(c),
        onImageFiles: (files) => {
          void this.insertImages(files, info.id);
          return true;
        },
        onFocus: () => {
          this.activeEditor = editor;
          this.currentPage = info.id;
          this.renderRail();
        },
      }, isFirst ? '여기에 바로 치세요. # 제목, 1. 리스트, ___ 빈칸' : '');
      view.editor = editor;
      this.editors.set(info.id, editor);
      editor.on('selectionUpdate', () => this.renderBubble(editor));
      editor.on('blur', () => window.setTimeout(() => !this.bubble.contains(document.activeElement) && !this.bubble.matches(':hover') && this.hideBubble(), 150));
      editor.on('update', () => this.layoutSoon());
      if (this.memory && this.role === 'teacher') this.attachHints(editor);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.layoutSoon()).observe(host);
    } else {
      this.undo.addToScope([this.store.ink(info.id)]);
      el.style.height = info.h + 'px';
      const bg = h('div', { class: 'page-bg' });
      el.append(bg);
      view.bg = bg;
      this.renderMaterial(view);
    }
    const label = h('div', { class: 'page-no' });
    el.append(label);
    view.objs = new PageObjects(info.id, el, this.objHost);
    this.store.objs(info.id).observe(() => this.layoutSoon());
    this.views.set(info.id, view);
  }

  private renderMaterial(view: PageView) {
    const { mid, n } = view.info;
    const data = this.store.matdata.get(`${mid}/${n}`);
    const bg = view.bg!;
    bg.innerHTML = '';
    if (!data) {
      bg.append(h('div', { class: 'mat-wait' }, '자료를 받는 중…'));
      const obs = () => {
        if (this.store.matdata.get(`${mid}/${n}`)) {
          this.store.matdata.unobserve(obs);
          this.renderMaterial(view);
        }
      };
      this.store.matdata.observe(obs);
      return;
    }
    if (data.html != null) {
      const frame = h('iframe', { class: 'mat-frame', sandbox: 'allow-scripts allow-forms', title: '자료' }) as HTMLIFrameElement;
      frame.srcdoc = htmlWithBridge(data.html);
      bg.append(frame);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
        const d = e.data as { type?: string; name?: string; value?: unknown; score?: unknown; text?: string };
        if (d.type === 'kwd:event') this.store.log({ kind: 'interaction', page: view.info.id, id: mid, data: { name: d.name, value: d.value, score: d.score } });
        else if (d.type === 'kwd:text' && this.role === 'teacher' && d.text) {
          const cur = this.store.matdata.get(`${mid}/${n}`);
          if (cur && !cur.text?.length) this.store.doc.transact(() => this.store.matdata.set(`${mid}/${n}`, { ...cur, text: [{ s: d.text!.slice(0, 4000), x: 0, y: 0, w: cur.w, h: cur.h }] }), 'import');
        }
      };
      window.addEventListener('message', onMsg);
      this.disposers.push(() => window.removeEventListener('message', onMsg));
    } else if (data.img) {
      const img = h('img', { class: 'mat-img', alt: '', draggable: 'false' }) as HTMLImageElement;
      img.src = this.store.resolveImg(data.img);
      bg.append(img);
    }
  }

  private layoutTimer = 0;
  private layoutSoon() {
    window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => this.layout(), 30);
  }

  private single(): boolean {
    return this.store.getSetting<string>('viewMode', 'scroll') === 'single';
  }

  private layout() {
    let y = 0;
    const single = this.single();
    this.order.forEach((id, i) => {
      const v = this.views.get(id)!;
      let hgt = v.info.h;
      if (v.info.kind === 'text' && v.editorHost) {
        const content = v.editorHost.scrollHeight + 160;
        let objBottom = 0;
        for (const o of this.store.objList(id)) objBottom = Math.max(objBottom, o.y + o.h + 120);
        hgt = Math.max(TEXT_H, Math.ceil(Math.max(content, objBottom) / 40) * 40);
        v.el.style.height = hgt + 'px';
      }
      v.h = hgt;
      v.y = single ? 0 : y;
      v.el.style.transform = `translate(0px, ${v.y}px)`;
      const hidden = single && id !== this.currentPage;
      v.el.classList.toggle('off', hidden);
      (v.el.querySelector('.page-no') as HTMLElement).textContent = this.pageLabel(id, i);
      if (!single) y += hgt + GAP;
    });
    this.pagesHost.style.height = Math.max(0, y - GAP) + 'px';
    this.ink.invalidate();
    this.vp.set({});
  }

  private pageLabel(id: string, i: number): string {
    const v = this.views.get(id)!;
    if (v.info.kind === 'material' && v.info.mid) {
      const m = this.store.materials.get(v.info.mid);
      return `${i + 1} · ${m?.name || '자료'} (원본 ${v.info.n}/${m?.pages || ''})`;
    }
    return String(i + 1);
  }

  pageBoxes(): PageBox[] {
    const single = this.single();
    return this.order.map((id) => {
      const v = this.views.get(id)!;
      const reflowHide = v.info.kind === 'text' && this.root.classList.contains('reflow');
      return { id, x: 0, y: v.y, w: v.info.w, h: v.h, visible: (!single || id === this.currentPage) && !reflowHide };
    });
  }

  private totalHeight(): number {
    if (this.single()) return this.views.get(this.currentPage)?.h || TEXT_H;
    const last = this.views.get(this.order[this.order.length - 1]);
    return last ? last.y + last.h : TEXT_H;
  }

  // 스크롤 한계: 첫 페이지 위 · 마지막 페이지 아래로 반 화면까지만
  private clampView(v: { x: number; y: number; s: number }) {
    const r = this.stage.getBoundingClientRect();
    const W = r.width || window.innerWidth;
    const H = r.height || window.innerHeight;
    const contentW = TEXT_W * v.s;
    const contentH = this.totalHeight() * v.s;
    let { x, y } = v;
    // '이 학생' 패널이 열려 있으면 페이지를 왼쪽 빈 곳 가운데로 (패널이 글을 가리지 않게)
    const side = this.panelSide();
    if (contentW <= W - side - 8) x = (W - side - contentW) / 2 - (this.rail && !this.rail.hidden && W > 900 && !side ? 30 : 0);
    else if (side && contentW <= W - 8) x = Math.max(8, W - side - 12 - contentW);
    else x = Math.min(W * 0.3, Math.max(W * 0.7 - contentW, x));
    const top = H * 0.35;
    y = Math.min(top, Math.max(H * 0.5 - contentH, y));
    return { x, y, s: v.s };
  }

  private panelSide(): number {
    if (!this.memPanel || this.memPanel.hidden) return 0;
    const W = this.stage.getBoundingClientRect().width || window.innerWidth;
    if (W < 900) return 0;
    return this.memPanel.getBoundingClientRect().width + 64;
  }

  private renderRail() {
    if (this.role === 'student' && window.innerWidth < 700) {
      this.rail.hidden = true;
      return;
    }
    this.rail.innerHTML = '';
    this.order.forEach((id, i) => {
      const v = this.views.get(id)!;
      const b = h('button', { type: 'button', class: 'rail-item' + (id === this.currentPage ? ' on' : '') + (v.info.kind === 'material' ? ' mat' : ''), title: this.pageLabel(id, i), 'data-page': id }, String(i + 1));
      b.addEventListener('click', () => this.gotoPage(id));
      this.rail.append(b);
    });
    if (this.role === 'teacher') {
      const add = h('button', { type: 'button', class: 'rail-add', title: '이 페이지 다음에 빈 페이지' }, '+');
      add.addEventListener('click', () => this.addTextPage());
      this.rail.append(add);
    }
  }

  addTextPage() {
    const idx = this.order.indexOf(this.currentPage);
    const p = this.store.addPage({ kind: 'text', w: TEXT_W, h: TEXT_H }, idx + 1);
    this.store.log({ kind: 'page', page: p.id, data: { op: 'add', kind: 'text', index: idx + 1 } });
    this.syncPages();
    this.gotoPage(p.id);
    const ed = this.editors.get(p.id);
    if (ed && this.role === 'teacher') {
      this.activeEditor = ed;
      this.setTool('text');
      ed.commands.focus('start');
      this.activeEditor = ed;
      window.setTimeout(() => ed.commands.focus('start'), 30);
    }
  }

  gotoPage(id: string, log = true) {
    const v = this.views.get(id);
    if (!v) return;
    const prev = this.currentPage;
    this.currentPage = id;
    if (this.single()) this.layout();
    const [W, H] = this.vp.size();
    if (this.single()) {
      const sideW = W > 900 ? 120 : 16;
      const s = v.info.kind === 'material' ? Math.min((W - sideW) / v.info.w, (H - 150) / v.h, 2) : Math.min((W - sideW) / v.info.w, 1.2);
      const y = v.info.kind === 'material' ? Math.max(64, (H - v.h * s) / 2) : 70;
      this.vp.set({ s, x: (W - v.info.w * s) / 2, y });
    } else {
      this.vp.set({ y: 70 - v.y * this.vp.view.s });
    }
    this.renderRail();
    if (log && prev !== id && this.role === 'teacher') this.store.log({ kind: 'page', page: id, data: { op: 'show', index: this.order.indexOf(id) + 1 } });
    this.pushViewport();
  }

  private updateCurrentFromView() {
    if (this.single()) return;
    const [, H] = this.vp.size();
    const [, cy] = this.vp.toWorld(0, this.stage.getBoundingClientRect().top + H * 0.4);
    let best = this.currentPage;
    for (const id of this.order) {
      const v = this.views.get(id)!;
      if (cy >= v.y - GAP && cy <= v.y + v.h) {
        best = id;
        break;
      }
    }
    if (best !== this.currentPage) {
      const prev = this.currentPage;
      this.currentPage = best;
      this.renderRail();
      if (prev && this.role === 'teacher') this.store.log({ kind: 'page', page: best, data: { op: 'show', index: this.order.indexOf(best) + 1 } });
    }
  }

  // ================= 뷰포트 =================
  private initialView() {
    const [w] = this.vp.size();
    const s = w < 700 ? (w - 16) / TEXT_W : 1;
    this.vp.set({ s, x: 0, y: w < 700 ? 64 : 70 });
  }

  private buildZoom(): HTMLElement {
    const box = h('div', { class: 'zoom' });
    const minus = h('button', { type: 'button', class: 'zb', title: '축소 (Ctrl −)' }, '−');
    const pct = h('button', { type: 'button', class: 'zb pct', title: '폭 맞춤' }, '100%');
    const plus = h('button', { type: 'button', class: 'zb', title: '확대 (Ctrl +)' }, '+');
    const center = () => {
      const r = this.stage.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2] as const;
    };
    minus.addEventListener('click', () => {
      const [cx, cy] = center();
      this.vp.zoomAt(cx, cy, 1 / 1.2);
      this.userMovedView();
    });
    plus.addEventListener('click', () => {
      const [cx, cy] = center();
      this.vp.zoomAt(cx, cy, 1.2);
      this.userMovedView();
    });
    pct.addEventListener('click', () => this.fitWidth());
    box.append(minus, pct, plus);
    if (this.role === 'student') {
      // 폰에서 글이 작을 때: 이 기기에서만 글을 크게 다시 흘린다 (글 페이지의 필기는 원래 크기에서만 보임)
      const rf = h('button', { type: 'button', class: 'reflow-btn', title: '큰 글씨 (이 기기만)' }, '큰 글씨');
      this.reflowBtn = rf;
      rf.addEventListener('click', () => {
        this.setReflow(!this.root.classList.contains('reflow'));
        toast(this.root.classList.contains('reflow') ? '큰 글씨로 보는 중 · 글 위 필기는 끄면 보여요' : '원래 크기로 보는 중');
      });
      box.prepend(rf);
    }
    this.vp.onChange((v) => (pct.textContent = Math.round(v.s * 100) + '%'));
    return box;
  }

  private reflowBtn: HTMLElement | null = null;
  setReflow(on: boolean) {
    this.root.classList.toggle('reflow', on);
    this.reflowBtn?.classList.toggle('on', on);
    this.layout();
  }

  fitWidth() {
    const [W] = this.vp.size();
    const s = Math.min(1.6, (W - (W > 900 ? 120 : 16)) / TEXT_W);
    const [, cy] = this.vp.toWorld(0, this.stage.getBoundingClientRect().top + 80);
    this.vp.set({ s, y: 80 - cy * s });
  }

  private buildSingleNav(): HTMLElement {
    const box = h('div', { class: 'single-nav', hidden: '' });
    const prev = h('button', { type: 'button', class: 'sn', title: '이전 (←)' }, '‹');
    const label = h('span', { class: 'sn-label' });
    const next = h('button', { type: 'button', class: 'sn', title: '다음 (→)' }, '›');
    prev.addEventListener('click', () => this.step(-1));
    next.addEventListener('click', () => this.step(1));
    box.append(prev, label, next);
    if (this.role === 'teacher') {
      const exit = h('button', { type: 'button', class: 'sn-exit', title: '스크롤로 보기' }, '전체 보기');
      exit.addEventListener('click', () => this.store.setSetting('viewMode', 'scroll'));
      box.append(exit);
    }
    return box;
  }

  step(d: number) {
    const i = this.order.indexOf(this.currentPage);
    const j = Math.max(0, Math.min(this.order.length - 1, i + d));
    if (j !== i) this.gotoPage(this.order[j]);
  }

  private bindViewport() {
    const stage = this.stage;
    stage.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement).closest?.('.mat-frame')) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.vp.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
        else this.vp.panBy(-e.deltaX, -e.deltaY);
        this.userMovedView();
      },
      { passive: false },
    );
    stage.addEventListener('scroll', () => {
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
    });
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; cx: number; cy: number } | null = null;
    let pan: { x: number; y: number; active: boolean; moved: boolean; sx: number } | null = null;
    let mouse: { x: number; y: number } | null = null;
    const inEditable = (t: EventTarget | null) => t instanceof Node && !!(t as HTMLElement).closest?.('.page-text') && this.role === 'teacher';
    stage.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'mouse') {
          const onPage = e.target instanceof Element && e.target.closest('.page');
          if (e.button === 1 || (e.button === 0 && !onPage && this.tool === 'text')) {
            mouse = { x: e.clientX, y: e.clientY };
            if (e.button === 1) e.preventDefault();
          }
          return;
        }
        if (e.pointerType !== 'touch') return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = Array.from(touches.values());
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          pan = null;
        } else if (touches.size === 1) {
          const drawing = this.tool !== 'text' && this.ink.canDraw() && this.ink.isDrawPointer(e);
          pan = { x: e.clientX, y: e.clientY, active: !drawing && !(inEditable(e.target) && this.editors.size > 0 && this.activeEditor?.isEditable), moved: false, sx: e.clientX };
          if (drawing) pan.active = false;
        }
      },
      { capture: true },
    );
    stage.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'mouse') {
          if (mouse && e.buttons) {
            this.vp.panBy(e.clientX - mouse.x, e.clientY - mouse.y);
            mouse = { x: e.clientX, y: e.clientY };
            this.userMovedView();
          }
          return;
        }
        if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size === 2) {
          const [a, b] = Array.from(touches.values());
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          this.vp.zoomAt(pinch.cx, pinch.cy, d / (pinch.d || 1));
          this.vp.panBy(cx - pinch.cx, cy - pinch.cy);
          pinch = { d, cx, cy };
          this.userMovedView();
          e.preventDefault();
        } else if (pan && pan.active && touches.size === 1) {
          const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
          if (!pan.moved && Math.hypot(dx, dy) < 6) return;
          pan.moved = true;
          this.vp.panBy(this.single() ? 0 : dx, dy);
          pan.x = e.clientX;
          pan.y = e.clientY;
          this.userMovedView();
          e.preventDefault();
        }
      },
      { capture: true, passive: false },
    );
    const end = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        mouse = null;
        return;
      }
      if (pan && pan.moved && this.single() && this.role !== 'student') {
        const dx = e.clientX - pan.sx;
        if (Math.abs(dx) > 60) this.step(dx < 0 ? 1 : -1);
      }
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) pan = null;
    };
    stage.addEventListener('pointerup', end, { capture: true });
    stage.addEventListener('pointercancel', end, { capture: true });
    this.vp.onChange(() => {
      this.pushViewport();
      this.updateCurrentFromView();
      if (!this.bubble.hidden && this.activeEditor) this.positionBubble(this.activeEditor);
    });
    const onResize = () => {
      if (this.role !== 'teacher' && this.following) this.applyTeacherView();
      else this.vp.set({});
      this.renderRail();
    };
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
  }

  // 선택 도구(획 고르기·옮기기·네모로 여러 개) + 글상자 만들기 + 웹 학습지 위 휠
  private bindSelectAndBoxes() {
    const stage = this.stage;
    let op: { kind: 'drag' | 'band'; sx: number; sy: number; wx: number; wy: number; moved: boolean; id: number } | null = null;
    stage.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'select' || this.role !== 'teacher') return;
      if (e.pointerType === 'touch' || e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('.obj, .toolbar, .rail, .zoom, .bubble, .menu, .pen-pop, .mem-panel')) return;
      const [wx, wy] = this.vp.toWorld(e.clientX, e.clientY);
      const sb = this.ink.selectionBox();
      let kind: 'drag' | 'band' = 'band';
      if (sb && wx >= sb[0] - 8 && wx <= sb[2] + 8 && wy >= sb[1] - 8 && wy <= sb[3] + 8) kind = 'drag';
      else {
        const hit = this.ink.hitStroke(wx, wy);
        if (hit) {
          this.selObj = null;
          for (const v of this.views.values()) v.objs?.refreshSelection();
          this.ink.selection = { page: hit.page, ids: [hit.id], dx: 0, dy: 0 };
          kind = 'drag';
        }
      }
      if (kind === 'band') this.ink.band = { x0: wx, y0: wy, x1: wx, y1: wy };
      op = { kind, sx: e.clientX, sy: e.clientY, wx, wy, moved: false, id: e.pointerId };
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.ink.invalidate();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!op || e.pointerId !== op.id) return;
      if (!op.moved && Math.hypot(e.clientX - op.sx, e.clientY - op.sy) < 3) return;
      op.moved = true;
      const [wx, wy] = this.vp.toWorld(e.clientX, e.clientY);
      if (op.kind === 'drag' && this.ink.selection) {
        this.ink.selection.dx = wx - op.wx;
        this.ink.selection.dy = wy - op.wy;
      } else if (this.ink.band) {
        this.ink.band.x1 = wx;
        this.ink.band.y1 = wy;
      }
      this.ink.invalidate();
    });
    const end = (e: PointerEvent) => {
      if (!op || e.pointerId !== op.id) return;
      const o = op;
      op = null;
      try {
        stage.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (o.kind === 'drag') {
        const sel = this.ink.selection;
        if (sel && o.moved && (sel.dx || sel.dy)) {
          const { page, ids, dx, dy } = sel;
          sel.dx = sel.dy = 0;
          this.store.moveStrokes(page, ids, dx, dy);
        }
        this.ink.invalidate();
        return;
      }
      const b = this.ink.band;
      this.ink.band = null;
      if (!b || !o.moved) {
        this.clearSelection();
        return;
      }
      const found = this.ink.strokesInRect(b.x0, b.y0, b.x1, b.y1);
      let best: [string, string[]] | null = null;
      for (const ent of found) if (!best || ent[1].length > best[1].length) best = ent;
      if (best) {
        this.selObj = null;
        this.ink.selection = { page: best[0], ids: best[1], dx: 0, dy: 0 };
      } else {
        this.ink.selection = null;
        const [ax, bx] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
        const [ay, by] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
        for (const pb of this.pageBoxes()) {
          const ids = this.views.get(pb.id)?.objs?.idsInRect(ax - pb.x, ay - pb.y, bx - pb.x, by - pb.y) || [];
          if (ids.length) {
            this.selectObj(pb.id, ids[0]);
            break;
          }
        }
      }
      for (const v of this.views.values()) v.objs?.refreshSelection();
      this.ink.invalidate();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    // 글상자: 빈 곳 두 번 누르기 (글·선택 도구) · 자료 페이지는 한 번 (글 도구)
    const emptySpot = (t: HTMLElement) => {
      if (t.closest('.obj, .mat-frame')) return false;
      if (t.classList.contains('board-doc') || t.classList.contains('page-text') || t.classList.contains('page') || t.classList.contains('page-bg') || t.classList.contains('mat-img') || t.classList.contains('page-objs')) return true;
      return false;
    };
    const canMake = () => this.role === 'teacher' || (this.role === 'student' && this.store.getSetting('studentWrite', false));
    let wasTypingInBox = false;
    stage.addEventListener(
      'pointerdown',
      () => {
        wasTypingInBox = !!(document.activeElement as HTMLElement | null)?.closest?.('.obj-box-text');
      },
      { capture: true },
    );
    this.pagesHost.addEventListener('dblclick', (e) => {
      if ((this.tool !== 'text' && this.tool !== 'select') || !canMake()) return;
      const t = e.target as HTMLElement;
      if (!emptySpot(t)) return;
      const at = this.pageAt(e.clientX, e.clientY);
      if (!at) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.addBox(at.page, at.x, at.y);
    });
    this.pagesHost.addEventListener('click', (e) => {
      if (this.tool !== 'text' || !canMake() || wasTypingInBox) return;
      const t = e.target as HTMLElement;
      if (!t.closest('.page-material') || !emptySpot(t)) return;
      const at = this.pageAt(e.clientX, e.clientY);
      if (at) this.addBox(at.page, at.x, at.y);
    });

    // 웹 학습지 안에서 보낸 휠: Ctrl·핀치 = 판 확대, 그 밖 = 판 이동
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; dx?: number; dy?: number; x?: number; y?: number; ctrl?: boolean } | null;
      if (!d || typeof d !== 'object' || d.type !== 'kwd:wheel') return;
      const frame = Array.from(this.root.querySelectorAll('iframe')).find((f) => f.contentWindow === e.source);
      if (!frame) return;
      const r = frame.getBoundingClientRect();
      const k = r.width / (frame.offsetWidth || r.width || 1);
      const sx = r.left + (d.x || 0) * k, sy = r.top + (d.y || 0) * k;
      if (d.ctrl) this.vp.zoomAt(sx, sy, Math.exp(-(d.dy || 0) * 0.0015));
      else this.vp.panBy(-(d.dx || 0), -(d.dy || 0));
      this.userMovedView();
    };
    window.addEventListener('message', onMsg);
    this.disposers.push(() => window.removeEventListener('message', onMsg));
  }

  private wheelLock = 0;
  private wheelStep(dy: number) {
    const now = performance.now();
    if (now - this.wheelLock < 350) return;
    this.wheelLock = now;
    this.step(dy > 0 ? 1 : -1);
  }

  private keepVisible(c: { left: number; top: number; bottom: number }) {
    const r = this.stage.getBoundingClientRect();
    let dx = 0, dy = 0;
    if (c.top < r.top + 70) dy = r.top + 70 - c.top;
    else if (c.bottom > r.bottom - 110) dy = r.bottom - 110 - c.bottom;
    if (c.left < r.left + 24) dx = r.left + 24 - c.left;
    else if (c.left > r.right - 70) dx = r.right - 70 - c.left;
    if (dx || dy) this.vp.panBy(dx, dy);
  }

  private userMovedView() {
    if (this.role === 'teacher') return;
    if (this.following) {
      this.following = false;
      this.followBtn.hidden = false;
    }
  }

  private pushViewport() {
    if (this.role !== 'teacher') return;
    const now = performance.now();
    if (now - this.lastViewportPush < 80) {
      window.clearTimeout(this.pushTimer);
      this.pushTimer = window.setTimeout(() => this.pushViewport(), 90);
      return;
    }
    this.lastViewportPush = now;
    const [cx, cy] = this.vp.center();
    const [w, hh] = this.vp.size();
    this.store.awareness.setLocalStateField('viewport', { cx, cy, s: this.vp.view.s, w, h: hh, page: this.currentPage });
  }

  private applyTeacherView() {
    const t = this.teacherView;
    if (!t) return;
    if (t.page && t.page !== this.currentPage && this.views.has(t.page)) {
      this.currentPage = t.page;
      this.renderRail();
    }
    if (this.single()) {
      this.gotoPage(this.currentPage, false);
      return;
    }
    const [w] = this.vp.size();
    if (w < 700) this.vp.centerOn(TEXT_W / 2, t.cy, (w - 16) / TEXT_W);
    else this.vp.centerOn(t.cx, t.cy, Math.min(this.vp.max, Math.max(this.vp.min, t.s * (w / t.w))));
  }

  private bindAwareness() {
    this.store.awareness.setLocalStateField('role', this.role);
    this.store.awareness.setLocalStateField('user', { name: ROLE_NAMES[this.role], color: ROLE_COLORS[this.role] });
    const onChange = () => {
      let found: typeof this.teacherView = null;
      for (const [cid, st] of this.store.awareness.getStates()) {
        if (cid !== this.store.awareness.clientID && st?.role === 'teacher' && st.viewport) found = st.viewport;
      }
      if (found && JSON.stringify(found) !== JSON.stringify(this.teacherView)) {
        this.teacherView = found;
        if (this.role !== 'teacher' && this.following) this.applyTeacherView();
      }
      this.renderChip();
    };
    this.store.awareness.on('change', onChange);
    this.disposers.push(() => this.store.awareness.off('change', onChange));
  }

  private applySettings() {
    const studentWrite = this.store.getSetting('studentWrite', false);
    const studentInk = this.store.getSetting('studentInk', false);
    const studentMat = this.store.getSetting('studentMaterial', false);
    const showCaret = this.store.getSetting('showCaret', true);
    if (this.role === 'student') {
      for (const ed of this.editors.values()) ed.setEditable(studentWrite, false);
      for (const v of this.views.values()) v.objs?.setEditable(studentWrite);
      if (!studentInk && this.tool !== 'text') this.setTool('text');
      this.toolbar.hidden = !(studentWrite || studentInk);
      this.root.classList.toggle('tb-on', !this.toolbar.hidden);
      this.toolbar.classList.toggle('no-ink', !studentInk);
      this.root.classList.toggle('mat-locked', !studentMat);
    }
    if (this.role === 'assist') {
      for (const ed of this.editors.values()) ed.setEditable(false, false);
      for (const v of this.views.values()) v.objs?.setEditable(false);
      this.root.classList.add('mat-locked');
    }
    this.root.classList.toggle('hide-carets', !showCaret && this.role === 'student');
    const single = this.single();
    this.root.classList.toggle('mode-single', single);
    this.singleNav.hidden = !single;
    this.renderTimer();
    this.layout();
    if (single) this.gotoPage(this.currentPage, false);
    this.updateSingleLabel();
  }

  private updateSingleLabel() {
    const l = this.singleNav.querySelector('.sn-label');
    if (!l) return;
    const v = this.views.get(this.currentPage);
    const mat = v?.info.kind === 'material' && v.info.mid ? this.store.materials.get(v.info.mid) : null;
    l.textContent = '';
    l.append(`${this.order.indexOf(this.currentPage) + 1} / ${this.order.length}`);
    if (mat) l.append(h('span', { class: 'sn-name' }, ` · ${mat.name}`));
    // 세로 폰에서 자료 쪽: 한 번만 가로 보기 안내
    if (mat && this.role !== 'teacher' && !this.rotateHinted && window.innerWidth < 640 && window.innerHeight > window.innerWidth) {
      this.rotateHinted = true;
      toast('폰을 가로로 돌리면 자료가 크게 보여요', 4000);
    }
  }

  // ================= 도구 줄 =================
  private slots: HTMLElement[] = [];
  private buildToolbar(): HTMLElement {
    const bar = h('div', { class: 'toolbar' });
    const btn = (id: string, label: string, title: string, cls = '') => h('button', { type: 'button', class: `tb ${cls}`, 'data-tool': id, title }, label);
    const select = btn('select', '선택', '선택 (V) · 필기·사진·글상자를 골라 옮기기 · 빈 곳 끌면 여러 개');
    const text = btn('text', '글', '글 (T) · 빈 곳을 두 번 누르면 글상자');
    this.slots = [0, 1, 2].map((i) => penSlot(i, this.prefs.pens[i]));
    const hl = penSlot(3, this.prefs.hl, true);
    this.slots.push(hl);
    const eraser = btn('eraser', '지우개', '지우개 (E) · 한 번 더 누르면 크기');
    const undo = btn('undo', '↶', '되돌리기 (Ctrl+Z)', 'icon');
    const redo = btn('redo', '↷', '다시하기 (Ctrl+Shift+Z)', 'icon');
    const imp = btn('import', '가져오기', '사진 · PDF/슬라이드 · 웹 학습지');
    const more = btn('more', '⋯', '더보기', 'icon');
    const sep = () => h('span', { class: 'tb-sep' });
    const pens = h('span', { class: 'tb-pens' }, ...this.slots);
    if (this.role === 'teacher') bar.append(select, text, sep(), pens, eraser, sep(), undo, redo, sep(), imp, more);
    else if (this.role === 'assist') bar.append(pens, eraser, sep(), undo, redo);
    else bar.append(text, pens, eraser, undo);
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b.dataset.slot != null) return this.pickSlot(Number(b.dataset.slot), b);
      const id = b.dataset.tool;
      if (id === 'text') this.setTool('text');
      else if (id === 'select') this.setTool('select');
      else if (id === 'eraser') {
        if (this.tool === 'eraser') this.openPenPopover('eraser', b);
        else this.setTool('eraser');
      } else if (id === 'undo') this.undo.undo();
      else if (id === 'redo') this.undo.redo();
      else if (id === 'import') this.openImport(b);
      else if (id === 'more') this.openMenu(b);
    });
    bar.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });
    if (this.role === 'student') bar.hidden = true;
    return bar;
  }

  private pickSlot(i: number, anchor: HTMLElement) {
    const isHl = i === 3;
    const already = (isHl && this.tool === 'hl') || (!isHl && this.tool === 'pen' && this.prefs.active === i);
    if (already) return this.openPenPopover(isHl ? 'hl' : 'pen', anchor);
    if (!isHl) this.prefs.active = i;
    savePrefs(this.role, this.prefs);
    this.setTool(isHl ? 'hl' : 'pen');
  }

  private applyPenStyle() {
    if (this.tool === 'hl') this.ink.style = { color: this.prefs.hl.color, size: this.prefs.hl.size, hl: true, opacity: this.prefs.hl.opacity ?? 0.35 };
    else {
      const p = this.prefs.pens[this.prefs.active];
      this.ink.style = { color: p.color, size: p.size, hl: false, kind: p.kind };
    }
    this.ink.eraserSize = this.prefs.eraser;
    this.ink.straighten = this.prefs.straighten;
    this.ink.updateCursor();
  }

  private openPenPopover(kind: 'pen' | 'hl' | 'eraser', anchor: HTMLElement) {
    this.closePopover();
    const idx = this.prefs.active;
    const pop = buildPenPopover({
      kind,
      preset: kind === 'hl' ? this.prefs.hl : this.prefs.pens[idx],
      prefs: this.prefs,
      onChange: (p) => {
        if (kind === 'hl') this.prefs.hl = p;
        else this.prefs.pens[idx] = p;
        savePrefs(this.role, this.prefs);
        renderSlot(this.slots[kind === 'hl' ? 3 : idx], p, kind === 'hl');
        this.applyPenStyle();
      },
      onEraser: (s) => {
        this.prefs.eraser = s;
        savePrefs(this.role, this.prefs);
        this.applyPenStyle();
      },
      onClearPage: () => {
        this.store.clearInk(this.currentPage);
        this.closePopover();
        toast('이 페이지 잉크를 지웠어요 (↶로 되돌리기)');
      },
      onStraighten: (v) => {
        this.prefs.straighten = v;
        savePrefs(this.role, this.prefs);
        this.applyPenStyle();
      },
    });
    const wrap = h('div', { class: 'pop-wrap' });
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap) this.closePopover();
    });
    wrap.append(pop);
    this.root.append(wrap);
    this.popover = wrap;
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 300;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2)) + 'px';
    pop.style.bottom = window.innerHeight - r.top + 10 + 'px';
  }

  private closePopover() {
    this.popover?.remove();
    this.popover = null;
  }

  setTool(t: Tool) {
    this.tool = t;
    this.applyPenStyle();
    this.ink.setTool(t);
    this.root.dataset.tool = t;
    this.toolbar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b.dataset.slot != null) {
        const i = Number(b.dataset.slot);
        b.classList.toggle('on', (t === 'pen' && i === this.prefs.active) || (t === 'hl' && i === 3) || (t === 'laser' && i === this.prefs.active));
      } else if (b.dataset.tool) b.classList.toggle('on', b.dataset.tool === t);
    });
    this.closePopover();
    if (t !== 'select') this.clearSelection();
    for (const v of this.views.values()) v.objs?.refreshSelection();
    if (t === 'text') {
      // 지금 보는 페이지의 편집기에만 커서를 둔다 (다른 페이지로 튀지 않게)
      const ed = this.editors.get(this.currentPage);
      if (this.role === 'teacher' && ed) ed.commands.focus();
    } else {
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.hideBubble();
    }
  }

  private bindKeys() {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.undo.redo();
        else this.undo.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.undo.redo();
        return;
      }
      if (mod && (e.key === '=' || e.key === '+' || e.key === '-')) {
        e.preventDefault();
        const r = this.stage.getBoundingClientRect();
        this.vp.zoomAt(r.left + r.width / 2, r.top + r.height / 2, e.key === '-' ? 1 / 1.2 : 1.2);
        return;
      }
      if (e.key === 'Escape') {
        if (this.popover) this.closePopover();
        else if (this.selObj || this.ink.selection) this.clearSelection();
        else if (this.panel) this.closePanel();
        else if (this.tool !== 'text') this.setTool('text');
        return;
      }
      if (typing || this.role === 'student') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.deleteSelection()) {
        e.preventDefault();
        return;
      }
      if (this.single() && (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ')) {
        e.preventDefault();
        this.step(1);
      } else if (this.single() && (e.key === 'ArrowLeft' || e.key === 'PageUp')) {
        e.preventDefault();
        this.step(-1);
      } else if (e.key === 'p' || e.key === 'P' || e.key === '1') this.pickSlotKey(0);
      else if (e.key === '2') this.pickSlotKey(1);
      else if (e.key === '3') this.pickSlotKey(2);
      else if (e.key === 'h' || e.key === 'H') this.setTool('hl');
      else if (e.key === 'e' || e.key === 'E') this.setTool('eraser');
      else if (e.key === 't' || e.key === 'T') this.setTool('text');
      else if ((e.key === 'v' || e.key === 'V') && this.role === 'teacher') this.setTool('select');
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  private pickSlotKey(i: number) {
    this.prefs.active = i;
    savePrefs(this.role, this.prefs);
    this.setTool('pen');
  }

  // ================= 잉크 → 글자 (기획안 2.3) =================
  private locateInk(pageId: string, pts: number[], screen: Array<[number, number]>): InkTarget | undefined {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i + 2 < pts.length; i += 3) {
      xs.push(pts[i]);
      ys.push(pts[i + 1]);
    }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, hh = y1 - y0;
    const diag = Math.hypot(w, hh);
    const closeEnds = Math.hypot(xs[0] - xs[xs.length - 1], ys[0] - ys[ys.length - 1]) < Math.max(18, diag * 0.28);
    let pathLen = 0;
    for (let i = 1; i < xs.length; i++) pathLen += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    let shape: InkTarget['shape'] = 'free';
    if (hh < 22 && w > hh * 2.5 && w > 24) shape = 'underline';
    else if (closeEnds && w > 16 && hh > 12 && pathLen > diag * 1.8) shape = 'circle';
    else if (pathLen < diag * 1.25 && diag > 40) shape = 'line';
    else if (pathLen > diag * 3.5) shape = 'scribble';
    const v = this.views.get(pageId);
    if (!v) return { shape };
    const s = this.vp.view.s;
    if (v.info.kind === 'text' && v.editor) {
      const view = v.editor.view;
      // 화면 좌표에서 글 위치 찾기: 밑줄은 조금 위, 동그라미는 가운데 줄
      const toScreen = (px: number, py: number) => this.vp.toScreen(px, v.y + py);
      const rect = this.stage.getBoundingClientRect();
      const samples: Array<[number, number]> = [];
      if (shape === 'underline') {
        const yy = y0 - 10;
        for (let k = 0; k <= 8; k++) samples.push([x0 + 4 + ((w - 8) * k) / 8, yy]);
      } else if (shape === 'circle') {
        const yy = (y0 + y1) / 2;
        for (let k = 1; k < 8; k++) samples.push([x0 + (w * k) / 8, yy]);
      } else {
        for (let k = 0; k < screen.length; k += Math.max(1, Math.floor(screen.length / 10))) {
          const [sx, sy] = screen[k];
          samples.push([(sx - rect.left - this.vp.view.x) / s, (sy - rect.top - this.vp.view.y) / s - v.y]);
        }
      }
      let from = Infinity, to = -Infinity;
      for (const [px, py] of samples) {
        const [sx, sy] = toScreen(px, py);
        const r = view.posAtCoords({ left: sx + rect.left, top: sy + rect.top });
        if (!r || r.inside < 0) continue;
        from = Math.min(from, r.pos);
        to = Math.max(to, r.pos);
      }
      if (!isFinite(from)) return { shape };
      const doc = view.state.doc;
      const $f = doc.resolve(from);
      let blockNode = null as null | { attrs: Record<string, unknown>; textContent: string };
      for (let d = $f.depth; d >= 1; d--) {
        const n = $f.node(d);
        if (n.isTextblock) {
          blockNode = n;
          break;
        }
      }
      const text = to > from ? doc.textBetween(from, Math.min(to + 1, doc.content.size), ' ').trim() : '';
      if (shape === 'line' || shape === 'free' || shape === 'scribble') {
        if (shape !== 'line') return { shape, block: (blockNode?.attrs.bid as string) || undefined };
      }
      return { shape, block: (blockNode?.attrs.bid as string) || undefined, text: text.slice(0, 60) || undefined, ctx: blockNode?.textContent.slice(0, 80) };
    }
    // 자료 페이지: 글자층에서 겹치는 낱말
    const data = this.store.matdata.get(`${v.info.mid}/${v.info.n}`);
    if (data?.text?.length) {
      const pad = shape === 'underline' ? 14 : 2;
      const hit = data.text.filter((t) => t.x < x1 && t.x + t.w > x0 && t.y < y1 && t.y + t.h + pad > y0 - (shape === 'underline' ? 18 : 0));
      const txt = joinText(hit).replace(/\n/g, ' ').slice(0, 80);
      return { shape, text: txt || undefined, block: `mat:${v.info.mid}:${v.info.n}` };
    }
    return { shape, block: v.info.kind === 'material' ? `mat:${v.info.mid}:${v.info.n}` : undefined };
  }

  // ================= 선택 버블 =================
  private hideBubble() {
    this.bubble.hidden = true;
  }

  private renderBubble(editor: Editor) {
    if (this.role !== 'teacher' || this.tool !== 'text') return this.hideBubble();
    const sel = editor.state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === 'blank') return this.renderBlankBubble(editor, sel.from, sel.node.attrs as { answer: string });
    if (sel.empty) return this.hideBubble();
    const text = editor.state.doc.textBetween(sel.from, sel.to, ' ');
    if (!text.trim()) return this.hideBubble();
    const b = this.bubble;
    b.innerHTML = '';
    const mk = (label: string, title: string, fn: () => void, cls = '') => {
      const el = h('button', { type: 'button', class: 'bb ' + cls, title }, label);
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
      });
      return el;
    };
    const sw = (c: string, title: string) => {
      const el = mk('', title, () => editor.chain().focus().setColor(c).run(), 'sw');
      el.style.setProperty('--c', c);
      return el;
    };
    b.append(
      sw(COLORS.red, '빨강'),
      sw(COLORS.blue, '파랑'),
      sw(COLORS.green, '초록'),
      mk('형광', '형광', () => editor.chain().focus().toggleHighlight({ color: '#ffe866' }).run(), editor.isActive('highlight') ? 'on' : ''),
      mk('밑줄', '밑줄', () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline') ? 'on' : ''),
      mk('지움', '꾸밈 지우기', () => editor.chain().focus().unsetColor().unsetHighlight().unsetUnderline().run()),
      h('span', { class: 'sep' }),
      mk('빈칸', '고른 글자를 빈칸으로', () => {
        editor.chain().focus().selectionToBlank().run();
        this.hideBubble();
      }),
      mk('교정', '이 줄을 교정 블록으로', () => {
        editor.chain().focus().paragraphToCorrection().run();
        this.hideBubble();
      }),
      mk('변형 표', '기본형·해요·합니다·높임 표', () => {
        this.insertConjTable(editor, text.trim());
        this.hideBubble();
      }),
    );
    b.hidden = false;
    this.activeEditor = editor;
    this.positionBubble(editor);
  }

  private renderBlankBubble(editor: Editor, pos: number, attrs: { answer: string }) {
    const b = this.bubble;
    b.innerHTML = '';
    const input = h('input', { type: 'text', class: 'bb-input', placeholder: '정답', value: attrs.answer || '', lang: 'ko' }) as HTMLInputElement;
    const save = () => editor.commands.setBlankAttrs(pos, { answer: input.value.trim() });
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        editor.commands.focus();
        this.hideBubble();
      }
      e.stopPropagation();
    });
    const del = h('button', { type: 'button', class: 'bb', title: '빈칸을 글로 되돌리기' }, '풀기');
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', () => {
      const n = editor.state.doc.nodeAt(pos);
      if (!n) return;
      editor.chain().focus().insertContentAt({ from: pos, to: pos + n.nodeSize }, n.attrs.answer || n.attrs.value || '___').run();
      this.hideBubble();
    });
    b.append(h('span', { class: 'bb-label' }, '정답'), input, del);
    b.hidden = false;
    this.positionBubble(editor);
    window.setTimeout(() => input.focus(), 0);
  }

  private positionBubble(editor: Editor) {
    const { from, to } = editor.state.selection;
    let start, end;
    try {
      start = editor.view.coordsAtPos(from);
      end = editor.view.coordsAtPos(to);
    } catch {
      return this.hideBubble();
    }
    const b = this.bubble;
    const bw = b.offsetWidth || 320;
    const x = Math.min(window.innerWidth - bw - 8, Math.max(8, (start.left + end.right) / 2 - bw / 2));
    let y = start.top - b.offsetHeight - 10;
    if (y < 56) y = end.bottom + 10;
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
  }

  private insertConjTable(editor: Editor, base: string) {
    const cell = (t: string, header = false) => ({ type: header ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }] });
    const row = (cells: string[], header = false) => ({ type: 'tableRow', content: cells.map((c) => cell(c, header)) });
    const { $from } = editor.state.selection;
    const after = $from.depth >= 1 ? $from.after(1) : editor.state.doc.content.size;
    editor.chain().focus().insertContentAt(after, { type: 'table', content: [row(['기본형', '해요', '합니다', '높임'], true), row([base, '', '', ''])] }).run();
    this.store.log({ kind: 'table', page: this.currentPage, data: { base } });
  }

  // ================= 가져오기 =================
  private openImport(anchor: HTMLElement) {
    const menu = h('div', { class: 'menu import-menu' });
    const item = (label: string, sub: string, fn: () => void) => {
      const el = h('button', { type: 'button', class: 'mi' }, h('span', {}, label), h('span', { class: 'mi-sub' }, sub));
      el.addEventListener('click', () => {
        this.closePanel();
        fn();
      });
      return el;
    };
    menu.append(
      item('사진', '지금 페이지 위에 놓여요 · 끌어서 옮기고 모서리로 크기', () => this.pickFile('image/*', true, (files) => void this.insertImages(files))),
      item('PDF · 슬라이드', '한 쪽씩 페이지로 들어가요 · PPT는 PDF로 저장해서', () => this.pickFile('application/pdf,.pdf', false, (files) => void this.importPdfFile(files[0]))),
      item('웹 학습지', '.html 파일 · 지금 페이지 위에 창으로, 옮기고 크기 바꾸기', () => this.pickFile('.html,.htm,text/html', false, (files) => void this.importHtmlFile(files[0]))),
      item('빈 페이지', '이 페이지 다음에', () => this.addTextPage()),
    );
    this.showPanel(menu, anchor);
  }

  private pickFile(accept: string, multiple: boolean, fn: (f: File[]) => void) {
    const input = h('input', { type: 'file', accept }) as HTMLInputElement;
    if (multiple) input.multiple = true;
    input.addEventListener('change', () => input.files?.length && fn(Array.from(input.files)));
    input.click();
  }

  // 사진: 지금 보는 페이지 위에 원래 비율로 놓는다
  async insertImages(files: File[], pageId?: string) {
    const list = files.filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    let page = pageId || this.currentPage;
    if (!this.views.get(page)) page = this.order[0];
    const v = this.views.get(page);
    if (!v) return;
    let k = 0;
    for (const f of list) {
      const dataUrl = await fileToDataUrl(f);
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = dataUrl;
      }).catch(() => null);
      if (!img) continue;
      const ratio = img.naturalWidth / img.naturalHeight || 1;
      let w = Math.min(v.info.w * 0.6, img.naturalWidth);
      let hh = w / ratio;
      if (hh > 560) {
        hh = 560;
        w = hh * ratio;
      }
      let src = dataUrl;
      if (this.store.status === 'connected') {
        const blob = await (await fetch(dataUrl)).blob();
        const key = `img-${Date.now().toString(36)}-${k}.jpg`;
        if (await this.store.putBlob(key, blob)) src = 'blob:' + key;
      }
      const [x, y] = this.spotOnPage(page, w, hh);
      const o = this.store.addObj(page, { type: 'img', x: x + k * 24, y: y + k * 24, w: Math.round(w), h: Math.round(hh), ratio, src, name: f.name });
      this.store.log({ kind: 'image', page, id: o.id, data: { name: f.name } });
      this.selectObj(page, o.id);
      k++;
    }
    if (this.tool !== 'text' && this.tool !== 'select') this.setTool('select');
  }

  // 지금 화면 가운데쯤 페이지 좌표 (페이지 안으로)
  private spotOnPage(page: string, w: number, hh: number): [number, number] {
    const v = this.views.get(page);
    if (!v) return [40, 40];
    const r = this.stage.getBoundingClientRect();
    const [cx, cy] = this.vp.toWorld(r.left + (r.width - this.panelSide()) / 2, r.top + r.height / 2);
    const px = Math.max(16, Math.min(v.info.w - w - 16, cx - w / 2));
    let py = Math.max(16, Math.min(Math.max(16, v.h - hh - 16), cy - v.y - hh / 2));
    // 글 페이지: 이미 쓴 글·놓인 것 아래로 (가리지 않게, 페이지는 알아서 길어진다)
    if (v.info.kind === 'text' && v.editorHost) {
      const doc = v.editorHost.querySelector('.board-doc') as HTMLElement | null;
      const last = doc?.lastElementChild as HTMLElement | null;
      let bottom = last && (doc!.textContent || '').trim() ? v.editorHost.offsetTop + doc!.offsetTop + last.offsetTop + last.offsetHeight + 24 : 0;
      for (const o of this.store.objList(page)) if (o.x < px + w && o.x + o.w > px) bottom = Math.max(bottom, o.y + o.h + 24);
      if (py < bottom) py = bottom;
    }
    return [Math.round(px), Math.round(py)];
  }

  private pageAt(clientX: number, clientY: number): { page: string; x: number; y: number } | null {
    const [wx, wy] = this.vp.toWorld(clientX, clientY);
    for (const b of this.pageBoxes()) {
      if (!b.visible) continue;
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return { page: b.id, x: wx - b.x, y: wy - b.y };
    }
    return null;
  }

  // 글상자: 그 자리에 바로 쓰기
  addBox(page: string, x: number, y: number) {
    const v = this.views.get(page);
    if (!v) return;
    const w = Math.min(BOX_W, v.info.w - 24);
    const o = this.store.addObj(page, { type: 'box', x: Math.round(Math.max(8, Math.min(v.info.w - w - 8, x - 12))), y: Math.round(Math.max(8, y - 18)), w, h: 44 });
    this.currentPage = page;
    if (this.tool !== 'text') this.setTool('text');
    this.selectObj(page, o.id);
    v.objs?.focusBox(o.id);
  }

  private selectObj(page: string, id: string | null) {
    if (id) {
      if (this.ink.selection) {
        this.ink.selection = null;
        this.ink.invalidate();
      }
      this.selObj = { page, id };
    } else this.selObj = null;
    for (const v of this.views.values()) v.objs?.refreshSelection();
  }

  private clearSelection() {
    this.selObj = null;
    this.ink.selection = null;
    this.ink.band = null;
    this.ink.invalidate();
    for (const v of this.views.values()) v.objs?.refreshSelection();
  }

  private deleteSelection(): boolean {
    if (this.ink.selection?.ids.length) {
      this.store.removeStrokes(this.ink.selection.page, this.ink.selection.ids);
      this.clearSelection();
      return true;
    }
    if (this.selObj && this.tool === 'select') {
      this.store.removeObj(this.selObj.page, this.selObj.id);
      this.clearSelection();
      return true;
    }
    return false;
  }

  private async importPdfFile(file: File) {
    const t = toast('PDF 가져오는 중…', 60000);
    try {
      const ids = await importPdf(this.store, file, file.name.replace(/\.pdf$/i, ''), this.order.indexOf(this.currentPage), (d, n) => toast(`PDF ${d}/${n}쪽`, 60000));
      this.syncPages();
      if (ids[0]) this.gotoPage(ids[0]);
      toast(`${ids.length}쪽을 가져왔어요`);
    } catch (e) {
      console.error(e);
      toast('PDF를 열 수 없어요. 암호가 걸렸거나 손상된 파일일 수 있어요.');
    }
    void t;
  }

  async importPdfBytes(b64: string, name: string) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ids = await importPdf(this.store, bin.buffer, name, this.order.indexOf(this.currentPage));
    this.syncPages();
    return ids;
  }

  private async importHtmlFile(file: File) {
    this.placeHtml(await file.text(), file.name.replace(/\.html?$/i, ''));
  }

  // 웹 학습지를 지금 페이지 위에 창으로 놓는다
  placeHtml(html: string, name: string, page = this.currentPage) {
    let pg = page;
    if (!this.views.get(pg)) pg = this.order[0];
    const v = this.views.get(pg);
    if (!v) return;
    const mid = randomId(8);
    this.store.doc.transact(() => {
      this.store.materials.set(mid, { id: mid, name, type: 'html', pages: 1 });
      this.store.matdata.set(`${mid}/1`, { html, w: 720, h: 480 });
    }, 'import');
    this.store.log({ kind: 'material', id: mid, data: { op: 'import', type: 'html', name, bytes: html.length, as: 'object' } });
    const w = Math.min(720, v.info.w - 40);
    const hh = Math.round(w * 0.66);
    const [x, y] = this.spotOnPage(pg, w, hh);
    const o = this.store.addObj(pg, { type: 'html', x, y, w, h: hh, mid, name });
    this.selectObj(pg, o.id);
    if (this.tool !== 'text' && this.tool !== 'select') this.setTool('select');
    return o.id;
  }

  // ================= 학생 메모리 =================
  private setMemory(m: StudentMemory | null) {
    this.memory = m;
    if (this.role !== 'teacher') return;
    this.memBtn.hidden = !m && !this.pack;
    if (!m) return;
    void cacheSet(m);
    for (const ed of this.editors.values()) this.attachHints(ed);
    this.maybeInsertHeader();
    if (this.memPanel) this.renderMemPanel();
  }

  private hintWords(): HintWord[] {
    if (!this.memory || this.store.getSetting<boolean>('hints', true) === false) return [];
    // 힌트는 최근 단어만 (오래된 단어·흔한 말까지 밑줄이면 판이 시끄럽다)
    const COMMON = new Set(['있어요', '없어요', '해요', '이에요', '예요', '아니요', '네', '좋아요', '가요', '와요', '먹어요', '봐요']);
    return this.memory.vocab.filter((v) => v.status !== 'old' && v.kr.length >= 2 && !COMMON.has(v.kr)).slice(0, 300).map((v) => ({ kr: v.kr, note: vocabNote(v) }));
  }

  private attachHints(ed: Editor) {
    if (this.role !== 'teacher') return;
    if (!ed.state.plugins.some((p) => (p as unknown as { key: string }).key === (hintKey as unknown as { key: string }).key)) ed.registerPlugin(makeHintPlugin(() => this.hintWords()));
    ed.view.dispatch(ed.state.tr.setMeta(hintKey, true));
  }

  private maybeInsertHeader() {
    if (!this.memory || this.store.meta.get('headerAt')) return;
    const first = this.editors.get(this.order[0]);
    if (!first) return;
    if (first.state.doc.textContent.trim().length > 0) return; // 이미 쓰기 시작한 판에는 넣지 않는다
    const { title, lines } = headerLines(this.memory);
    if (!lines.length) return;
    this.store.doc.transact(() => this.store.meta.set('headerAt', Date.now()), 'meta');
    first
      .chain()
      .insertContentAt(0, [
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: title }] }, ...lines.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))] },
        { type: 'paragraph' },
      ])
      .run();
    const text = [title, ...lines].join(' / ');
    this.store.logText(this.order[0], 'header', 'header', text, 'memory');
    window.setTimeout(() => first.commands.focus('end'), 30);
  }

  private toggleMemPanel() {
    if (this.memPanel) {
      this.memPanel.remove();
      this.memPanel = null;
      this.memBtn.classList.remove('on');
      this.vp.set({});
      return;
    }
    this.memPanel = h('aside', { class: 'mem-panel', 'aria-label': '이 학생' });
    this.root.append(this.memPanel);
    this.memBtn.classList.add('on');
    this.renderMemPanel();
    this.vp.set({});
  }

  // KWD 폴더의 학생 자료 (선생님 기기에서만 읽는다)
  private async loadFolderStudent(interactive: boolean) {
    if (this.role !== 'teacher' || !this.packFolder) return;
    let st = (await folderState()).state;
    if (st === 'prompt' && interactive) st = (await reopenFolder()) ? 'granted' : 'prompt';
    if (st !== 'granted') {
      this.memBtn.hidden = false;
      this.memBtn.textContent = '이 학생 · 폴더 열기';
      this.memBtn.title = 'KWD 폴더를 다시 열면 이 학생 자료가 붙어요';
      return;
    }
    const brief = await briefFor().catch(() => null);
    const entry = brief?.lessons.find((l) => l.folder === this.packFolder);
    const pack = await loadPack(this.packFolder, entry).catch(() => null);
    if (!pack) {
      this.memBtn.hidden = true;
      return;
    }
    this.pack = pack;
    this.memBtn.hidden = false;
    this.memBtn.textContent = '이 학생';
    this.memBtn.title = '';
    this.renderChip();
    if (interactive && !this.memPanel) this.toggleMemPanel();
    else if (this.memPanel) this.renderMemPanel();
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback || ((f: () => void) => window.setTimeout(f, 300));
    ric(() => {
      void buildMemory(pack)
        .then((m) => this.setMemory(m))
        .catch((e) => console.warn('memory', e));
    });
  }

  private insertLineToBoard(line: string, tag = '') {
    const ed = this.activeEditor || this.editors.get(this.currentPage) || this.editors.get(this.order.find((id) => this.views.get(id)?.info.kind === 'text') || '');
    if (!ed) return;
    const { $from } = ed.state.selection;
    const at = $from.depth >= 1 ? $from.end(1) : ed.state.doc.content.size;
    const empty = $from.parent.isTextblock && $from.parent.textContent === '';
    if (empty) ed.chain().focus().insertContent(line).run();
    else ed.chain().focus().setTextSelection(at).splitBlock().insertContent(line).run();
    this.store.log({ kind: 'text', page: this.currentPage, src: 'memory', text: line, data: { op: 'insert', tab: tag } });
    toast('판에 넣었어요');
  }

  private async placePackFile(f: PackFile) {
    const file = await readPackFile(this.packFolder, f.path);
    if (!file) throw new Error('no file');
    const base = f.name.replace(/\.[^.]+$/, '');
    if (f.kind === 'html') this.placeHtml(await file.text(), base);
    else if (f.kind === 'img') await this.insertImages([file]);
    else if (f.kind === 'pdf') {
      const ids = await importPdf(this.store, await file.arrayBuffer(), base, this.order.indexOf(this.currentPage));
      this.syncPages();
      if (ids[0]) this.gotoPage(ids[0]);
    }
  }

  private memTab = 'vocab';
  private renderMemPanel() {
    const p = this.memPanel;
    if (p && this.pack) {
      renderStudentPanel(
        p,
        this.pack,
        this.memory,
        this.packTab,
        (t) => {
          this.packTab = t;
          this.renderMemPanel();
        },
        {
          insertLine: (line) => this.insertLineToBoard(line, this.packTab),
          placeFile: (f) => this.placePackFile(f),
          readLessonDoc: async (name) => (await (await readPackFile(this.packFolder, [name]))?.text()) || '',
          otherBoards: () => loadIndex().filter((b) => b.id !== this.store.id && folderForBoard(b.id) === this.packFolder),
          close: () => this.toggleMemPanel(),
        },
      );
      return;
    }
    const m = this.memory;
    if (!p || !m) return;
    p.innerHTML = '';
    const head = h('div', { class: 'mp-head' }, h('strong', {}, m.profile?.name || `학생 ${m.student}`), h('span', { class: 'mp-sub' }, [m.profile?.level, m.profile?.lessons ? `수업 ${m.profile.lessons}회` : '', m.profile?.interests?.length ? '관심: ' + m.profile.interests.join('·') : ''].filter(Boolean).join(' · ')));
    const close = h('button', { type: 'button', class: 'mp-close', title: '닫기' }, '×');
    close.addEventListener('click', () => this.toggleMemPanel());
    head.append(close);
    const tabs = h('div', { class: 'mp-tabs' });
    const tabDefs: Array<[string, string, number]> = [['vocab', '단어', m.vocab.length], ['grammar', '문형', m.grammar.length], ['errors', '오류', m.errors.length], ['homework', '과제', m.homework.length], ['lessons', '지난 수업', m.lessons.length]];
    for (const [id, label, n] of tabDefs) {
      if (!n && id !== this.memTab) continue;
      const b = h('button', { type: 'button', class: 'mp-tab' + (this.memTab === id ? ' on' : '') }, `${label} ${n}`);
      b.addEventListener('click', () => {
        this.memTab = id;
        this.renderMemPanel();
      });
      tabs.append(b);
    }
    const search = h('input', { type: 'search', class: 'mp-search', placeholder: '찾기', lang: 'ko' }) as HTMLInputElement;
    const list = h('div', { class: 'mp-list' });
    const insert = (line: string) => {
      const ed = this.activeEditor || this.editors.get(this.currentPage) || this.editors.get(this.order[0]);
      if (!ed) return;
      const { $from } = ed.state.selection;
      const at = $from.depth >= 1 ? $from.end(1) : ed.state.doc.content.size;
      const empty = $from.parent.isTextblock && $from.parent.textContent === '';
      if (empty) ed.chain().focus().insertContent(line).run();
      else ed.chain().focus().setTextSelection(at).splitBlock().insertContent(line).run();
      this.store.log({ kind: 'text', page: this.currentPage, src: 'memory', text: line, data: { op: 'insert', tab: this.memTab } });
      toast('판에 넣었어요');
    };
    const render = () => {
      list.innerHTML = '';
      const q = search.value.trim();
      const rows: Array<{ main: string; sub: string; line?: string; href?: string }> = [];
      if (this.memTab === 'vocab') {
        const order = { review: 0, learning: 1, known: 2, old: 3 } as Record<string, number>;
        for (const v of [...m.vocab].sort((a, b) => (order[a.status || 'learning'] ?? 1) - (order[b.status || 'learning'] ?? 1))) rows.push({ main: v.kr, sub: vocabNote(v), line: `${v.kr} : ${v.en || ''}`.trim() });
      } else if (this.memTab === 'grammar') {
        for (const g of m.grammar) rows.push({ main: g.pattern, sub: [g.name, g.first ? `${g.first}에 배움` : '', g.count ? `${g.count}번` : '', (g.examples || [])[0]].filter(Boolean).join(' · '), line: `${g.pattern}${g.examples?.[0] ? ' — ' + g.examples[0] : ''}` });
      } else if (this.memTab === 'errors') {
        for (const e of m.errors) rows.push({ main: `${e.type}${e.pattern ? ' ' + e.pattern : ''}`, sub: [e.wrong ? `✗ ${e.wrong}` : '', e.right ? `✓ ${e.right}` : '', e.count ? `${e.count}번` : '', e.last || ''].filter(Boolean).join(' · '), line: e.right || e.wrong });
      } else if (this.memTab === 'homework') {
        for (const hw of m.homework) rows.push({ main: hw.text, sub: [hw.given ? `${hw.given} 냄` : '', hw.due ? `기한 ${hw.due}` : '', hw.status === 'done' ? '완료' : '확인 전'].filter(Boolean).join(' · '), line: `과제: ${hw.text}` });
      } else {
        const boards = loadIndex().filter((b) => b.student === m.student && b.id !== this.store.id);
        for (const l of m.lessons) rows.push({ main: `${l.date} ${l.id}`, sub: l.summary || '', href: l.board ? `#/b/${l.board}?r=t` : undefined });
        for (const b of boards) rows.push({ main: `판 ${fmtDate(b.createdAt)}`, sub: b.id, href: `#/b/${b.id}?r=t` });
      }
      const filtered = q ? rows.filter((r) => (r.main + ' ' + r.sub).includes(q)) : rows;
      if (!filtered.length) list.append(h('p', { class: 'mp-empty' }, q ? '찾는 항목이 없어요' : '아직 기록이 없어요'));
      for (const r of filtered) {
        const row = h('div', { class: 'mp-row' }, h('div', { class: 'mp-main' }, r.main), h('div', { class: 'mp-rsub' }, r.sub));
        if (r.line) {
          const ins = h('button', { type: 'button', class: 'mp-ins', title: '판의 지금 줄 아래에 넣기' }, '판에 넣기');
          ins.addEventListener('mousedown', (e) => e.preventDefault());
          ins.addEventListener('click', () => insert(r.line!));
          row.append(ins);
        }
        if (r.href) {
          const a = h('a', { class: 'mp-ins', href: r.href, target: '_blank', rel: 'noopener' }, '열기');
          row.append(a);
        }
        list.append(row);
      }
    };
    search.addEventListener('input', render);
    const count = [m.vocab, m.grammar, m.errors, m.homework, m.lessons][['vocab', 'grammar', 'errors', 'homework', 'lessons'].indexOf(this.memTab)]?.length || 0;
    search.hidden = count <= 8;
    search.addEventListener('keydown', (e) => e.stopPropagation());
    p.append(head, tabs, search, list);
    render();
  }

  // ================= 기록 묶음 =================
  private async autosave(final = false) {
    if (this.role !== 'teacher') return;
    if (!this.store.dirtySince && !final) return;
    if (!this.store.meta.get('startedAt')) return;
    try {
      const { name, blob } = await buildBundle({ store: this.store, editors: this.editors });
      const ok = await writeToFolder(name, blob);
      if (ok) {
        this.store.dirtySince = 0;
        this.lastBundleAt = Date.now();
        this.renderChip();
      }
    } catch (e) {
      console.warn('autosave', e);
    }
  }

  private async saveBundleNow() {
    const { name, blob } = await buildBundle({ store: this.store, editors: this.editors });
    let ok = false;
    if (canPickFolder() && !EMBEDDED) {
      ok = await writeToFolder(name, blob, true);
      if (!ok && !(await folderName())) {
        try {
          if (await pickFolder()) ok = await writeToFolder(name, blob, true);
        } catch {
          ok = false;
        }
      }
    }
    if (ok) {
      this.store.dirtySince = 0;
      this.lastBundleAt = Date.now();
      toast(`기록 폴더에 저장: ${name}`);
      this.renderChip();
    } else downloadBlob(name, blob);
  }

  private async leave() {
    this.store.flushText();
    await this.autosave(true);
    location.hash = '#/';
  }

  // ================= 메뉴 =================
  private openMenu(anchor: HTMLElement) {
    if (this.panel) return this.closePanel();
    const s = this.store;
    const item = (label: string, fn: () => void, opts: { on?: boolean; off?: boolean; sub?: string; danger?: boolean } = {}) => {
      const el = h('button', { type: 'button', class: 'mi' + (opts.on ? ' on' : '') + (opts.off ? ' off' : '') + (opts.danger ? ' danger' : '') }, h('span', {}, label));
      if (opts.sub) el.append(h('span', { class: 'mi-sub' }, opts.sub));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => {
        this.closePanel();
        fn();
      });
      return el;
    };
    const toggle = (label: string, key: string, def: boolean) => item(label, () => s.setSetting(key, !s.getSetting(key, def)), { on: s.getSetting(key, def), off: !s.getSetting(key, def) });
    const menu = h('div', { class: 'menu' });
    const cur = this.views.get(this.currentPage);
    const timers = h('div', { class: 'mi-chips' }, h('span', { class: 'mi-chips-label' }, '타이머'));
    for (const [label, sec] of [['30초', 30], ['1분', 60], ['3분', 180]] as Array<[string, number]>) {
      const b = h('button', { type: 'button', class: 'chip-btn' }, label);
      b.addEventListener('click', () => {
        this.closePanel();
        this.startTimer(sec);
      });
      timers.append(b);
    }
    const saved = this.lastBundleAt ? `${new Date(this.lastBundleAt).toTimeString().slice(0, 5)} 저장됨` : '';
    menu.append(
      h('div', { class: 'mh' }, '학생에게 허락'),
      toggle('글 쓰기', 'studentWrite', false),
      toggle('펜 쓰기', 'studentInk', false),
      toggle('학습지 버튼 누르기', 'studentMaterial', false),
      h('div', { class: 'mi-sep' }),
      toggle('학생에게 내 커서 보이기', 'showCaret', true),
      item(this.single() ? '스크롤로 보기' : '한 장씩 보기', () => s.setSetting('viewMode', this.single() ? 'scroll' : 'single'), { sub: this.single() ? '' : '← → 로 넘김' }),
      timers,
      item('수업 요약 보기', () => this.openSummary()),
      item('지금 기록 저장', () => void this.saveBundleNow(), { sub: saved }),
      item('학생 링크', () => this.openLinks()),
      item('더 보기…', () => this.openMoreMenu(anchor)),
      ...(this.order.length > 1 && cur ? [h('div', { class: 'mi-sep' }), item(`${this.order.indexOf(this.currentPage) + 1}페이지 지우기…`, () => this.confirmDeletePage(), { danger: true })] : []),
    );
    this.showPanel(menu, anchor);
  }

  private openMoreMenu(anchor: HTMLElement) {
    const menu = h('div', { class: 'menu' });
    const item = (label: string, sub: string, fn: () => void) => {
      const el = h('button', { type: 'button', class: 'mi' }, h('span', {}, label));
      if (sub) el.append(h('span', { class: 'mi-sub' }, sub));
      el.addEventListener('click', () => {
        this.closePanel();
        fn();
      });
      return el;
    };
    menu.append(
      ...(canPickFolder() && !EMBEDDED ? [item('기록 폴더 정하기', '정하면 1분마다 자동 저장', () => void pickFolder().then((n) => n && toast(`기록 폴더: ${n}`)))] : []),
      item('글만 마크다운으로 받기', '', () => this.exportMd()),
      item('서버·선생님 열쇠', '여러 기기 연결', () => this.openServer()),
    );
    this.showPanel(menu, anchor);
  }

  private confirmDeletePage() {
    const n = this.order.indexOf(this.currentPage) + 1;
    const box = h('div', { class: 'menu wide' });
    const yes = h('button', { type: 'button', class: 'mi danger' }, `${n}페이지 지우기`);
    const no = h('button', { type: 'button', class: 'mi' }, '그대로 두기');
    yes.addEventListener('click', () => {
      const id = this.currentPage;
      const idx = this.order.indexOf(id);
      this.store.removePage(id);
      this.closePanel();
      this.syncPages();
      this.gotoPage(this.order[Math.max(0, idx - 1)]);
      toast('지웠어요 (↶로 되돌리기)');
    });
    no.addEventListener('click', () => this.closePanel());
    box.append(h('div', { class: 'mh' }, '이 페이지를 지울까요?'), yes, no);
    this.showPanel(box);
  }

  private pickMemoryFile() {
    this.pickFile('.json,application/json', false, async (files) => {
      try {
        const m = normalize(JSON.parse(await files[0].text()), this.studentNo());
        if (!m) throw new Error('bad');
        this.setMemory(m);
        toast(`학생 ${m.student} 메모리: 단어 ${m.vocab.length} · 문형 ${m.grammar.length}`);
        if (!this.memPanel) this.toggleMemPanel();
      } catch {
        const box = h('div', { class: 'menu wide' });
        const sample = h('button', { type: 'button', class: 'mi' }, '예시 메모리로 보기');
        sample.addEventListener('click', () => {
          this.closePanel();
          this.setMemory(SAMPLE_MEMORY(this.studentNo() || '0'));
          if (!this.memPanel) this.toggleMemPanel();
        });
        box.append(h('div', { class: 'mh' }, 'memory.json 을 읽지 못했어요'), h('p', { class: 'mnote' }, '밤 루틴의 kwd_night.py memory 가 만든 파일을 고르세요.'), sample);
        this.showPanel(box);
      }
    });
  }

  private showPanel(el: HTMLElement, anchor?: HTMLElement) {
    this.closePanel();
    const wrap = h('div', { class: 'panel-wrap' });
    wrap.append(el);
    this.root.append(wrap);
    this.panel = wrap;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      el.classList.add('anchored');
      el.style.bottom = `${window.innerHeight - r.top + 10}px`;
      el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.left + r.width / 2 - el.offsetWidth / 2))}px`;
    }
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap) this.closePanel();
    });
  }

  private closePanel() {
    this.panel?.remove();
    this.panel = null;
  }

  private startTimer(seconds: number) {
    this.store.setSetting('timer', { endsAt: this.store.now() + seconds * 1000, seconds });
    this.store.log({ kind: 'timer', data: { seconds } });
  }

  private renderTimer() {
    const t = this.store.getSetting<{ endsAt: number } | null>('timer', null);
    if (!t || !t.endsAt) {
      this.timerEl.hidden = true;
      return;
    }
    const left = Math.ceil((t.endsAt - this.store.now()) / 1000);
    if (left <= -5) {
      this.timerEl.hidden = true;
      if (this.role === 'teacher') this.store.setSetting('timer', null);
      return;
    }
    this.timerEl.hidden = false;
    this.timerEl.textContent = left > 0 ? fmtClock(left) : '끝!';
    this.timerEl.classList.toggle('done', left <= 0);
    this.timerEl.onclick = () => this.role === 'teacher' && this.store.setSetting('timer', null);
  }

  private renderChip() {
    const student = this.studentNo();
    const started = Number(this.store.meta.get('startedAt') || 0);
    const elapsed = started ? fmtClock(Math.floor((this.store.now() - started) / 1000)) : '';
    const others = Array.from(this.store.awareness.getStates().entries()).filter(([cid]) => cid !== this.store.awareness.clientID);
    const roles = others.map(([, st]) => st?.role).filter(Boolean) as Role[];
    this.chip.innerHTML = '';
    const name = this.role === 'teacher' ? this.pack?.name || this.memory?.profile?.name || (student ? `학생 ${student}` : '판') : '수업 판';
    this.chip.append(h('span', { class: `dot ${this.store.status}` }), h('span', { class: 'chip-main' }, name));
    if (elapsed) this.chip.append(h('span', { class: 'chip-sub' }, '수업 ' + elapsed));
    if (this.role === 'teacher') {
      const perms = [this.store.getSetting('studentWrite', false) && '글', this.store.getSetting('studentInk', false) && '펜', this.store.getSetting('studentMaterial', false) && '자료'].filter(Boolean);
      if (perms.length) this.chip.append(h('span', { class: 'chip-perm' }, '학생 ' + perms.join('·')));
    }
    if (roles.length) this.chip.append(h('span', { class: 'chip-sub' }, roles.map((r) => ROLE_NAMES[r]).join('·') + ' 연결됨'));
    if (this.lastBundleAt) this.chip.append(h('span', { class: 'chip-sub save' }, '기록 ✓'));
    this.chip.title = { local: '이 기기에만 저장 중 (서버 없음)', connecting: '서버에 연결 중', connected: '서버 연결됨', disconnected: '서버 끊김 — 이 기기에 쌓는 중' }[this.store.status];
    this.updateSingleLabel();
  }

  private openLinks() {
    const srv = getServerUrl();
    const base = location.href.split('#')[0];
    const mk = (r: Role) => `${base}#/b/${this.params.id}?r=${r[0]}${srv ? `&srv=${encodeURIComponent(srv)}` : ''}`;
    const row = (label: string, url: string) => {
      const input = h('input', { type: 'text', readonly: '', value: url, class: 'link-input' }) as HTMLInputElement;
      const copy = h('button', { type: 'button', class: 'mi small' }, '복사');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('복사했어요');
        } catch {
          input.select();
          toast('길게 눌러 복사하세요');
        }
      });
      input.addEventListener('focus', () => input.select());
      return h('div', { class: 'link-row' }, h('span', { class: 'link-label' }, label), input, copy);
    };
    const box = h('div', { class: 'menu wide' });
    box.append(
      h('div', { class: 'mh' }, `방 코드 ${this.params.id}`),
      row('학생', mk('student')),
      row('태블릿 펜', mk('assist')),
      row('다른 랩탑', mk('teacher')),
      h('p', { class: 'mnote' }, EMBEDDED ? '시험용 창이라 다른 기기와 연결할 수 없어요. 설치본에서 서버 주소를 넣으면 링크 하나로 같이 봅니다.' : srv ? `서버 ${srv}` : '서버 주소가 없어 이 기기 안에서만 동작해요. ⋯ → 서버·선생님 열쇠.'),
    );
    this.showPanel(box);
  }

  private openServer() {
    const box = h('div', { class: 'menu wide' });
    const input = h('input', { type: 'url', class: 'link-input', placeholder: 'wss://…', value: getServerUrl() }) as HTMLInputElement;
    const tk = h('input', { type: 'password', class: 'link-input', placeholder: '선생님 열쇠 (학생 메모리용)', value: getToken(), autocomplete: 'off' }) as HTMLInputElement;
    const save = h('button', { type: 'button', class: 'mi small' }, '저장');
    save.addEventListener('click', () => {
      const v = input.value.trim();
      setServerUrl(v);
      setToken(tk.value.trim());
      if (v) this.store.connect(v);
      else this.store.disconnect();
      this.closePanel();
      this.renderChip();
      void loadMemory(this.studentNo()).then(({ mem }) => mem && this.setMemory(mem));
    });
    [input, tk].forEach((i) => i.addEventListener('keydown', (e) => e.stopPropagation()));
    box.append(h('div', { class: 'mh' }, '동기화 서버'), h('div', { class: 'link-row' }, input), h('div', { class: 'link-row' }, tk, save), h('p', { class: 'mnote' }, EMBEDDED ? '시험용 창에서는 연결되지 않아요.' : '열쇠는 이 기기에만 저장돼요. 학생 링크에는 들어가지 않아요.'));
    this.showPanel(box);
    window.setTimeout(() => input.focus(), 0);
  }

  private openSummary() {
    const box = h('div', { class: 'menu wide summary' });
    box.append(h('div', { class: 'mh' }, '오늘 요약'));
    let corr = 0, blanks = 0;
    const corrRows: HTMLElement[] = [];
    const blankRows: HTMLElement[] = [];
    for (const ed of this.editors.values()) {
      const sum = summarize(ed);
      corr += sum.corrections.length;
      blanks += sum.blanks.length;
      for (const c of sum.corrections) corrRows.push(h('div', { class: 'sum-row' }, `✗ ${c.original}`), h('div', { class: 'sum-row ok' }, `✓ ${c.corrected}`));
      for (const b of sum.blanks) blankRows.push(h('div', { class: 'sum-row' }, `${b.result === 'ok' ? '○' : b.result === 'no' ? '✗' : '·'} ${b.value || '___'}${b.answer ? ` (${b.answer})` : ''}`));
    }
    const inkCount = this.order.reduce((a, id) => a + this.store.ink(id).length, 0);
    box.append(h('p', { class: 'mnote' }, `페이지 ${this.order.length} · 사건 ${this.store.events.length} · 잉크 ${inkCount}. 단어 정리는 수업 뒤 밤 루틴이 기록에서 합니다.`));
    box.append(h('h4', {}, `교정 ${corr}`), ...corrRows, h('h4', {}, `빈칸 ${blanks}`), ...blankRows);
    this.showPanel(box);
  }

  private exportMd() {
    download(bundleName(this.store).replace('.kwd.zip', '.md'), boardMarkdown({ store: this.store, editors: this.editors }), 'text/markdown');
  }

  destroy() {
    window.clearInterval(this.clockTimer);
    window.clearInterval(this.autosaveTimer);
    this.disposers.forEach((d) => d());
    this.ink.destroy();
    for (const ed of this.editors.values()) ed.destroy();
    this.store.destroy();
    this.root.remove();
  }
}

// TextSelection 은 다른 모듈에서 쓰도록 다시 내보냄
export { TextSelection };
