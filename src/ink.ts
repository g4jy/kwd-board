// 잉크 층: 화면 크기 캔버스 하나에 모든 페이지의 획을 그린다.
// 획은 페이지 좌표(px)로 저장되어 페이지에 붙는다 — 자료 쪽을 넘기면 그 쪽의 잉크도 함께 간다.
import { getStroke } from 'perfect-freehand';
import { randomId, type BoardStore, type InkTarget, type Stroke } from './store';
import type { Viewport } from './viewport';

export type Tool = 'text' | 'pen' | 'hl' | 'eraser' | 'laser';

export interface PenStyle {
  color: string;
  size: number;
  hl: boolean;
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
    this.canvas.style.pointerEvents = t === 'text' ? 'none' : 'auto';
    this.canvas.style.cursor = t === 'eraser' ? 'none' : t === 'laser' ? 'none' : 'crosshair';
    this.canvas.classList.toggle('active', t !== 'text');
    if (t !== 'laser') this.clearLaser();
    this.invalidate();
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
    if (this.tool === 'text' || !this.canDraw()) return;
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
    const outline = getStroke(pts, {
      size: s.size * (s.hl ? 1 : 1.25),
      thinning: s.hl ? 0 : 0.62,
      smoothing: 0.5,
      streamline: 0.48,
      simulatePressure: simulate && !s.hl,
      easing: (t) => Math.sin((t * Math.PI) / 2),
      start: { taper: s.hl ? 0 : Math.min(14, s.size * 3), cap: true },
      end: { taper: s.hl ? 0 : Math.min(14, s.size * 3), cap: true },
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
      for (const st of this.store.ink(pg.id).toArray()) {
        ctx.fillStyle = st.color;
        ctx.globalAlpha = st.hl ? 0.35 : 1;
        ctx.fill(this.strokePath(st, pg.id + ':' + st.id));
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    const drawLive = (d: LiveStroke) => {
      const pg = byId.get(d.page);
      if (!pg || !pg.visible) return;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x + pg.x * s), dpr * (y + pg.y * s));
      ctx.fillStyle = d.color;
      ctx.globalAlpha = d.hl ? 0.35 : 1;
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
    // 지우개 범위 원
    if (this.tool === 'eraser' && this.cursor) {
      const r = this.canvas.getBoundingClientRect();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = 'rgba(60,60,60,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.cursor.x - r.left, this.cursor.y - r.top, this.eraserSize, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
