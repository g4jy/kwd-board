// 판 화면 (시제품 3): 페이지 모델 + 펜 프리셋 + 자료 페이지 + 기록 묶음 + 학생 메모리
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { BoardStore, randomId, DEFAULT_SERVER, getServerUrl, setServerUrl, getToken, setToken, upsertIndex, loadIndex, LOCAL, TEXT_W, TEXT_H, type Role, type PageInfo, type InkTarget } from './store';
import { Viewport } from './viewport';
import { InkLayer, CURSOR_ARROW, CURSOR_TEXT, type Tool, type PageBox } from './ink';
import { PageObjects, BOX_W, youtubeId, type ObjectHost } from './objects';
import { createPageEditor, insertImageFiles, fileToDataUrl, makeHintPlugin, hintKey, ROLE_COLORS, ROLE_NAMES, type HintWord } from './editor';
import { summarize } from './exportmd';
import { buildBundle, bundleName, boardMarkdown, canPickFolder, pickFolder, folderName, writeToFolder } from './record';
import { importPdf, importHtml, htmlWithBridge, joinText } from './importer';
import { loadPrefs, savePrefs, penSlot, renderSlot, buildPenPopover, type PenPrefs } from './palette';
import { icon } from './icons';
import { loadMemory, cacheSet, normalize, headerLines, vocabNote, SAMPLE_MEMORY, type StudentMemory } from './memory';
import { folderForBoard, folderState, reopenFolder, briefFor, loadPack, buildMemory, readPackFile, isDemo, saveToStudentFolder, makeLessonDir, type StudentPack, type PackFile } from './kwdfolder';
import { annotatedWorksheet } from './wsexport';
import { Classroom } from './classroom';
import { renderStudentPanel, type SplitSeg, type PanelTab } from './studentpanel';
import { hwConfig, setHwConfig, hwMedia, historyFromApp } from './homework';
import { h, download, downloadBlob, fmtDate, fmtClock, toast, EMBEDDED } from './ui';

