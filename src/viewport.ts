// 무한 캔버스 뷰포트: 세상(world) 좌표 ↔ 화면 좌표. 휠·핀치·드래그.
export interface View {
  x: number; // 화면 원점에 놓이는 세상 좌표의 화면 오프셋 (px)
  y: number;
  s: number; // 배율
}

export class Viewport {
  view: View = { x: 0, y: 0, s: 1 };
  readonly stage: HTMLElement;
  readonly world: HTMLElement;
  private listeners = new Set<(v: View) => void>();
  min = 0.25;
  max = 4;
  clamp: ((v: View) => View) | null = null;

  constructor(stage: HTMLElement, world: HTMLElement) {
    this.stage = stage;
    this.world = world;
    this.apply();
  }

  onChange(fn: (v: View) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(v: Partial<View>) {
    this.view = { ...this.view, ...v };
    this.view.s = Math.min(this.max, Math.max(this.min, this.view.s));
    if (this.clamp) this.view = this.clamp(this.view);
    this.apply();
  }

  private apply() {
    const { x, y, s } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    this.listeners.forEach((fn) => fn(this.view));
  }

  toWorld(sx: number, sy: number): [number, number] {
    const r = this.stage.getBoundingClientRect();
    return [(sx - r.left - this.view.x) / this.view.s, (sy - r.top - this.view.y) / this.view.s];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [wx * this.view.s + this.view.x, wy * this.view.s + this.view.y];
  }

  size(): [number, number] {
    const r = this.stage.getBoundingClientRect();
    return [r.width, r.height];
  }

  // 화면 가운데가 가리키는 세상 좌표
  center(): [number, number] {
    const [w, h] = this.size();
    return [(w / 2 - this.view.x) / this.view.s, (h / 2 - this.view.y) / this.view.s];
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const r = this.stage.getBoundingClientRect();
    const px = sx - r.left;
    const py = sy - r.top;
    const s2 = Math.min(this.max, Math.max(this.min, this.view.s * factor));
    const k = s2 / this.view.s;
    this.set({ s: s2, x: px - (px - this.view.x) * k, y: py - (py - this.view.y) * k });
  }

  panBy(dx: number, dy: number) {
    this.set({ x: this.view.x + dx, y: this.view.y + dy });
  }

  // 세상 좌표 (wx, wy)가 화면 가운데(혹은 지정 비율 위치)에 오도록
  centerOn(wx: number, wy: number, s = this.view.s, fx = 0.5, fy = 0.5) {
    const [w, h] = this.size();
    this.set({ s, x: w * fx - wx * s, y: h * fy - wy * s });
  }
}
