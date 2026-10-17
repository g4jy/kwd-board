// 잉크 층: 화면 크기 캔버스 하나에 모든 페이지의 획을 그린다.
// 획은 페이지 좌표(px)로 저장되어 페이지에 붙는다 — 자료 쪽을 넘기면 그 쪽의 잉크도 함께 간다.
import { getStroke } from 'perfect-freehand';
import { randomId, type BoardStore, type InkTarget, type Stroke, type PenKind } from './store';
import type { Viewport } from './viewport';

export type Tool = 'select' | 'text' | 'pen' | 'hl' | 'eraser' | 'laser';

export interface PenStyle {
  color: string;
  size: number;
  hl: boolean;
  kind?: PenKind;
  opacity?: number; // 형광펜
}

// 어두운 바탕에서도 보이는 커서 (흰 테두리)
const svgCursor = (svg: string, x: number, y: number, fallback: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
export const CURSOR_ARROW = svgCursor('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 2 L3 19 L7.5 14.8 L10.6 21.5 L13.4 20.3 L10.3 13.7 L16.5 13.7 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>', 3, 2, 'default');
export const CURSOR_TEXT = svgCursor('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M8 3h8M8 21h8M12 3v18" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/><path d="M8 3h8M8 21h8M12 3v18" stroke="#111" stroke-width="1.8" stroke-linecap="round"/></svg>', 12, 12, 'text');
export function penCursor(color: string, size: number, hl = false): string {
  const r = Math.max(3, Math.min(14, (hl ? size * 0.5 : size * 0.7) + 2));
  const d = Math.ceil(r * 2 + 6);
  const c = d / 2;
  const fill = hl ? color + '88' : color;
  return svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${c}" cy="${c}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${r + 1.6}" fill="none" stroke="#111" stroke-width="1"/></svg>`, Math.round(c), Math.round(c), 'crosshair');
}

// 펜 종류별 perfect-freehand 설정
export const PEN_KINDS: Array<{ id: PenKind; label: string }> = [
  { id: 'fountain', label: '만년필' },
  { id: 'ball', label: '볼펜' },
  { id: 'brush', label: '붓' },
  { id: 'pencil', label: '연필' },
];
function kindOptions(k: PenKind | undefined, size: number) {
  switch (k) {
    case 'ball':
      return { size: size * 1.05, thinning: 0.12, smoothing: 0.55, streamline: 0.5, taper: 0, simulate: false, alpha: 1 };
    case 'brush':
      return { size: size * 2.8, thinning: 0.68, smoothing: 0.62, streamline: 0.42, taper: Math.min(36, size * 5), simulate: true, alpha: 1 };
    case 'pencil':
      return { size: size * 0.9, thinning: 0.35, smoothing: 0.35, streamline: 0.3, taper: Math.min(6, size * 1.5), simulate: true, alpha: 0.78 };
    default:
      return { size: size * 1.25, thinning: 0.62, smoothing: 0.5, streamline: 0.48, taper: Math.min(14, size * 3), simulate: true, alpha: 1 };
  }
}
export function strokeAlpha(s: { hl: boolean; k?: PenKind; o?: number }): number {
  if (s.hl) return s.o ?? 0.35;
  return kindOptions(s.k, 1).alpha;
}

export interface InkSelection {
  page: string;
  ids: string[];
  dx: number;
  dy: number;
}

export interface PageBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

interface LiveStroke {
  page: string;
  pts: number[];
  color: string;
  size: number;
  hl: boolean;
  k?: PenKind;
  o?: number;
  live?: boolean;
}

export class InkLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  tool: Tool = 'text';
  style: PenStyle = { color: '#222222', size: 3, hl: false };
  eraserSize = 12;
  straighten = false;
  private holdTimer = 0;
  private store: BoardStore;
  private vp: Viewport;
  private drawing: LiveStroke | null = null;
  private activePointer: number | null = null;
  private pressureSeen = false;
  private hasPenHistory = false;
  private needsRender = true;
  private pathCache = new Map<string, Path2D>();
  private observed = new Set<string>();
  private lasers = new Map<number, { x: number; y: number; t: number; trail: Array<[number, number, number]> }>();
  private lastAwarenessPush = 0;
  private raf = 0;
  private cursor: { x: number; y: number } | null = null;
  getPages: () => PageBox[] = () => [];
  canDraw: () => boolean = () => true;
  locate: (page: string, pts: number[], screenPts: Array<[number, number]>) => InkTarget | undefined = () => undefined;
  selection: InkSelection | null = null; // 선택 도구로 고른 획
  band: { x0: number; y0: number; x1: number; y1: number } | null = null; // 고르는 네모 (세상 좌표)
  onStrokeAdded?: () => void;

  constructor(canvas: HTMLCanvasElement, store: BoardStore, vp: Viewport) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.store = store;
    this.vp = vp;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    vp.onChange(() => this.invalidate());
    store.awareness.on('change', () => this.invalidate());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // S펜 옆 버튼
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', (e) => {
      this.cursor = null;
      this.invalidate();
      if (this.tool === 'laser') this.clearLaser();
      if (this.drawing && this.activePointer === e.pointerId) this.onUp(e);
    });
    this.loop();
  }

  observePage(id: string) {
    if (this.observed.has(id)) return;
    this.observed.add(id);
    this.store.ink(id).observe(() => {
      for (const k of this.pathCache.keys()) if (k.startsWith(id + ':')) this.pathCache.delete(k);
      this.invalidate();
    });
  }

  setTool(t: Tool) {
    this.tool = t;
    this.canvas.style.pointerEvents = t === 'text' || t === 'select' ? 'none' : 'auto';
    this.updateCursor();
    this.canvas.classList.toggle('active', t !== 'text' && t !== 'select');
    if (t !== 'select') this.selection = null;
    if (t !== 'laser') this.clearLaser();
    this.invalidate();
  }

  updateCursor() {
    const t = this.tool;
    this.canvas.style.cursor = t === 'eraser' || t === 'laser' ? 'none' : t === 'pen' || t === 'hl' ? penCursor(this.style.color, this.style.size, t === 'hl') : 'default';
  }

  resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.invalidate();
  }

  invalidate() {
    this.needsRender = true;
  }

  private loop = () => {
    if (this.needsRender || this.lasers.size > 0 || this.hasRemoteLaser()) this.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  private hasRemoteLaser(): boolean {
    for (const [, st] of this.store.awareness.getStates()) if (st && st.laser) return true;
    return false;
  }

  // 세상 좌표 → (페이지, 페이지 좌표)
  private hitPage(wx: number, wy: number, strict = false): { page: PageBox; x: number; y: number } | null {
    const pages = this.getPages().filter((p) => p.visible);
    let best: PageBox | null = null;
    let bestD = Infinity;
    for (const p of pages) {
      const dx = wx < p.x ? p.x - wx : wx > p.x + p.w ? wx - p.x - p.w : 0;
      const dy = wy < p.y ? p.y - wy : wy > p.y + p.h ? wy - p.y - p.h : 0;
      const d = dx + dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best || (strict && bestD > 0)) return null;
    return { page: best, x: wx - best.x, y: wy - best.y };
  }

  isDrawPointer(e: PointerEvent) {
    if (e.pointerType === 'touch') return !this.hasPenHistory; // 펜을 한 번이라도 쓴 기기에선 손가락은 이동용
    return true;
  }

  private onDown(e: PointerEvent) {
    if (this.tool === 'text' || this.tool === 'select' || !this.canDraw()) return;
    if (e.pointerType === 'pen') this.hasPenHistory = true;
    if (this.tool === 'laser') return this.pushLaser(e);
    if (!this.isDrawPointer(e)) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointer = e.pointerId;
    const [wx, wy] = this.vp.toWorld(e.clientX, e.clientY);
    // S펜 옆 버튼·펜 뒤쪽(지우개 끝)은 그 획 동안만 지우개
    this.tempErase = e.pointerType === 'pen' && (e.button === 5 || e.button === 2 || (e.buttons & 34) !== 0);
    if (this.tool === 'eraser' || this.tempErase) return this.eraseAt(wx, wy);
    const hit = this.hitPage(wx, wy, true);
    if (!hit) {
      this.activePointer = null;
      return;
    }
    const st = this.tool === 'hl' ? { ...this.style, hl: true } : this.style;
    this.drawing = { page: hit.page.id, pts: [hit.x, hit.y, this.pressure(e)], color: st.color, size: st.size, hl: st.hl };
    if (st.hl) this.drawing.o = st.opacity ?? 0.35;
    else if (st.kind && st.kind !== 'fountain') this.drawing.k = st.kind;
    this.screenPts = [[e.clientX, e.clientY]];
    this.invalidate();
  }
  private screenPts: Array<[number, number]> = [];
  private tempErase = false;

  private pressure(e: PointerEvent): number {
    const p = e.pressure;
    if (e.pointerType === 'pen' && p > 0 && p !== 0.5) this.pressureSeen = true;
    return p > 0 ? p : 0.5;
  }

  private onMove(e: PointerEvent) {
    if (this.tool === 'laser') return this.pushLaser(e);
    if (this.tool === 'eraser') {
      this.cursor = { x: e.clientX, y: e.clientY };
      this.invalidate();
    }
    if (this.activePointer !== e.pointerId) return;
    const [wx, wy] = this.vp.toWorld(e.clientX, e.clientY);
    if (this.tool === 'eraser' || this.tempErase) return this.eraseAt(wx, wy);
    if (!this.drawing) return;
    const pg = this.getPages().find((p) => p.id === this.drawing!.page);
    if (!pg) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) {
      const [cx, cy] = this.vp.toWorld(ce.clientX, ce.clientY);
      this.drawing.pts.push(cx - pg.x, cy - pg.y, this.pressure(ce));
      this.screenPts.push([ce.clientX, ce.clientY]);
    }
    this.invalidate();
    if (this.straighten) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => this.makeStraight(), 500);
    }
    const now = performance.now();
    if (now - this.lastAwarenessPush > 60) {
      this.lastAwarenessPush = now;
      this.store.awareness.setLocalStateField('drawing', this.drawing);
    }
  }

  // 끝에서 0.5초 멈추면 직선으로 편다 (Samsung Notes 방식)
  private makeStraight() {
    const d = this.drawing;
    if (!d || d.pts.length < 9) return;
    const n = d.pts.length;
    const x0 = d.pts[0], y0 = d.pts[1], x1 = d.pts[n - 3], y1 = d.pts[n - 2];
    if (Math.hypot(x1 - x0, y1 - y0) < 30) return;
    const steps = 12;
    const pts: number[] = [];
    for (let i = 0; i <= steps; i++) pts.push(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 0.5);
    d.pts = pts;
    this.invalidate();
  }

  private onUp(e: PointerEvent) {
    window.clearTimeout(this.holdTimer);
    if (this.activePointer !== e.pointerId) return;
    this.activePointer = null;
    this.tempErase = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!this.drawing) return;
    const d = this.drawing;
    this.drawing = null;
    this.store.awareness.setLocalStateField('drawing', null);
    if (d.pts.length < 6) d.pts.push(d.pts[0] + 0.5, d.pts[1] + 0.5, d.pts[2]);
    const stroke: Stroke = { id: randomId(8), role: this.store.role, color: d.color, size: d.size, hl: d.hl, pts: d.pts.map((v) => Math.round(v * 100) / 100), t: this.store.now() };
    if (d.k) stroke.k = d.k;
    if (d.hl && d.o != null) stroke.o = d.o;
    let target: InkTarget | undefined;
    try {
      target = this.locate(d.page, stroke.pts, this.screenPts);
    } catch {
      target = undefined;
    }
    this.store.addStroke(d.page, stroke, target);
    this.onStrokeAdded?.();
    this.invalidate();
  }

  private eraseAt(wx: number, wy: number) {
    const hit = this.hitPage(wx, wy);
    if (!hit) return;
    const r = this.eraserSize / this.vp.view.s;
    for (const s of this.store.ink(hit.page.id).toArray()) {
      if (this.hits(s, hit.x, hit.y, r + s.size / 2)) {
        this.store.removeStroke(hit.page.id, s.id);
        this.invalidate();
        return;
      }
    }
  }

  private hits(s: Stroke, x: number, y: number, r: number): boolean {
    const p = s.pts;
    const r2 = r * r;
    for (let i = 0; i + 5 < p.length; i += 3) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 3], by = p[i + 4];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-6;
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx - x, py = ay + t * dy - y;
      if (px * px + py * py <= r2) return true;
    }
    return p.length >= 3 && (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
  }

  // ---- 선택 도구 ----
  hitStroke(wx: number, wy: number): { page: string; id: string } | null {
    const hit = this.hitPage(wx, wy, true);
    if (!hit) return null;
    const r = 6 / this.vp.view.s;
    const list = this.store.ink(hit.page.id).toArray();
    for (let i = list.length - 1; i >= 0; i--) if (this.hits(list[i], hit.x, hit.y, r + list[i].size / 2)) return { page: hit.page.id, id: list[i].id };
    return null;
  }
  // 세상 좌표 네모 안에 다 들어오는 획 (페이지별)
  strokesInRect(x0: number, y0: number, x1: number, y1: number): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (const pg of this.getPages()) {
      if (!pg.visible) continue;
      for (const st of this.store.ink(pg.id).toArray()) {
        const b = strokeBox(st);
        if (b[0] + pg.x >= ax && b[2] + pg.x <= bx && b[1] + pg.y >= ay && b[3] + pg.y <= by) {
          if (!out.has(pg.id)) out.set(pg.id, []);
          out.get(pg.id)!.push(st.id);
        }
      }
    }
    return out;
  }
  selectionBox(): [number, number, number, number] | null {
    const sel = this.selection;
    if (!sel || !sel.ids.length) return null;
    const pg = this.getPages().find((p) => p.id === sel.page);
    if (!pg) return null;
    const set = new Set(sel.ids);
    let b: [number, number, number, number] | null = null;
    for (const st of this.store.ink(sel.page).toArray()) {
      if (!set.has(st.id)) continue;
      const sb = strokeBox(st);
      b = b ? [Math.min(b[0], sb[0]), Math.min(b[1], sb[1]), Math.max(b[2], sb[2]), Math.max(b[3], sb[3])] : sb;
    }
    if (!b) return null;
    return [b[0] + pg.x + sel.dx, b[1] + pg.y + sel.dy, b[2] + pg.x + sel.dx, b[3] + pg.y + sel.dy];
  }

  // ---- 레이저 ----
  private pushLaser(e: PointerEvent) {
    const [x, y] = this.vp.toWorld(e.clientX, e.clientY);
    const now = performance.now();
    const local = this.lasers.get(-1) || { x, y, t: now, trail: [] };
    Object.assign(local, { x, y, t: now });
    local.trail.push([x, y, now]);
    if (local.trail.length > 40) local.trail.shift();
    this.lasers.set(-1, local);
    if (now - this.lastAwarenessPush > 40) {
      this.lastAwarenessPush = now;
      this.store.awareness.setLocalStateField('laser', { x, y, t: Date.now() });
    }
    this.invalidate();
  }
  clearLaser() {
    this.lasers.delete(-1);
    if (this.store.awareness.getLocalState()?.laser) this.store.awareness.setLocalStateField('laser', null);
    this.invalidate();
  }

  // ---- 그리기 ----
  private strokePath(s: Stroke | LiveStroke, key?: string): Path2D {
    if (key && this.pathCache.has(key)) return this.pathCache.get(key)!;
    const pts: number[][] = [];
    for (let i = 0; i + 2 < s.pts.length; i += 3) pts.push([s.pts[i], s.pts[i + 1], s.pts[i + 2]]);
    const simulate = pts.every((p) => p[2] === 0.5);
    const ko = kindOptions(s.k, s.size);
    const outline = getStroke(pts, {
      size: s.hl ? s.size : ko.size,
      thinning: s.hl ? 0 : ko.thinning,
      smoothing: s.hl ? 0.5 : ko.smoothing,
      streamline: s.hl ? 0.48 : ko.streamline,
      simulatePressure: simulate && !s.hl && ko.simulate,
      easing: (t) => Math.sin((t * Math.PI) / 2),
      start: { taper: s.hl ? 0 : ko.taper, cap: true },
      end: { taper: s.hl ? 0 : ko.taper, cap: true },
      last: !('live' in s && s.live),
    });
    const path = new Path2D();
    if (outline.length) {
      path.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      path.closePath();
    }
    if (key) this.pathCache.set(key, path);
    return path;
  }

  private render() {
    this.needsRender = false;
    const ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { x, y, s } = this.vp.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const [w, h] = this.vp.size();
    const vx0 = -x / s, vy0 = -y / s, vx1 = (w - x) / s, vy1 = (h - y) / s;
    const pages = this.getPages();
    const byId = new Map(pages.map((p) => [p.id, p]));
    for (const pg of pages) {
      if (!pg.visible) continue;
      if (pg.y > vy1 || pg.y + pg.h < vy0 || pg.x > vx1 || pg.x + pg.w < vx0) continue;
      this.observePage(pg.id);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x + pg.x * s), dpr * (y + pg.y * s));
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pg.w, pg.h);
      ctx.clip();
      const sel = this.selection && this.selection.page === pg.id ? this.selection : null;
      const selSet = sel ? new Set(sel.ids) : null;
      for (const st of this.store.ink(pg.id).toArray()) {
        ctx.fillStyle = st.color;
        ctx.globalAlpha = strokeAlpha(st);
        if (selSet?.has(st.id) && (sel!.dx || sel!.dy)) {
          ctx.save();
          ctx.translate(sel!.dx, sel!.dy);
          ctx.fill(this.strokePath(st, pg.id + ':' + st.id));
          ctx.restore();
        } else ctx.fill(this.strokePath(st, pg.id + ':' + st.id));
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    const drawLive = (d: LiveStroke) => {
      const pg = byId.get(d.page);
      if (!pg || !pg.visible) return;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x + pg.x * s), dpr * (y + pg.y * s));
      ctx.fillStyle = d.color;
      ctx.globalAlpha = strokeAlpha(d);
      ctx.fill(this.strokePath({ ...d, live: true }));
      ctx.globalAlpha = 1;
    };
    for (const [cid, state] of this.store.awareness.getStates()) {
      if (cid === this.store.awareness.clientID) continue;
      const d = state?.drawing as LiveStroke | undefined;
      if (d && d.pts && d.pts.length >= 3) drawLive(d);
    }
    if (this.drawing) drawLive(this.drawing);

    // 레이저 (세상 좌표)
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
    const now = performance.now();
    for (const [key, l] of this.lasers) {
      if (now - l.t > 900) {
        this.lasers.delete(key);
        continue;
      }
      const tr = (l.trail = l.trail.filter((p) => now - p[2] < 600));
      ctx.lineCap = 'round';
      for (let i = 1; i < tr.length; i++) {
        const age = (now - tr[i][2]) / 600;
        ctx.strokeStyle = `rgba(230,40,40,${(1 - age) * 0.6})`;
        ctx.lineWidth = (6 * (1 - age) + 1.5) / s;
        ctx.beginPath();
        ctx.moveTo(tr[i - 1][0], tr[i - 1][1]);
        ctx.lineTo(tr[i][0], tr[i][1]);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(230,40,40,0.9)';
      ctx.beginPath();
      ctx.arc(l.x, l.y, 5 / s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const [cid, state] of this.store.awareness.getStates()) {
      if (cid === this.store.awareness.clientID) continue;
      const l = state?.laser as { x: number; y: number } | undefined;
      if (!l) continue;
      const entry = this.lasers.get(cid) || { x: l.x, y: l.y, t: now, trail: [] };
      if (entry.x !== l.x || entry.y !== l.y) entry.trail.push([l.x, l.y, now]);
      Object.assign(entry, { x: l.x, y: l.y, t: now });
      this.lasers.set(cid, entry);
    }
    // 선택 상자·고르는 네모
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
    const sb = this.selectionBox();
    if (sb) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 / s;
      ctx.setLineDash([6 / s, 4 / s]);
      ctx.strokeStyle = '#1f6feb';
      ctx.strokeRect(sb[0] - 6 / s, sb[1] - 6 / s, sb[2] - sb[0] + 12 / s, sb[3] - sb[1] + 12 / s);
      ctx.setLineDash([]);
    }
    if (this.band) {
      const b = this.band;
      ctx.fillStyle = 'rgba(31,111,235,0.08)';
      ctx.strokeStyle = 'rgba(31,111,235,0.8)';
      ctx.lineWidth = 1 / s;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    // 지우개 범위 원
    if (this.tool === 'eraser' && this.cursor) {
      const r = this.canvas.getBoundingClientRect();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 어두운 바탕에서도 보이게: 흰 굵은 원 + 검은 가는 원
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(this.cursor.x - r.left, this.cursor.y - r.top, this.eraserSize, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(20,20,20,0.85)';
      ctx.stroke();
    }
  }
}

export function strokeBox(st: Stroke): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 2 < st.pts.length; i += 3) {
    x0 = Math.min(x0, st.pts[i]);
    y0 = Math.min(y0, st.pts[i + 1]);
    x1 = Math.max(x1, st.pts[i]);
    y1 = Math.max(y1, st.pts[i + 1]);
  }
  const r = st.size;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}