const GAP = 28; // 페이지 사이
// 웹 학습지 창: 테두리 1px + 위 막대 32px → iframe 은 (1, 33) 에서 시작
export const OBJ_BAR = 33;
export const wsLayer = (objId: string, step: number) => `ws:${objId}:${step}`;
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
  private followOnce = true; // 처음 한 번만 따라감
  private lookSeen = 0; // 마지막으로 따른 '여기 보세요'
  private teacherView: { cx: number; cy: number; s: number; w: number; h: number; page?: string; mode?: string } | null = null;
  private memory: StudentMemory | null = null;
  // UI
  private toolbar!: HTMLElement;
  private rail!: HTMLElement;
  private zoomEl!: HTMLElement;
  private chip!: HTMLElement;
  private timerEl!: HTMLElement;
  private timerBtn: HTMLElement | null = null;
  private followBtn!: HTMLElement;
  private bubble!: HTMLElement;
  private popover: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private memPanel: HTMLElement | null = null;
  private classroom: Classroom | null = null;
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
      openPopup: (page, id) => this.setPopup({ page, id }),
      focusObj: (page, id) => this.gotoObj(page, id, this.role === 'teacher'),
      canDrive: () => this.role === 'teacher' || (this.role === 'student' && !!this.store.getSetting('studentMaterial', false)),
      addWsBox: (layer, x, y) => {
        const o = this.store.addObj(layer, { type: 'box', x: Math.round(x), y: Math.round(y), w: BOX_W, h: 44 });
        if (this.tool !== 'text') this.setTool('text');
        window.setTimeout(() => {
          const ed = this.findBoxEditor(o.id);
          ed?.commands.focus('end');
        }, 30);
      },
      saveWs: (page, id) => void this.saveWorksheet(page, id),
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
    // 레이저로 가리킨 곳: 판 기록에 한 줄 (전사 정리 때 '여기'가 어디였는지)
    this.ink.onPoint = (p) => this.store.log({ kind: 'point', page: p.page, data: { x: p.x, y: p.y, target: p.target } });
    this.ink.straighten = this.prefs.straighten;

    const back = h('button', { type: 'button', class: 'back-btn', title: '판 목록으로 (저장은 자동)' }, '← 목록');
    back.addEventListener('click', () => void this.leave());
    this.chip = h('button', { type: 'button', class: 'chip', title: '판 정보·링크' });
    this.saveDot = h('span', { class: 'save-dot', title: '기록' });
    const topLeft = h('div', { class: 'top-left' }, back, this.chip);
    // 타이머: 학생 칩 옆 (10/19: ⋯ 안에 숨어 있었다). 도는 동안은 남은 시간이 그 자리에
    if (this.role === 'teacher') {
      this.timerBtn = h('button', { type: 'button', class: 'timer-btn', title: '타이머 (30초 · 1분 · 3분 · 5분)', 'aria-label': '타이머' }, icon('timer'));
      this.timerBtn.addEventListener('click', () => this.openTimerMenu(this.timerBtn!));
      topLeft.append(this.timerBtn);
    }
    if (this.role === 'student' || this.role === 'assist') back.hidden = true;
    this.timerEl = h('div', { class: 'timer', hidden: '' });
    this.memBtn = h('button', { type: 'button', class: 'mem-btn', hidden: '' }, '이 학생');
    this.memBtn.addEventListener('click', () => {
      if (this.packFolder && !this.pack) void this.loadFolderStudent(true);
      else this.toggleMemPanel();
    });
    const lookBtn = h('button', { type: 'button', class: 'look-btn', title: '학생 화면을 지금 내 화면(또는 고른 것)으로' }, '여기 보세요');
    lookBtn.addEventListener('click', () => this.lookHere());
    // 교실 (v8): 카메라 칸 · 학생 입장 · 수업 시작/끝내기(녹화)
    if (this.role !== 'assist') {
      this.classroom = new Classroom({
        root: this.root,
        stage: this.stage,
        store: this.store,
        role: this.role,
        demo: isDemo(),
        serverUrl: () => this.store.serverUrl || '',
        lessonDir: (stem) => makeLessonDir(this.packFolder, this.params.id, stem),
        stem: () => {
          const d = new Date(this.store.now());
          const p2 = (n: number) => String(n).padStart(2, '0');
          const n = this.pack?.brief?.next_lesson || (this.pack?.lessons[0] ? this.pack.lessons[0].n + 1 : 0);
          return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}${n ? `_#${n}` : ''}`;
        },
        saveBundle: (open) => this.saveLessonBundle(open),
        meta: () => ({ student_folder: this.packFolder ? 'PC_ONLY' : null, lesson_no: this.pack?.brief?.next_lesson || null, packet_id: this.pack?.packet?.packet_id || null }),
      });
    }
    topLeft.append(this.timerEl);
    const topRight = h('div', { class: 'top-right' }, ...(this.role === 'teacher' && this.classroom?.lessonBtn ? [this.classroom.lessonBtn, ...(this.classroom.micBtn ? [this.classroom.micBtn] : [])] : []), ...(this.role === 'teacher' ? [lookBtn] : []), this.memBtn);
    this.followBtn = h('button', { type: 'button', class: 'follow-btn', hidden: '' }, '선생님 화면으로');
    this.followBtn.addEventListener('click', () => {
      this.following = true;
      this.followBtn.hidden = true;
      this.applyTeacherView();
    });
    this.bubble = h('div', { class: 'bubble', hidden: '' });
    this.toolbar = this.buildToolbar();
    try {
      this.root.classList.toggle('tb-top', this.role !== 'student' && localStorage.getItem('kwd.tbTop') === '1');
    } catch {
      /* 기본은 아래 */
    }
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
      bundle: () => buildBundle({ store: this.store, editors: this.editors, packetId: this.pack?.packet?.packet_id }),
      importPdfBytes: (b64: string, name: string) => this.importPdfBytes(b64, name),
      insertMediaBytes: (b64: string, name: string, kind: 'audio' | 'video') => this.insertMedia(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: kind + '/webm' }), kind, name),
      classroom: () => this.classroom,
      importHtmlText: (html: string, name: string) => importHtml(this.store, html, name, this.order.indexOf(this.currentPage)),
      setMemory: (m: unknown) => this.setMemory(normalize(m, this.studentNo())),
      goto: (id: string) => this.gotoPage(id),
      gotoItem: (key: string) => this.gotoItem(key),
      lookHere: () => this.lookHere(),
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
    this.initialView();
    this.renderChip();
    if (this.role === 'teacher') {
      // 빈 판이면 바로 칠 수 있게 노트에 커서. 자료가 깔린 판이면 노트를 접어 둔 채로 (10/18)
      const first = this.editors.get(this.order[0]);
      const busy = this.store.objList(this.order[0]).length > 0 || isDemo();
      if (!busy) window.setTimeout(() => first?.commands.focus('end'), 60);
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
    const isCanvas = info.kind === 'text' && this.store.pageIndex(info.id) === 0;
    const el = h('section', { class: `page page-${info.kind}` + (isCanvas ? ' canvas' : ''), 'data-page': info.id });
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
      if (isCanvas) {
        // 비어 있는 노트는 작게 접어 둔다 (판에 흰 A4 가 덩그러니 있지 않게, 10/18). 누르면 펼쳐져서 바로 쓴다
        const fold = () => {
          const empty = editor.isEmpty && !editor.isFocused;
          if (host.classList.contains('note-empty') !== empty) {
            host.classList.toggle('note-empty', empty);
            this.layoutSoon();
            this.renderRailSoon();
          }
        };
        for (const ev of ['update', 'focus', 'blur', 'create'] as const) editor.on(ev, () => window.setTimeout(fold, 0));
        window.setTimeout(fold, 0);
      }
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
    this.store.objs(info.id).observe(() => {
      this.layoutSoon();
      this.renderRailSoon();
    });
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

  // 한 장씩 보기는 무한 판에서는 쓰지 않는다 (대신 오른쪽 목록 · '여기 보세요')
  private single(): boolean {
    return false;
  }

  private layout() {
    let y = 0;
    const single = this.single();
    this.order.forEach((id, i) => {
      const v = this.views.get(id)!;
      let hgt = v.info.h;
      if (v.info.kind === 'text' && v.editorHost) {
        const content = v.editorHost.scrollHeight + (i === 0 ? 0 : 160);
        let objBottom = 0;
        for (const o of this.store.objList(id)) objBottom = Math.max(objBottom, o.y + o.h + 120);
        // 무한 판: 노트 카드는 글만큼만. 다른 것들은 판 어디에나 (예전 판의 다음 페이지는 그 아래)
        hgt = i === 0 ? Math.max(content, objBottom, 400) : Math.max(TEXT_H, Math.ceil(Math.max(content, objBottom) / 40) * 40);
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
    // 학습지 필기층도 되돌리기에 넣는다
    for (const b of this.wsBoxes()) {
      if (this.scoped.has(b.id)) continue;
      this.scoped.add(b.id);
      this.undo.addToScope([this.store.ink(b.id)]);
    }
    this.computeBounds();
    this.ink.invalidate();
    this.vp.set({});
  }
  private scoped = new Set<string>();

  private pageLabel(id: string, i: number): string {
    const v = this.views.get(id)!;
    if (v.info.kind === 'material' && v.info.mid) {
      const m = this.store.materials.get(v.info.mid);
      return `${i + 1} · ${m?.name || '자료'} (원본 ${v.info.n}/${m?.pages || ''})`;
    }
    return String(i + 1);
  }

  // 첫 글 페이지 = 무한 판(어디에 그려도 된다). 나머지(예전 판의 자료 페이지)는 그 아래에 쌓인 틀.
  // + 웹 학습지 위 필기층: 학습지의 지금 단계마다 따로 (id = ws:<물건 id>:<단계>)
  pageBoxes(): PageBox[] {
    const out: PageBox[] = this.order.map((id, i) => {
      const v = this.views.get(id)!;
      return { id, x: 0, y: v.y, w: v.info.w, h: v.h, visible: true, infinite: i === 0 && v.info.kind === 'text' };
    });
    return out.concat(this.wsBoxes());
  }

  private canvasId(): string {
    return this.order[0] || '';
  }
  private isCanvas(id: string): boolean {
    return id === this.order[0] && this.views.get(id)?.info.kind === 'text';
  }

  // 웹 학습지 위 필기층 (세상 좌표). 학습지 창의 막대 아래 iframe 자리.
  wsBoxes(): PageBox[] {
    const out: PageBox[] = [];
    for (const id of this.order) {
      const v = this.views.get(id);
      if (!v) continue;
      for (const o of this.store.objList(id)) {
        if (o.type !== 'html') continue;
        out.push({ id: wsLayer(o.id, o.step || 1), x: o.x + 1, y: v.y + o.y + OBJ_BAR, w: o.w - 2, h: Math.max(10, o.h - OBJ_BAR - 1), visible: true });
      }
    }
    return out;
  }

  private totalHeight(): number {
    if (this.single()) return this.views.get(this.currentPage)?.h || TEXT_H;
    const last = this.views.get(this.order[this.order.length - 1]);
    return last ? last.y + last.h : TEXT_H;
  }

  // 무한 판: 어디로든 움직이되, 놓인 것 전체가 화면 밖으로 다 빠져나가지는 않게
  private bounds: [number, number, number, number] = [0, 0, TEXT_W, TEXT_H];
  private computeBounds() {
    let x0 = 0, y0 = 0, x1 = TEXT_W, y1 = 400;
    for (const id of this.order) {
      const v = this.views.get(id);
      if (!v) continue;
      if (v.info.kind !== 'text' || !this.isCanvas(id)) {
        y1 = Math.max(y1, v.y + v.h);
        x1 = Math.max(x1, v.info.w);
      } else y1 = Math.max(y1, (v.editorHost?.offsetHeight || 0) + v.y);
      for (const o of this.store.objList(id)) {
        x0 = Math.min(x0, o.x);
        y0 = Math.min(y0, v.y + o.y);
        x1 = Math.max(x1, o.x + o.w);
        y1 = Math.max(y1, v.y + o.y + o.h);
      }
    }
    const c = this.canvasId();
    if (c) {
      for (const st of this.store.ink(c).toArray()) {
        const p = st.pts;
        if (p.length < 3) continue;
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
    }
    this.bounds = [x0, y0, x1, y1];
  }
  private clampView(v: { x: number; y: number; s: number }) {
    const r = this.stage.getBoundingClientRect();
    const W = r.width || window.innerWidth;
    const H = r.height || window.innerHeight;
    const [x0, y0, x1, y1] = this.bounds;
    const m = 120;
    let { x, y } = v;
    x = Math.min(W - m - x0 * v.s, Math.max(m - x1 * v.s, x));
    y = Math.min(H - m - y0 * v.s, Math.max(m - y1 * v.s, y));
    return { x, y, s: v.s };
  }

  // 세상 좌표 네모가 화면에 꽉 차게 (여백 pad)
  fitRect(x0: number, y0: number, x1: number, y1: number, pad = 40, maxS = 2) {
    const [W, H] = this.vp.size();
    let side = this.panelSide() || (this.rail && !this.rail.hidden && W > 700 ? 56 : 0);
    // 카메라 칸이 켜져 있으면 그 오른쪽 자리를 비켜 준다 (넓은 화면)
    const dock = this.classroom?.dock;
    if (dock && W > 900 && dock.dataset.state !== 'off' && !dock.classList.contains('big') && getComputedStyle(dock).display !== 'none' && dock.getBoundingClientRect().left > window.innerWidth / 2) side = Math.max(side, window.innerWidth - dock.getBoundingClientRect().left + 8);
    const tbTop = this.root.classList.contains('tb-top');
    const top = tbTop ? 120 : 64, bottom = (this.role === 'student' && this.toolbar.hidden) || tbTop ? 24 : 96;
    const aw = Math.max(80, W - side - pad * 2), ah = Math.max(80, H - top - bottom - pad);
    const s = Math.min(maxS, Math.max(this.vp.min, Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0))));
    this.vp.set({ s, x: pad + (aw - (x1 - x0) * s) / 2 - x0 * s, y: top + (ah - (y1 - y0) * s) / 2 - y0 * s });
  }

  private panelSide(): number {
    if (!this.memPanel || this.memPanel.hidden) return 0;
    const W = this.stage.getBoundingClientRect().width || window.innerWidth;
    if (W < 900) return 0;
    return this.memPanel.getBoundingClientRect().width + 64;
  }

  // 오른쪽 목록: 판 위의 것들(노트·슬라이드·학습지·사진·영상…) — 누르면 그리로
  private railItems(): Array<{ key: string; icon: string; label: string; title: string; page: string; rect: [number, number, number, number]; ic?: string; name?: string; thumb?: string }> {
    const out: Array<{ key: string; icon: string; label: string; title: string; page: string; rect: [number, number, number, number]; ic?: string; name?: string; thumb?: string }> = [];
    const ICON: Record<string, string> = { slide: '▤', html: '◫', img: '▣', video: '▶', youtube: '▶', audio: '♪' };
    // 종류마다 다른 아이콘 (10/19: ▶·♪·▣ 가 두 개씩이라 구분이 안 됐다). 숙제는 따로
    const IC: Record<string, string> = { slide: 'slide', html: 'web', img: 'image', video: 'video', youtube: 'youtube', audio: 'audio' };
    const NAME: Record<string, string> = { slide: '슬라이드', html: '웹 학습지', img: '사진', video: '영상', youtube: '유튜브', audio: '소리' };
    this.order.forEach((id, i) => {
      const v = this.views.get(id)!;
      if (this.isCanvas(id)) {
        const nh = Math.min(Math.max(300, v.editorHost?.offsetHeight || 600), 1000);
        if (!v.editorHost?.classList.contains('note-empty')) out.push({ key: 'note', icon: '✎', label: '', title: '노트', page: id, rect: [0, v.y, TEXT_W, v.y + nh], ic: 'note', name: '노트' });
        const objs = this.store.objList(id).filter((o) => o.type !== 'box').sort((a, b) => a.y - b.y || a.x - b.x);
        for (const o of objs) {
          const mat = o.mid ? this.store.materials.get(o.mid) : null;
          const title = o.type === 'slide' ? `${mat?.name || '슬라이드'} ${o.n}/${mat?.pages || ''}` : `${NAME[o.type]}${o.name && o.name !== NAME[o.type] ? ' · ' + o.name : ''}`;
          const hw = /숙제|과제/.test(o.name || '');
          const ic = hw ? (o.type === 'audio' ? 'voice' : 'homework') : IC[o.type] || 'doc';
          const name = o.type === 'slide' ? `${(mat?.name || '슬라이드').replace(/^#\d+\s*/, '')} ${o.n}` : o.name || NAME[o.type] || '';
          const md = o.type === 'slide' ? this.store.matdata.get(`${o.mid}/${o.n}`) : undefined;
          const thumb = o.type === 'img' && o.src ? this.store.resolveImg(o.src) : md?.img ? this.store.resolveImg(md.img) : undefined;
          out.push({ key: o.id, icon: ICON[o.type] || '•', label: o.type === 'slide' ? String(o.n) : '', title, page: id, rect: [o.x, v.y + o.y, o.x + o.w, v.y + o.y + o.h], ic, name, thumb });
        }
      } else out.push({ key: id, icon: '', label: String(i + 1), title: this.pageLabel(id, i), page: id, rect: [0, v.y, v.info.w, v.y + v.h] });
    });
    return out;
  }

  private renderRail() {
    if (this.role === 'student' && window.innerWidth < 700) {
      this.rail.hidden = true;
      return;
    }
    this.rail.hidden = false;
    this.rail.innerHTML = '';
    // 넓게: 작은 그림 + 짧은 이름 (한 줄 44px). 좁게: 종류 아이콘만. 접기 단추로 바꾸고 이 기기에 기억
    let wide = window.innerWidth >= 1100;
    try {
      const w = localStorage.getItem('kwd.railWide');
      if (w) wide = w === '1';
    } catch {
      /* 기본값 */
    }
    this.rail.classList.toggle('wide', wide);
    const tg = h('button', { type: 'button', class: 'rail-toggle', title: wide ? '목록 좁게' : '목록 넓게 (이름 보기)', 'aria-label': wide ? '목록 좁게' : '목록 넓게' }, wide ? '›' : '‹');
    tg.addEventListener('click', () => {
      try {
        localStorage.setItem('kwd.railWide', wide ? '0' : '1');
      } catch {
        /* 이번만 */
      }
      this.renderRail();
    });
    this.rail.append(tg);
    for (const it of this.railItems()) {
      const vis = h('span', { class: 'ri-vis' });
      if (it.thumb && wide) {
        const im = h('img', { class: 'ri-thumb', alt: '', loading: 'lazy', draggable: 'false' }) as HTMLImageElement;
        im.src = it.thumb;
        vis.append(im);
      } else if (it.ic) {
        vis.append(icon(it.ic));
        if (it.label && !wide) vis.append(h('span', { class: 'ri-n' }, it.label)); // 슬라이드 쪽 번호
      } else vis.append(h('span', { class: 'ri-n' }, it.label || it.icon));
      const b = h('button', { type: 'button', class: 'rail-item' + (it.key === this.railOn ? ' on' : '') + (it.icon || it.ic ? ' ico' : ''), title: it.title, 'aria-label': it.title, 'data-key': it.key, 'data-page': it.page }, vis);
      if (wide) b.append(h('span', { class: 'ri-name' }, it.name || it.title));
      b.addEventListener('click', () => this.gotoItem(it.key));
      this.rail.append(b);
    }
  }
  private railOn = 'note';
  private railTimer = 0;
  private renderRailSoon() {
    window.clearTimeout(this.railTimer);
    this.railTimer = window.setTimeout(() => this.renderRail(), 120);
  }

  private findBoxEditor(id: string): Editor | undefined {
    for (const v of this.views.values()) {
      const objs = v.objs;
      if (!objs) continue;
      const ed = objs.editors.get(id);
      if (ed) return ed;
      for (const w of objs.wsObjects()) {
        const e2 = w.editors.get(id);
        if (e2) return e2;
      }
    }
    return undefined;
  }

  // 필기 넣은 학습지: 학생 폴더(수업필기/)에 저장, 안 되면 내려받기
  async saveWorksheet(page: string, id: string) {
    const o = this.store.objList(page).find((x) => x.id === id);
    if (!o) return;
    const who = this.pack?.name || this.studentNo();
    const r = annotatedWorksheet(this.store, o, who);
    if (!r) return;
    const d = new Date(Number(this.store.meta.get('startedAt') || Date.now()));
    const name = `${(o.name || '학습지').replace(/[\\/:*?"<>|#\s]+/g, '_').replace(/^_+/, '')}_수업필기_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.html`;
    if (this.packFolder) {
      const saved = await saveToStudentFolder(this.packFolder, '수업필기', name, r.html);
      if (saved) {
        toast(`학생 폴더에 저장했어요: 수업필기/${name} (필기 ${r.count}개)`, 4000);
        return;
      }
    }
    download(name, r.html, 'text/html');
    toast(`필기 ${r.count}개를 넣은 학습지를 내려받았어요`, 3000);
  }

  // 물건 하나를 화면에 꽉 차게 (look: 학생 화면도)
  gotoObj(page: string, id: string, look = false) {
    const v = this.views.get(page);
    const o = this.store.objList(page).find((x) => x.id === id);
    if (!v || !o) return;
    this.userMovedView();
    // 글상자는 글이 늘면 화면에서만 커진다 → 실제 높이로
    const el = v.el.querySelector<HTMLElement>(`[data-obj="${id}"]`);
    const oh = Math.max(o.h, el?.offsetHeight || 0);
    this.fitRect(o.x, v.y + o.y, o.x + o.w, v.y + o.y + oh, 24);
    if (look) {
      this.store.setSetting('look', { x0: o.x, y0: v.y + o.y, x1: o.x + o.w, y1: v.y + o.y + oh, t: Date.now() });
    }
    this.pushViewport();
  }

  // 목록에서 고른 것을 화면에 꽉 차게
  gotoItem(key: string) {
    const it = this.railItems().find((x) => x.key === key);
    if (!it) return;
    this.railOn = key;
    this.currentPage = it.page;
    this.userMovedView();
    if (key === 'note') {
      const [W] = this.vp.size();
      const s = Math.min(1.2, (W - this.panelSide() - (W > 900 ? 140 : 16)) / TEXT_W);
      this.vp.set({ s, x: (W - this.panelSide() - TEXT_W * s) / 2, y: 70 - it.rect[1] * s });
    } else this.fitRect(it.rect[0], it.rect[1], it.rect[2], it.rect[3]);
    this.renderRail();
    if (this.role === 'teacher') {
      this.store.log({ kind: 'page', page: it.page, id: key === 'note' ? undefined : key, data: { op: 'show', item: it.title } });
      // 목록에서 고르면 학생 화면도 같은 것으로 (10/18: 나란히에서 학생은 판 전체를 아주 작게 보고 있었다)
      const [x0, y0, x1, y1] = it.rect.map((v) => Math.round(v));
      this.store.setSetting('look', { x0, y0, x1, y1: key === 'note' ? Math.min(y1, y0 + 900) : y1, t: Date.now(), quiet: true });
    }
    this.pushViewport();
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
    if (this.isCanvas(id)) return this.gotoItem('note');
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

  private viewTimer = 0;
  private updateCurrentFromView() {
    window.clearTimeout(this.viewTimer);
    this.viewTimer = window.setTimeout(() => {
      const [cx, cy] = this.vp.center();
      let best: string | null = null;
      let bestA = Infinity;
      let page = this.currentPage;
      for (const it of this.railItems()) {
        const [x0, y0, x1, y1] = it.rect;
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
          const a = (x1 - x0) * (y1 - y0);
          if (a < bestA) {
            bestA = a;
            best = it.key;
            page = it.page;
          }
        }
      }
      if (best && best !== this.railOn) {
        this.railOn = best;
        this.renderRail();
      }
      if (page !== this.currentPage) this.currentPage = page;
    }, 150);
  }

  // ================= 뷰포트 =================
  private initialView() {
    const [w] = this.vp.size();
    const s = Math.min(1, (w - (w > 900 ? 140 : 16)) / TEXT_W);
    this.vp.set({ s, x: (w - TEXT_W * s) / 2, y: w < 700 ? 64 : 70 });
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
    pct.title = '전체 보기 (판 위의 것 모두)';
    pct.addEventListener('click', () => {
      this.userMovedView();
      const [x0, y0, x1, y1] = this.bounds;
      this.fitRect(x0, y0, x1, y1, 30, 1);
    });
    box.append(minus, pct, plus);
    this.vp.onChange((v) => (pct.textContent = Math.round(v.s * 100) + '%'));
    return box;
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
    // 학생이 직접 넘기면 '자유' (따라가기 버튼으로 다시 선생님 쪽)
    prev.addEventListener('click', () => {
      this.userMovedView();
      this.step(-1);
    });
    next.addEventListener('click', () => {
      this.userMovedView();
      this.step(1);
    });
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
    // 판 바탕 점무늬가 판과 함께 움직인다 (무한 판이라는 느낌)
    const grid = () => {
      const { x, y, s: sc } = this.vp.view;
      const g = 28 * sc;
      stage.style.backgroundSize = `${g}px ${g}px`;
      stage.style.backgroundPosition = `${x}px ${y}px`;
      // 판 위 자료의 고르기 막대·크기 손잡이는 판 배율을 거꾸로 곱해 화면에서 늘 같은 크기
      this.root.style.setProperty('--inv', String(1 / Math.max(0.05, sc)));
    };
    this.vp.onChange(grid);
    grid();
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
      if (t.closest('.obj-slide') && !t.closest('button')) return true;
      if (t.closest('.obj, .mat-frame')) return false;
      if (t === this.stage || t === this.world || t === this.pagesHost || t.classList.contains('canvas')) return true;
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
    this.stage.addEventListener('dblclick', (e) => {
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

    // 파일을 판 위에 끌어다 놓기 (사진·PDF·웹 학습지·문서·소리·영상)
    stage.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.root.classList.add('dropping');
    });
    stage.addEventListener('dragleave', (e) => {
      if (e.target === stage) this.root.classList.remove('dropping');
    });
    stage.addEventListener('drop', (e) => {
      this.root.classList.remove('dropping');
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length || !canMake()) return;
      e.preventDefault();
      const at = this.pageAt(e.clientX, e.clientY);
      if (at) this.currentPage = at.page;
      void this.handleFiles(files);
    });
    // 녹음 중 표시 (누르면 끝)
    const recBtn = h('button', { type: 'button', class: 'rec-btn', title: '녹음 끝내기' }, '● 녹음 끝내기');
    recBtn.addEventListener('click', () => void this.toggleRecord());
    this.root.append(recBtn);

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

  // 선생님: 학생 화면을 여기로. 고른 것이 있으면 그것을, 없으면 지금 내 화면을
  lookHere() {
    let rect: [number, number, number, number];
    const sel = this.selObj ? this.store.objList(this.selObj.page).find((o) => o.id === this.selObj!.id) : null;
    const pv = this.selObj ? this.views.get(this.selObj.page) : null;
    if (sel && pv) rect = [sel.x, pv.y + sel.y, sel.x + sel.w, pv.y + sel.y + sel.h];
    else {
      const [W, H] = this.vp.size();
      const [x0, y0] = this.vp.toWorld(this.stage.getBoundingClientRect().left, this.stage.getBoundingClientRect().top + 56);
      const s = this.vp.view.s;
      rect = [x0, y0, x0 + (W - this.panelSide()) / s, y0 + (H - 56 - 90) / s];
    }
    const [x0, y0, x1, y1] = rect.map((v) => Math.round(v));
    this.store.setSetting('look', { x0, y0, x1, y1, t: Date.now() });
    toast('학생 화면을 여기로 옮겼어요');
  }

  private flashLook() {
    const el = h('div', { class: 'look-flash' }, '선생님: 여기 보세요');
    this.root.append(el);
    window.setTimeout(() => el.remove(), 1800);
  }

  private userMovedView() {
    if (this.role === 'teacher') return;
    this.followOnce = false;
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
    // 선생님 화면에 보이는 세상 네모가 내 화면에 다 들어오게 (기기마다 크기는 달라도 내용·위치는 같다)
    let tw = t.w / t.s, th = t.h / t.s;
    // 폰처럼 좁은 화면: 선생님 화면 가운데 60% 만 (다 넣으면 글이 너무 작다)
    const [W] = this.vp.size();
    if (W < 700 && t.w > W * 1.4) {
      tw *= 0.6;
      th *= 0.6;
    }
    this.fitRect(t.cx - tw / 2, t.cy - th / 2, t.cx + tw / 2, t.cy + th / 2, 8, this.vp.max);
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
        if (this.role !== 'teacher' && this.following) {
          this.applyTeacherView();
          // 처음 들어올 때 한 번만 선생님 화면으로. 그 뒤로는 각자 (선생님이 '따라오기'를 켰거나 '여기 보세요'를 누르면 다시)
          if (!this.store.getSetting('followAll', false) && this.followOnce) {
            this.followOnce = false;
            this.following = false;
            this.followBtn.hidden = false;
          }
        }
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
      this.toolbar.classList.toggle('no-write', !studentWrite);
      this.root.classList.toggle('mat-locked', !studentMat);
    }
    if (this.role === 'assist') {
      for (const ed of this.editors.values()) ed.setEditable(false, false);
      for (const v of this.views.values()) v.objs?.setEditable(false);
      this.root.classList.add('mat-locked');
    }
    this.root.classList.toggle('hide-carets', !showCaret && this.role === 'student');
    // '여기 보세요': 학생 화면을 선생님이 고른 곳으로 (그 뒤로는 학생이 움직이기 전까지 따라감)
    const look = this.store.getSetting<{ x0: number; y0: number; x1: number; y1: number; t: number; quiet?: boolean } | null>('look', null);
    if (this.role !== 'teacher' && look && look.t !== this.lookSeen) {
      const first = this.lookSeen === 0 && Date.now() - look.t > 15000; // 늦게 들어온 학생에게 옛날 것은 다시 안 함
      this.lookSeen = look.t;
      if (!first) {
        this.following = true;
        this.followBtn.hidden = true;
        this.fitRect(look.x0, look.y0, look.x1, look.y1, 16, this.vp.max);
        if (!look.quiet) this.flashLook();
      }
    }
    if (this.role !== 'teacher' && this.store.getSetting('followAll', false) && !this.following) {
      this.following = true;
      this.followBtn.hidden = true;
      this.applyTeacherView();
    }
    const single = this.single();
    this.root.classList.toggle('mode-single', single);
    this.singleNav.hidden = !single;
    this.renderTimer();
    this.renderPopup();
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
    // 아이콘 한 가지 모양의 줄 (10/19 UI/UX): 단추 44px, 이름·단축키는 마우스를 올리면. 처음 세 번은 아이콘 아래 작은 이름
    const bar = h('div', { class: 'toolbar' });
    const btn = (id: string, ic: string, label: string, title: string, cls = '') => {
      const b = h('button', { type: 'button', class: `tb ${cls}`, 'data-tool': id, title, 'aria-label': label }, icon(ic), h('span', { class: 'tb-label' }, label));
      return b;
    };
    const select = btn('select', 'select', '선택', '선택 (V) · 필기·사진·글상자를 골라 옮기기 · 빈 곳을 끌면 여러 개');
    const text = btn('text', 'text', '글', '글 (T) · 빈 곳을 두 번 누르면 글상자');
    this.slots = [0, 1, 2].map((i) => penSlot(i, this.prefs.pens[i]));
    const hl = penSlot(3, this.prefs.hl, true);
    this.slots.push(hl);
    const eraser = btn('eraser', this.prefs.eraserMode === 'part' ? 'eraserPart' : 'eraser', '지우개', '지우개 (E) · 한 번 더 누르면 획 전체/닿은 부분·크기');
    const laser = btn('laser', 'laser', '레이저', '레이저 (L) · 가리키면 학생 화면에도 보이고 1.5초 뒤 사라져요');
    const undo = btn('undo', 'undo', '되돌리기', '되돌리기 (Ctrl+Z)');
    const redo = btn('redo', 'redo', '다시', '다시하기 (Ctrl+Shift+Z)');
    const imp = btn('import', 'add', '넣기', '넣기 · 사진 · PDF/슬라이드 · 웹 학습지 · 유튜브');
    const more = btn('more', 'more', '더보기', '더보기 · 학생 허락 · 기록 · 학생 링크');
    const sep = () => h('span', { class: 'tb-sep' });
    const pens = h('span', { class: 'tb-pens' }, ...this.slots);
    if (this.role === 'teacher') bar.append(select, text, sep(), pens, eraser, laser, sep(), undo, redo, sep(), imp, more);
    else if (this.role === 'assist') bar.append(pens, eraser, laser, sep(), undo, redo);
    else {
      // 학생: 글·펜·지우개·되돌리기 + 과제 사진 찍어 올리기 (글 쓰기 허락이 있을 때)
      const cam = btn('camera', 'camera', '사진', '사진 찍어 판에 올리기', 'cam');
      bar.append(text, pens, eraser, undo, cam);
    }
    try {
      const seen = Number(localStorage.getItem('kwd.tb.seen') || 0) + 1;
      localStorage.setItem('kwd.tb.seen', String(seen));
      if (seen <= 3) bar.classList.add('with-labels');
    } catch {
      /* 저장 못 하면 이름 없이 */
    }
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      if (b.dataset.slot != null) return this.pickSlot(Number(b.dataset.slot), b);
      const id = b.dataset.tool;
      if (id === 'text') this.setTool('text');
      else if (id === 'select') this.setTool('select');
      else if (id === 'laser') this.setTool('laser');
      else if (id === 'eraser') {
        if (this.tool === 'eraser') this.openPenPopover('eraser', b);
        else this.setTool('eraser');
      } else if (id === 'undo') this.undo.undo();
      else if (id === 'redo') this.undo.redo();
      else if (id === 'import') this.openImport(b);
      else if (id === 'camera') this.pickFile('image/*', true, (files) => void this.insertImages(files), true);
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
    this.ink.eraserMode = this.prefs.eraserMode || 'stroke';
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
      onEraserMode: (m) => {
        this.prefs.eraserMode = m;
        savePrefs(this.role, this.prefs);
        this.applyPenStyle();
        const eb = this.toolbar.querySelector('[data-tool="eraser"] .ic');
        if (eb) eb.replaceWith(icon(m === 'part' ? 'eraserPart' : 'eraser'));
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
    // 도구 줄이 위에 있으면 아래로 연다
    if (r.top < window.innerHeight / 2) pop.style.top = r.bottom + 10 + 'px';
    else pop.style.bottom = window.innerHeight - r.top + 10 + 'px';
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
        b.classList.toggle('on', (t === 'pen' && i === this.prefs.active) || (t === 'hl' && i === 3));
      } else if (b.dataset.tool) b.classList.toggle('on', b.dataset.tool === t);
    });
    this.closePopover();
    if (t !== 'select') this.clearSelection();
    for (const v of this.views.values()) v.objs?.refreshSelection();
    if (t === 'text') {
      // 도구만 바꾼다. 커서를 억지로 두면 브라우저가 그 글로 화면을 끌고 가서(10/18) 쓰고 싶은 곳을 눌러 쓰게 한다
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
      else if (e.key === 'l' || e.key === 'L') this.setTool('laser');
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
    if (pageId.startsWith('ws:')) return { shape, block: pageId };
    const v = this.views.get(pageId);
    if (!v) return { shape };
    const s = this.vp.view.s;
    // 무한 판 위 슬라이드 쪽: 그 쪽 글자층에서 겹치는 낱말
    if (this.isCanvas(pageId)) {
      const sl = this.store.objList(pageId).find((o) => o.type === 'slide' && x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y);
      if (sl) {
        const md = this.store.matdata.get(`${sl.mid}/${sl.n}`);
        const k = md ? md.w / sl.w : 1;
        const [a0, a1, b0, b1] = [(x0 - sl.x) * k, (x1 - sl.x) * k, (y0 - sl.y) * k, (y1 - sl.y) * k];
        const pad = shape === 'underline' ? 14 : 2;
        const hit = (md?.text || []).filter((t) => t.x < a1 && t.x + t.w > a0 && t.y < b1 && t.y + t.h + pad > b0 - (shape === 'underline' ? 18 : 0));
        const txt = joinText(hit).replace(/\n/g, ' ').slice(0, 80);
        return { shape, text: txt || undefined, block: `mat:${sl.mid}:${sl.n}` };
      }
      const box = this.store.objList(pageId).find((o) => o.type !== 'box' && x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y);
      if (box) return { shape, block: `obj:${box.id}` };
    }
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
      item('웹 학습지', '.html · 학생이 직접 누르고, 그 위에 필기 (단계마다 따로 저장)', () => this.pickFile('.html,.htm,text/html', false, (files) => void this.importHtmlFile(files[0]))),
      item('사진', '지금 보는 곳에 · 끌어서 옮기고 모서리로 크기', () => this.pickFile('image/*', true, (files) => void this.insertImages(files))),
      item('PDF · 슬라이드', '쪽마다 한 장씩 판 위에 가로로 · PPT는 PDF로 저장해서', () => this.pickFile('application/pdf,.pdf', false, (files) => void this.importPdfFile(files[0]))),
      item('소리 · 영상', '판 위 재생기로 · mp3 · m4a · mp4 …', () => this.pickFile('audio/*,video/*', true, (files) => void this.handleFiles(files))),
      item('유튜브 링크', '작은 창으로 · ⤢ 크게 하면 학생 화면에도', () => this.askYoutube()),
      item('문서 (.md · .txt)', '고칠 수 있는 큰 글상자로', () => this.pickFile('.md,.markdown,.txt,text/markdown,text/plain', false, (files) => void this.handleFiles(files))),
      item(this.recorder ? '녹음 끝내기' : '녹음하기', '내 목소리를 소리 재생기로', () => void this.toggleRecord()),
    );
    this.showPanel(menu, anchor);
  }

  private pickFile(accept: string, multiple: boolean, fn: (f: File[]) => void, capture = false) {
    const input = h('input', { type: 'file', accept }) as HTMLInputElement;
    if (multiple) input.multiple = true;
    if (capture) input.setAttribute('capture', 'environment');
    const t0 = performance.now();
    input.addEventListener('change', () => input.files?.length && fn(Array.from(input.files)));
    // 고르기 창이 막힌 곳(Claude 앱 안 브라우저 등)에서는 바로 취소된다 → 끌어다 놓기 안내
    input.addEventListener('cancel', () => performance.now() - t0 < 600 && toast('이 창에서는 파일 고르기가 열리지 않아요. 파일을 판 위에 끌어다 놓거나 크롬·엣지에서 여세요.', 5000));
    input.click();
  }

  // 끌어다 놓은·고른 파일을 종류에 맞게 (사진·PDF·웹 학습지·문서·소리·영상)
  async handleFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) await this.insertImages(imgs);
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (f.type === 'application/pdf' || n.endsWith('.pdf')) await this.importPdfFile(f);
      else if (/\.html?$/.test(n) || f.type === 'text/html') this.placeHtml(await f.text(), f.name.replace(/\.html?$/i, ''));
      else if (/\.(md|markdown|txt)$/.test(n)) await this.importDoc(await f.text(), f.name.replace(/\.(md|markdown|txt)$/i, ''));
      else if (f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|webm|aac)$/.test(n) && !f.type.startsWith('video/')) await this.insertMedia(f, 'audio');
      else if (f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/.test(n)) await this.insertMedia(f, 'video');
    }
  }

  // 소리·영상: 페이지 위 재생기
  async insertMedia(file: File | Blob, kind: 'audio' | 'video', name = (file as File).name || (kind === 'audio' ? '녹음' : '영상')) {
    const page = this.views.get(this.currentPage) ? this.currentPage : this.order[0];
    if (file.size > 40 * 1024 * 1024) {
      toast('40MB 넘는 파일은 판에 넣지 않아요. 유튜브 링크나 더 작은 파일로 넣어 주세요.', 5000);
      return;
    }
    let src = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    if (this.store.status === 'connected') {
      const key = `${kind}-${Date.now().toString(36)}.${kind === 'audio' ? 'webm' : 'mp4'}`;
      if (await this.store.putBlob(key, file)) src = 'blob:' + key;
    }
    let w = kind === 'audio' ? 340 : 480, hh = kind === 'audio' ? 86 : 302;
    if (kind === 'video') {
      const dims = await new Promise<[number, number] | null>((res) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => res(v.videoWidth ? [v.videoWidth, v.videoHeight] : null);
        v.onerror = () => res(null);
        v.src = src.startsWith('blob:') && !src.startsWith('blob:http') ? this.store.resolveImg(src) : src;
      });
      if (dims) hh = Math.round((w * dims[1]) / dims[0]) + 32;
    }
    const [x, y] = this.spotOnPage(page, w, hh);
    const o = this.store.addObj(page, { type: kind, x, y, w, h: hh, src, name });
    this.selectObj(page, o.id);
  }

  addYoutube(url: string, page = this.currentPage) {
    const id = youtubeId(url);
    if (!id) {
      toast('유튜브 주소를 알아보지 못했어요.');
      return;
    }
    const pg = this.views.get(page) ? page : this.order[0];
    const w = 520, hh = Math.round((520 * 9) / 16) + 32;
    const [x, y] = this.spotOnPage(pg, w, hh);
    const o = this.store.addObj(pg, { type: 'youtube', x, y, w, h: hh, url, name: '유튜브' });
    this.selectObj(pg, o.id);
    return o.id;
  }

  private askYoutube() {
    const box = h('div', { class: 'menu wide' });
    const input = h('input', { type: 'url', class: 'link-input', placeholder: 'https://www.youtube.com/watch?v=…  또는 youtu.be/…' }) as HTMLInputElement;
    const ok = h('button', { type: 'button', class: 'mi small' }, '넣기');
    const go = () => {
      if (!input.value.trim()) return;
      this.closePanel();
      this.addYoutube(input.value.trim());
    };
    ok.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    });
    box.append(h('div', { class: 'mh' }, '유튜브 링크'), h('div', { class: 'link-row' }, input, ok), h('p', { class: 'mnote' }, '페이지 위에 작은 창으로 놓이고, ⤢ 크게 를 누르면 학생 화면에도 크게 떠요.'));
    this.showPanel(box);
    window.setTimeout(() => input.focus(), 0);
  }

  // 녹음 → 소리 재생기 (선생님 목소리·학생 발음)
  private recorder: MediaRecorder | null = null;
  async toggleRecord() {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('마이크를 쓸 수 없어요. 브라우저의 마이크 허용을 확인해 주세요.', 4000);
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.root.classList.remove('recording');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const d = new Date();
      void this.insertMedia(blob, 'audio', `녹음 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    rec.start();
    this.recorder = rec;
    this.root.classList.add('recording');
    toast('녹음 중… 빨간 단추를 누르면 끝나요', 3000);
  }

  // 문서(.md·.txt) → 새 글 페이지
  async importDoc(text: string, name: string) {
    const { marked } = await import('marked');
    const DOMPurify = (await import('dompurify')).default;
    const html = DOMPurify.sanitize(marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, ''), { async: false, gfm: true }) as string);
    // 무한 판: 문서는 고칠 수 있는 큰 글상자로
    const c = this.canvasId();
    const [x, y] = this.spotOnPage(c, 560, 400);
    const o = this.store.addObj(c, { type: 'box', x, y, w: 560, h: 44, name });
    this.store.log({ kind: 'material', page: c, id: o.id, data: { op: 'import', type: 'md', name, chars: text.length } });
    const ed = this.views.get(c)?.objs?.editors.get(o.id);
    if (ed) ed.chain().insertContent(html).run();
    window.setTimeout(() => this.gotoObj(c, o.id), 60);
    return o.id;
  }

  // 모두의 화면에 크게 (사진·영상·유튜브)
  setPopup(p: { page: string; id: string } | null) {
    if (this.role !== 'teacher') {
      this.popupClosedLocally = p ? '' : this.popupKey();
      this.renderPopup();
      return;
    }
    this.store.setSetting('popup', p ? { ...p, t: Date.now() } : null);
  }
  private popupClosedLocally = '';
  private popupEl: HTMLElement | null = null;
  private popupKey(): string {
    const p = this.store.getSetting<{ page: string; id: string; t: number } | null>('popup', null);
    return p ? `${p.page}/${p.id}/${p.t}` : '';
  }
  private renderPopup() {
    const p = this.store.getSetting<{ page: string; id: string; t: number } | null>('popup', null);
    const key = this.popupKey();
    if (!p || key === this.popupClosedLocally) {
      this.popupEl?.remove();
      this.popupEl = null;
      return;
    }
    if (this.popupEl?.dataset.key === key) return;
    this.popupEl?.remove();
    const o = this.store.objList(p.page).find((x) => x.id === p.id);
    if (!o) return;
    const wrap = h('div', { class: 'popup', 'data-key': key });
    const close = h('button', { type: 'button', class: 'popup-x', title: '닫기' }, this.role === 'teacher' ? '× 모두 닫기' : '×');
    close.addEventListener('click', () => {
      if (this.role === 'teacher') this.setPopup(null);
      else {
        this.popupClosedLocally = key;
        this.renderPopup();
      }
    });
    let content: HTMLElement;
    if (o.type === 'img') {
      content = h('img', { class: 'popup-media', alt: o.name || '' });
      (content as HTMLImageElement).src = this.store.resolveImg(o.src);
    } else if (o.type === 'video') {
      content = h('video', { class: 'popup-media', controls: '', playsinline: '', autoplay: '' });
      const u = this.store.resolveImg(o.src);
      if (/^https?:/.test(u) && !u.startsWith(location.origin)) (content as HTMLVideoElement).crossOrigin = 'anonymous';
      (content as HTMLVideoElement).src = u;
    } else if (o.type === 'youtube') {
      content = h('iframe', { class: 'popup-media popup-yt', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: '', title: '유튜브' });
      (content as HTMLIFrameElement).src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId(o.url || '') || '')}?rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}&autoplay=1`;
    } else return;
    wrap.append(content, close);
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target === wrap) close.click();
    });
    this.root.append(wrap);
    this.popupEl = wrap;
    if (this.role === 'teacher') this.store.log({ kind: 'object', page: p.page, id: p.id, data: { op: 'popup', type: o.type } });
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
    if (this.isCanvas(page)) return this.freeSpot(page, cx - w / 2, cy - v.y - hh / 2, w, hh);
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

  // 무한 판: 화면 가운데 근처의 빈자리 (노트 카드·다른 것과 겹치지 않게)
  private freeSpot(page: string, x: number, y: number, w: number, hh: number): [number, number] {
    const v = this.views.get(page)!;
    const note: [number, number, number, number] = [0, 0, TEXT_W, (v.editorHost?.offsetHeight || 400) + 20];
    const rects: Array<[number, number, number, number]> = [note, ...this.store.objList(page).map((o) => [o.x, o.y, o.x + o.w, o.y + o.h] as [number, number, number, number])];
    const hit = (px: number, py: number) => rects.some(([a, b, c, d]) => px < c + 16 && px + w > a - 16 && py < d + 16 && py + hh > b - 16);
    let px = Math.round(x), py = Math.round(y);
    // 노트 위에 떨어지면 노트 오른쪽으로
    if (px < note[2] && px + w > note[0] && py < note[3]) px = note[2] + 48;
    for (let k = 0; k < 200 && hit(px, py); k++) py += 40;
    return [Math.round(px), Math.round(py)];
  }

  private pageAt(clientX: number, clientY: number): { page: string; x: number; y: number } | null {
    const [wx, wy] = this.vp.toWorld(clientX, clientY);
    for (const b of this.pageBoxes()) {
      if (!b.visible || b.infinite || b.id.startsWith('ws:')) continue;
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return { page: b.id, x: wx - b.x, y: wy - b.y };
    }
    const c = this.canvasId();
    const cv = this.views.get(c);
    return cv ? { page: c, x: wx, y: wy - cv.y } : null;
  }

  // 글상자: 그 자리에 바로 쓰기
  addBox(page: string, x: number, y: number) {
    const v = this.views.get(page);
    if (!v) return;
    const w = Math.min(BOX_W, v.info.w - 24);
    const free = this.isCanvas(page);
    const o = this.store.addObj(page, { type: 'box', x: Math.round(free ? x - 12 : Math.max(8, Math.min(v.info.w - w - 8, x - 12))), y: Math.round(free ? y - 18 : Math.max(8, y - 18)), w, h: 44 });
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

  // PDF·슬라이드 → 판 위에 쪽마다 한 장씩 가로로 (지금까지 놓인 것 아래 줄)
  private slidePlacer() {
    const c = this.canvasId();
    const [, , , by] = this.bounds;
    const cv = this.views.get(c);
    const y0 = Math.round(by - (cv?.y || 0) + 120);
    let x = 0;
    return (mid: string, n: number, w: number, hh: number) => {
      const o = this.store.addObj(c, { type: 'slide', x, y: y0, w, h: hh, mid, n });
      x += w + 48;
      return o.id;
    };
  }
  async importPdfToCanvas(data: File | ArrayBuffer, name: string): Promise<string[]> {
    const ids = await importPdf(this.store, data, name, 0, (d, n) => toast(`PDF ${d}/${n}쪽`, 60000), this.slidePlacer());
    this.layout();
    const first = ids[0];
    if (first) window.setTimeout(() => this.gotoItem(first), 60);
    return ids;
  }

  private async importPdfFile(file: File) {
    const t = toast('PDF 가져오는 중…', 60000);
    try {
      const ids = await this.importPdfToCanvas(file, file.name.replace(/\.pdf$/i, ''));
      toast(`${ids.length}쪽을 가져왔어요`);
    } catch (e) {
      console.error(e);
      toast('PDF를 열 수 없어요. 암호가 걸렸거나 손상된 파일일 수 있어요.');
    }
    void t;
  }

  async importPdfBytes(b64: string, name: string) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return this.importPdfToCanvas(bin.buffer, name);
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
    // KWD 폴더 학생은 오늘 탭의 '대화 재료'가 이 일을 한다 → 노트에 머리말을 넣지 않는다 (10/18)
    if (!this.memory || this.pack || this.store.meta.get('headerAt')) return;
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
    if (isDemo() && !this.store.meta.get('demoSeeded')) await this.seedDemo(pack);
    if (interactive && !this.memPanel) this.toggleMemPanel();
    else if (this.memPanel) this.renderMemPanel();
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback || ((f: () => void) => window.setTimeout(f, 300));
    ric(() => {
      void buildMemory(pack)
        .then((m) => this.setMemory(m))
        .catch((e) => console.warn('memory', e));
    });
  }

  // 글을 지금 페이지 위 글상자로 (과제 답 등)
  placeTextBox(text: string) {
    const page = this.views.get(this.currentPage) ? this.currentPage : this.order[0];
    const lines = text.split(/\n/).length;
    const [x, y] = this.spotOnPage(page, 360, 40 + lines * 30);
    const o = this.store.addObj(page, { type: 'box', x, y, w: 360, h: 44 });
    const frag = this.store.boxFragment(o.id);
    this.store.doc.transact(() => {
      for (const line of text.split(/\n/)) {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(line)]);
        frag.push([p]);
      }
    }, LOCAL);
    this.selectObj(page, o.id);
    toast('판에 넣었어요');
  }

  private async placePackFile(f: PackFile) {
    const file = await readPackFile(this.packFolder, f.path);
    if (!file) throw new Error('no file');
    const base = f.name.replace(/\.[^.]+$/, '');
    if (f.kind === 'html') this.placeHtml(await file.text(), base);
    else if (f.kind === 'audio' || f.kind === 'video') await this.insertMedia(file, f.kind, base);
    else if (f.kind === 'text') this.placeTextBox(await file.text());
    else if (f.kind === 'md') await this.importDoc(await file.text(), base);
    else if (f.kind === 'img') await this.insertImages([file]);
    else if (f.kind === 'pdf') await this.importPdfToCanvas(await file.arrayBuffer(), base);
  }

  // 체험: 무한 판 위에 수업 자료를 종류마다 한 자리씩 깔아 둔다
  //  노트(왼쪽) │ 수업 페이지(인터랙티브 웹 학습지) │ 사진·유튜브 │ 듣기 │ 지난 과제
  private async seedDemo(pack: StudentPack) {
    this.store.doc.transact(() => {
      this.store.meta.set('demoSeeded', Date.now());
      this.store.meta.set('headerAt', Date.now());
    }, 'meta');
    toast('체험 판을 꾸미는 중…', 30000);
    const c = this.canvasId();
    const find = (re: RegExp) => pack.files.find((f) => re.test(f.name)) || pack.hwFiles.find((f) => re.test(f.name));
    const file = async (re: RegExp) => {
      const f = find(re);
      return f ? readPackFile(this.packFolder, f.path) : null;
    };
    const label = (x: number, y: number, text: string, w = 420) => {
      const o = this.store.addObj(c, { type: 'box', x, y, w, h: 44 });
      const frag = this.store.boxFragment(o.id);
      this.store.doc.transact(() => {
        const hh = new Y.XmlElement('heading');
        hh.setAttribute('level', 3 as unknown as string);
        hh.insert(0, [new Y.XmlText(text)]);
        frag.push([hh]);
      }, LOCAL);
    };
    const X = TEXT_W + 80;
    try {
      // 노트는 비워 둔다: 수업 내용은 수업 페이지·슬라이드에 (10/18)
      // 1) 수업 페이지 (인터랙티브): 학생이 직접 누르고, 그 위에 단계마다 필기
      const ws = await file(/수업페이지\.html$/);
      if (ws) {
        label(X, -60, '① 수업 페이지 — 학생이 직접 눌러요 · 단계마다 필기가 따로 남아요', 760);
        const mid = randomId(8);
        const html = await ws.text();
        this.store.doc.transact(() => {
          this.store.materials.set(mid, { id: mid, name: '#12 수업 페이지', type: 'html', pages: 1 });
          this.store.matdata.set(`${mid}/1`, { html, w: 960, h: 600 });
        }, 'import');
        this.store.addObj(c, { type: 'html', x: X, y: 0, w: 962, h: 634, mid, name: '#12 수업 페이지', step: 1, steps: 7 });
      }
      // 2) 사진 · 유튜브
      const Y2 = 720;
      label(X, Y2 - 60, '② 사진 · 유튜브 — ⤢ 크게 누르면 학생 화면에도');
      const photo = await file(/시장사진/);
      if (photo) {
        const url = await fileToDataUrl(photo);
        this.store.addObj(c, { type: 'img', x: X, y: Y2, w: 450, h: 300, ratio: 1.5, src: url, name: '추석 시장' });
      }
      this.store.addObj(c, { type: 'youtube', x: X + 490, y: Y2, w: 472, h: Math.round((472 * 9) / 16) + 32, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', name: '유튜브' });
      // 3) 듣기
      const Y3 = 1120;
      label(X, Y3 - 60, '③ 듣기 — 판 안에서 바로 재생');
      const vid = await file(/듣기영상\.mp4$/);
      if (vid) {
        this.currentPage = c;
        await this.insertMedia(vid, 'video', '듣기 영상');
        const o = this.store.objList(c).find((x) => x.type === 'video');
        if (o) this.store.updateObj(c, o.id, { x: X, y: Y3 });
      }
      const au = await file(/듣기\.ogg$/);
      if (au) {
        await this.insertMedia(au, 'audio', '듣기 소리');
        const o = this.store.objList(c).filter((x) => x.type === 'audio').pop();
        if (o) this.store.updateObj(c, o.id, { x: X + 520, y: Y3 });
      }
      // 4) 지난 과제 (학생이 낸 손글씨·녹음·글) — 과제 탭에서 하나씩 넣을 수도 있다
      const Y4 = 1560;
      label(X, Y4 - 60, '④ 학생이 낸 과제 — 이 학생 → 과제 탭에 날마다 다 있어요', 760);
      const hwImg = await file(/숙제_손글씨/);
      if (hwImg) this.store.addObj(c, { type: 'img', x: X, y: Y4, w: 420, h: 319, ratio: 1000 / 760, src: await fileToDataUrl(hwImg), name: '숙제 손글씨' });
      const hwAu = await file(/숙제_녹음/);
      if (hwAu) {
        await this.insertMedia(hwAu, 'audio', '숙제 녹음');
        const o = this.store.objList(c).filter((x) => x.type === 'audio').pop();
        if (o) this.store.updateObj(c, o.id, { x: X + 460, y: Y4 });
      }
      this.clearSelection();
      this.layout();
      this.gotoItem('note');
      const [x0, y0, x1, y1] = this.bounds;
      this.fitRect(x0, y0 - 80, x1, y1, 30, 1);
      toast('체험 판을 깔았어요 · 오른쪽 목록으로 하나씩 가 보세요', 3500);
      this.store.doc.transact(() => this.store.meta.set('demoReady', Date.now()), 'meta');
    } catch (e) {
      console.error('demo seed', e);
      toast('체험 자료 일부를 넣지 못했어요');
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
          insertLine: (line) => this.placeTextBox(line),
          placeFile: (f) => this.placePackFile(f),
          readLessonDoc: async (name) => (await (await readPackFile(this.packFolder, [name]))?.text()) || '',
          otherBoards: () => loadIndex().filter((b) => b.id !== this.store.id && folderForBoard(b.id) === this.packFolder),
          close: () => this.toggleMemPanel(),
          previewUrl: async (f) => {
            const file = await readPackFile(this.packFolder, f.path);
            return file ? URL.createObjectURL(file) : '';
          },
          hwConnected: () => !!hwConfig(),
          loadHistory: () => historyFromApp(this.pack?.name || '', this.pack?.id || ''),
          mediaUrl: async (m) => {
            if (m.fileId) {
              const r = await hwMedia(m.fileId);
              return { url: r.dataUrl, mime: r.mime };
            }
            const file = m.src ? await readPackFile(this.packFolder, ['과제', m.src]) : null;
            return file ? { url: URL.createObjectURL(file), mime: file.type } : { url: '', mime: '' };
          },
          placeMedia: async (m, label) => {
            let file: File | null = null;
            if (m.fileId) {
              const r = await hwMedia(m.fileId);
              file = new File([await (await fetch(r.dataUrl)).blob()], label, { type: r.mime });
            } else if (m.src) file = await readPackFile(this.packFolder, ['과제', m.src]);
            if (!file) return;
            if (m.kind === 'img') await this.insertImages([file]);
            else await this.insertMedia(file, 'audio', label);
          },
          hwMedia: (fid) => hwMedia(fid),
          placeData: async (dataUrl, mime, name) => {
            const blob = await (await fetch(dataUrl)).blob();
            const file = new File([blob], name, { type: mime });
            if (mime.startsWith('image/')) await this.insertImages([file]);
            else await this.insertMedia(file, mime.startsWith('video/') ? 'video' : 'audio', name);
          },
          placeText: (text) => this.placeTextBox(text),
          startTimer: (sec, label) => {
            this.startTimer(sec, label);
            toast(`${label} ${Math.round(sec / 60)}분 타이머`);
          },
          split: () => this.todaySplit(),
          setSplit: (segs) => {
            // 판에는 칸 이름·분만 (묶음 내용은 넣지 않는다)
            this.store.setSetting('split', segs.map((g) => ({ key: g.key, label: g.label, min: g.min })));
            this.store.log({ kind: 'segment_edit', data: { split: segs.map((g) => `${g.key}:${g.min}`).join(' ') } });
          },
          startSegment: (g) => {
            this.startTimer(g.min * 60, g.label);
            this.store.log({ kind: 'segment', data: { key: g.key, min: g.min, packet_id: this.pack?.packet?.packet_id || null } });
            toast(`${g.label} ${g.min}분 시작`);
          },
          placeTalkKit: (md) => void this.placeTalkKit(md),
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
    // 노트 줄로 끼우지 않고, 지금 보는 곳에 글상자로 (10/18)
    const insert = (line: string) => {
      this.placeTextBox(line);
      this.store.log({ kind: 'text', page: this.currentPage, src: 'memory', text: line, data: { op: 'place', tab: this.memTab } });
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
          const ins = h('button', { type: 'button', class: 'mp-ins', title: '지금 보는 곳에 글상자로 놓기' }, '판에 놓기');
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
      const { name, blob } = await buildBundle({ store: this.store, editors: this.editors, packetId: this.pack?.packet?.packet_id });
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

  // 수업 끝: 판 기록을 수업 폴더에. 기록 폴더가 정해져 있으면 거기에도(묻지 않고). 둘 다 없으면 내려받기
  private async saveLessonBundle(open: ((name: string) => Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> } | null>) | null): Promise<boolean> {
    const { name, blob } = await buildBundle({ store: this.store, editors: this.editors, packetId: this.pack?.packet?.packet_id });
    let ok = false;
    const w = open ? await open(name) : null;
    if (w) {
      await w.write(blob);
      await w.close();
      ok = true;
    }
    if (canPickFolder() && !EMBEDDED && (await folderName())) ok = (await writeToFolder(name, blob, true)) || ok;
    if (ok) {
      this.store.dirtySince = 0;
      this.lastBundleAt = Date.now();
      this.renderChip();
    } else downloadBlob(name, blob);
    return ok;
  }

  private async saveBundleNow() {
    const { name, blob } = await buildBundle({ store: this.store, editors: this.editors, packetId: this.pack?.packet?.packet_id });
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
    // 켬·끔 스위치: 눌러도 메뉴가 닫히지 않는다 (여러 개를 한 번에 바꾸기)
    const toggle = (label: string, key: string, def: boolean) => {
      const on = () => s.getSetting(key, def) as boolean;
      const el = h('button', { type: 'button', class: 'mi ' + (on() ? 'on' : 'off'), role: 'switch', 'aria-checked': String(on()), 'data-key': key }, h('span', {}, label));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        s.setSetting(key, !on());
        el.classList.toggle('on', on());
        el.classList.toggle('off', !on());
        el.setAttribute('aria-checked', String(on()));
      });
      return el;
    };
    const menu = h('div', { class: 'menu' });
    const cur = this.views.get(this.currentPage);
    const saved = this.lastBundleAt ? `${new Date(this.lastBundleAt).toTimeString().slice(0, 5)} 저장됨` : '';
    menu.append(
      h('div', { class: 'mh' }, '학생에게 허락'),
      toggle('글 쓰기', 'studentWrite', false),
      toggle('펜 쓰기', 'studentInk', false),
      toggle('학습지 버튼 누르기', 'studentMaterial', false),
      h('div', { class: 'mi-sep' }),
      toggle('학생에게 내 커서 보이기', 'showCaret', true),
      toggle('학생이 내 화면 따라오기', 'followAll', false),
      item('수업 요약 보기', () => this.openSummary()),
      item('지금 기록 저장', () => void this.saveBundleNow(), { sub: saved }),
      item('학생 링크', () => this.openLinks()),
      this.tbPosItem(),
      item('더 보기…', () => this.openMoreMenu(anchor)),
      ...(this.order.length > 1 && cur && !this.isCanvas(this.currentPage) ? [h('div', { class: 'mi-sep' }), item(`${this.order.indexOf(this.currentPage) + 1}페이지 지우기…`, () => this.confirmDeletePage(), { danger: true })] : []),
    );
    this.showPanel(menu, anchor);
  }

  // 도구 줄 위·아래 (태블릿에서 손바닥이 아래 줄을 가릴 때). 이 기기에만 저장. 줄이 옮겨 가므로 메뉴는 닫는다
  private tbPosItem(): HTMLElement {
    const top = () => this.root.classList.contains('tb-top');
    const el = h('button', { type: 'button', class: 'mi ' + (top() ? 'on' : 'off'), role: 'switch', 'aria-checked': String(top()), 'data-key': 'tbTop' }, h('span', {}, '도구 줄을 위에'));
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = !top();
      this.root.classList.toggle('tb-top', v);
      try {
        localStorage.setItem('kwd.tbTop', v ? '1' : '0');
      } catch {
        /* 이번만 */
      }
      el.classList.toggle('on', v);
      el.classList.toggle('off', !v);
      el.setAttribute('aria-checked', String(v));
      this.closePanel();
    });
    return el;
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
      item('숙제 연결', hwConfig() ? '연결됨' : 'KWD 숙제 앱 주소·선생님 키', () => this.openHwSettings()),
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
      if (r.top < window.innerHeight / 2) el.style.top = `${r.bottom + 10}px`;
      else el.style.bottom = `${window.innerHeight - r.top + 10}px`;
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

  private openTimerMenu(anchor: HTMLElement) {
    if (this.panel) return this.closePanel();
    const menu = h('div', { class: 'menu timer-menu' }, h('div', { class: 'mh' }, '타이머'));
    const row = h('div', { class: 'mi-chips' });
    for (const [label, sec] of [['30초', 30], ['1분', 60], ['3분', 180], ['5분', 300]] as Array<[string, number]>) {
      const b = h('button', { type: 'button', class: 'chip-btn' }, label);
      b.addEventListener('click', () => {
        this.closePanel();
        this.startTimer(sec);
      });
      row.append(b);
    }
    menu.append(row, h('p', { class: 'mnote' }, '오늘 탭의 수업 단계(대화·과제 피드백…)를 누르면 그 단계 타이머가 켜져요. 도는 타이머를 누르면 멈춰요.'));
    this.showPanel(menu, anchor);
  }

  private startTimer(seconds: number, label = '') {
    this.store.setSetting('timer', { endsAt: this.store.now() + seconds * 1000, seconds, label });
    this.store.log({ kind: 'timer', data: { seconds, label } });
  }

  // 오늘 시간 배분: 판에서 고친 분 → 수업 묶음(time_split) → 브리핑(prep.plan). 할 일 줄은 묶음·브리핑에서 (판에 저장 안 함)
  private todaySplit(): SplitSeg[] {
    const pk = this.pack?.packet?.time_split?.segments;
    const src: SplitSeg[] = pk?.length
      ? pk.map((g) => ({ key: g.key, label: g.label_ko, min: g.minutes, what: g.plan }))
      : (this.pack?.brief?.prep?.plan || []).map((p) => ({ key: p.part, label: p.part, min: p.min, what: p.what ? [p.what] : [] }));
    const saved = this.store.getSetting<Array<{ key: string; label: string; min: number }> | null>('split', null);
    if (!saved?.length) return src;
    return saved.map((g) => ({ ...g, what: src.find((x) => x.key === g.key)?.what }));
  }

  // 대화 재료 카드를 판 위에 놓고 학생 화면도 거기로
  private async placeTalkKit(md: string) {
    const c = this.canvasId();
    const id = await this.importDoc(md, '대화 재료');
    this.store.log({ kind: 'material', page: c, id, data: { op: 'talk_kit', packet_id: this.pack?.packet?.packet_id || null } });
    window.setTimeout(() => this.gotoObj(c, id, true), 450); // 글이 다 들어가 상자 높이가 정해진 뒤
  }

  private renderTimer() {
    const t = this.store.getSetting<{ endsAt: number } | null>('timer', null);
    if (!t || !t.endsAt) {
      this.timerEl.hidden = true;
      if (this.timerBtn) this.timerBtn.hidden = false;
      return;
    }
    const left = Math.ceil((t.endsAt - this.store.now()) / 1000);
    if (left <= -5) {
      this.timerEl.hidden = true;
      if (this.timerBtn) this.timerBtn.hidden = false;
      if (this.role === 'teacher') this.store.setSetting('timer', null);
      return;
    }
    this.timerEl.hidden = false;
    if (this.timerBtn) this.timerBtn.hidden = true;
    const label = (t as { label?: string }).label || '';
    this.timerEl.textContent = (label ? label + ' ' : '') + (left > 0 ? fmtClock(left) : '끝');
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
    const srvQ = srv && srv !== DEFAULT_SERVER ? `srv=${encodeURIComponent(srv)}` : '';
    const mk = (r: Role) => `${base}#/b/${this.params.id}?r=${r[0]}${srvQ ? '&' + srvQ : ''}`;
    // 고정 교실 판이면 학생 링크는 매번 같은 #/c/<코드>
    const cm = /^(k[a-z0-9]{8})d\d{6}$/.exec(this.params.id);
    const studentUrl = cm ? `${base}#/c/${cm[1]}${srvQ ? '?' + srvQ : ''}` : mk('student');
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
      row(cm ? '학생 (늘 같은 링크)' : '학생', studentUrl),
      row('태블릿 펜', mk('assist')),
      row('다른 랩탑', mk('teacher')),
      h('p', { class: 'mnote' }, EMBEDDED ? '시험용 창이라 다른 기기와 연결할 수 없어요. 설치본에서 서버 주소를 넣으면 링크 하나로 같이 봅니다.' : srv ? `서버 ${srv}` : '서버 주소가 없어 이 기기 안에서만 동작해요. ⋯ → 서버·선생님 열쇠.'),
    );
    this.showPanel(box);
  }

  private openHwSettings() {
    const c = hwConfig();
    const box = h('div', { class: 'menu wide' });
    const url = h('input', { type: 'url', class: 'link-input', placeholder: 'https://script.google.com/macros/s/…/exec', value: c?.url || '' }) as HTMLInputElement;
    const key = h('input', { type: 'password', class: 'link-input', placeholder: '선생님 키', value: c?.key || '', autocomplete: 'off' }) as HTMLInputElement;
    const save = h('button', { type: 'button', class: 'mi small' }, '저장');
    save.addEventListener('click', () => {
      setHwConfig(url.value.trim() && key.value.trim() ? { url: url.value.trim(), key: key.value.trim() } : null);
      this.closePanel();
      toast(hwConfig() ? '숙제 앱과 연결했어요' : '숙제 연결을 껐어요');
      if (this.memPanel) this.renderMemPanel();
    });
    [url, key].forEach((i) => i.addEventListener('keydown', (e) => e.stopPropagation()));
    box.append(h('div', { class: 'mh' }, 'KWD 숙제 연결'), h('div', { class: 'link-row' }, url), h('div', { class: 'link-row' }, key, save), h('p', { class: 'mnote' }, '숙제 앱(Apps Script) 배포 주소와 선생님 키. 이 기기에만 저장돼요. 연결하면 이 학생 → 과제 에서 학생이 낸 답·사진·녹음을 불러와요.'));
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
    box.append(h('div', { class: 'mh' }, '수업 요약'), h('p', { class: 'mnote' }, '이 판에 지금까지 남은 것을 한눈에. 수업 기록(.kwd.zip)과 밤 루틴 입력도 같은 내용에서 만들어져요.'));
    const evs = this.store.events.toArray();
    const st = (this.store.meta.get('startedAt') as number) || evs[0]?.t;
    const en = (this.store.meta.get('lastAt') as number) || evs[evs.length - 1]?.t;
    const count = (role: Role, kind: string) => evs.filter((e) => e.role === role && e.kind === kind).length;
    const facts: string[] = [];
    const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
    if (st && en) facts.push(`${hm(st)}–${hm(en)} (${Math.max(1, Math.round((en - st) / 60000))}분)`);
    if (this.order.length > 1) facts.push(`페이지 ${this.order.length}`);
    facts.push(`선생님 글 ${count('teacher', 'text')}줄 · 손글씨 ${count('teacher', 'ink')}획`);
    facts.push(`학생 글 ${count('student', 'text')}줄 · 손글씨 ${count('student', 'ink')}획`);
    box.append(h('p', { class: 'sum-facts' }, facts.join(' · ')));
    // 학생이 직접 쓴 글 (블록마다 마지막 것)
    const stuText = new Map<string, string>();
    for (const e of evs) if (e.role === 'student' && e.kind === 'text' && e.text) stuText.set(e.block || String(e.t), e.text);
    if (stuText.size) box.append(h('h4', {}, `학생이 쓴 글 ${stuText.size}`), ...[...stuText.values()].slice(-12).map((t) => h('div', { class: 'sum-row' }, t)));
    // 오늘 나온 단어 (학생 DB·복습 단어와 맞춰 보기)
    let allText = '';
    for (const ed of this.editors.values()) allText += ' ' + ed.getText();
    for (const id of this.order) for (const o of this.store.objList(id)) if (o.type === 'box') allText += ' ' + this.store.boxFragment(o.id).toString().replace(/<[^>]+>/g, ' ');
    const known = this.pack?.db?.vocab.map((v) => v.w) || this.memory?.vocab.map((v) => v.kr) || [];
    const probe = (w: string) => (w.endsWith('다') && w.length > 2 ? w.slice(0, -1) : w); // 먹다 → 먹 (먹어요도 찾게)
    const seen = [...new Set(known)].filter((w) => probe(w).length >= 2 && allText.includes(probe(w)));
    const review = (this.memory?.vocab || []).filter((v) => v.status === 'review').map((v) => v.kr);
    const missed = review.filter((w) => !allText.includes(probe(w)));
    if (known.length) {
      box.append(h('h4', {}, `배운 단어가 다시 나옴 ${seen.length}`), h('p', { class: 'sum-words' }, seen.slice(0, 40).join(', ') || '아직 없어요'));
      if (review.length) box.append(h('h4', {}, `오늘 복습 단어 중 아직 안 나온 것 ${missed.length}/${review.length}`), h('p', { class: 'sum-words' }, missed.join(', ') || '다 나왔어요'));
    }
    // 자료
    const mats: string[] = [];
    const KIND: Record<string, string> = { img: '사진', html: '웹 학습지', audio: '소리', video: '영상', youtube: '유튜브' };
    this.order.forEach((id, i) => {
      const v = this.views.get(id);
      if (v?.info.kind === 'material') {
        const m = v.info.mid ? this.store.materials.get(v.info.mid) : null;
        if (m && v.info.n === 1) mats.push(`${i + 1}쪽 PDF ${m.name}`);
      }
      const at = this.isCanvas(id) ? '' : `${i + 1}쪽 `;
      const slideMats = new Set<string>();
      for (const o of this.store.objList(id)) {
        if (o.type === 'slide') {
          if (o.mid && !slideMats.has(o.mid)) {
            slideMats.add(o.mid);
            mats.push(`${at}슬라이드 ${this.store.materials.get(o.mid)?.name || ''}`);
          }
        } else if (KIND[o.type]) mats.push(`${at}${KIND[o.type]}${o.name && o.name !== KIND[o.type] ? ' ' + o.name : ''}`);
      }
    });
    if (mats.length) box.append(h('h4', {}, `보여 준 자료 ${mats.length}`), ...mats.slice(0, 20).map((t) => h('div', { class: 'sum-row' }, t)));
    // 교정·빈칸
    let corr = 0, blanks = 0;
    const corrRows: HTMLElement[] = [];
    const blankRows: HTMLElement[] = [];
    for (const ed of this.editors.values()) {
      const sum = summarize(ed);
      corr += sum.corrections.length;
      blanks += sum.blanks.length;
      for (const c of sum.corrections) corrRows.push(h('div', { class: 'sum-row' }, `✗ ${c.original}`), h('div', { class: 'sum-row ok' }, `✓ ${c.corrected}`));
      for (const b of sum.blanks) blankRows.push(h('div', { class: 'sum-row' }, `${b.result === 'ok' ? '○' : b.result === 'no' ? '✗' : '·'} ${b.value || '___'}${b.answer ? ` (정답 ${b.answer})` : ''}`));
    }
    box.append(h('h4', {}, `교정 ${corr}`), ...(corrRows.length ? corrRows : [h('p', { class: 'mnote' }, '고칠 글을 골라 위에 뜨는 막대의 "교정"을 누르면 ✗ 원래 → ✓ 고친 말로 남아요. 그냥 지우고 다시 쓴 건 교정으로 세지 않아요.')]));
    box.append(h('h4', {}, `빈칸 ${blanks}`), ...(blankRows.length ? blankRows : [h('p', { class: 'mnote' }, '글에 ___ (밑줄 세 개)를 치면 빈칸이 돼요. 학생이 채운 답과 ○/✗ 가 여기 모여요.')]));
    const kb = Math.round(JSON.stringify(evs).length / 1024);
    box.append(h('details', { class: 'sum-ev' }, h('summary', {}, `사건 기록 ${evs.length}개 · ${kb}KB`), h('p', { class: 'mnote' }, '모든 사건을 남겨요. 글은 한 줄(블록)마다 3초 멈출 때 한 번, 손글씨는 한 획에 한 번이라 1시간에 보통 수백~수천 개(수백 KB)예요. 기록 묶음에 다 들어가고, AI에는 밤 루틴이 말 녹음 시각과 맞춰 짧게 줄여서 넘겨요.')));
    this.showPanel(box);
  }

  private exportMd() {
    download(bundleName(this.store).replace('.kwd.zip', '.md'), boardMarkdown({ store: this.store, editors: this.editors }), 'text/markdown');
  }

  destroy() {
    this.classroom?.destroy();
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
