// 펜 프리셋과 설정창 (Samsung Notes·GoodNotes 방식)
// 도구 줄에 펜 3칸 + 형광 1칸. 고른 칸을 한 번 더 누르면 설정창: 색 12 + 직접 + 최근, 굵기 슬라이더(−/+), 미리보기.
import { h } from './ui';

export const PEN_COLORS = ['#222222', '#7a7a7a', '#d32f2f', '#ef6c00', '#f9a825', '#2e7d32', '#00897b', '#1565c0', '#283593', '#6a1b9a', '#d81b60', '#6d4c41'];
export const HL_COLORS = ['#ffd400', '#7ee36b', '#ff8fc7', '#7cc8ff', '#ffab40'];
export const COLOR_NAMES: Record<string, string> = {
  '#222222': '검정', '#7a7a7a': '회색', '#d32f2f': '빨강', '#ef6c00': '주황', '#f9a825': '노랑', '#2e7d32': '초록', '#00897b': '청록', '#1565c0': '파랑', '#283593': '남색', '#6a1b9a': '보라', '#d81b60': '분홍', '#6d4c41': '갈색',
  '#ffd400': '노랑', '#7ee36b': '초록', '#ff8fc7': '분홍', '#7cc8ff': '파랑', '#ffab40': '주황',
};

export interface PenPreset {
  color: string;
  size: number;
}

export interface PenPrefs {
  pens: PenPreset[];
  hl: PenPreset;
  eraser: number;
  active: number; // 0..2 펜, 3 형광
  recent: string[];
  straighten: boolean;
}

const KEY = 'kwd.pen.';

export function defaultPrefs(role: string): PenPrefs {
  if (role === 'student') return { pens: [{ color: '#2e7d32', size: 3 }, { color: '#222222', size: 3 }, { color: '#1565c0', size: 3 }], hl: { color: '#ffd400', size: 16 }, eraser: 14, active: 0, recent: [], straighten: false };
  return { pens: [{ color: '#222222', size: 3 }, { color: '#d32f2f', size: 3 }, { color: '#1565c0', size: 5 }], hl: { color: '#ffd400', size: 16 }, eraser: 14, active: 0, recent: [], straighten: false };
}

export function loadPrefs(role: string): PenPrefs {
  try {
    const raw = localStorage.getItem(KEY + role);
    if (raw) return { ...defaultPrefs(role), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return defaultPrefs(role);
}

export function savePrefs(role: string, p: PenPrefs) {
  try {
    localStorage.setItem(KEY + role, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// 펜 칸 버튼의 모양: 색 점 + 굵기
export function penSlot(idx: number, p: PenPreset, hl = false): HTMLElement {
  const b = h('button', { type: 'button', class: 'tb pen-slot' + (hl ? ' hl-slot' : ''), 'data-slot': String(idx), title: hl ? '형광펜 (H) · 한 번 더 누르면 설정' : `펜 ${idx + 1} (${idx + 1}) · 한 번 더 누르면 설정` });
  renderSlot(b, p, hl);
  return b;
}

export function renderSlot(b: HTMLElement, p: PenPreset, hl = false) {
  b.innerHTML = '';
  if (hl) {
    const bar = h('span', { class: 'slot-hl' });
    bar.style.background = p.color;
    b.append(bar);
  } else {
    const dot = h('span', { class: 'slot-dot' });
    const d = Math.max(11, Math.min(22, 9 + p.size * 0.8));
    dot.style.width = dot.style.height = d + 'px';
    dot.style.background = p.color;
    b.append(dot);
  }
}

// 설정창
export function buildPenPopover(opts: {
  kind: 'pen' | 'hl' | 'eraser';
  preset?: PenPreset;
  prefs: PenPrefs;
  onChange: (p: PenPreset) => void;
  onEraser?: (size: number) => void;
  onClearPage?: () => void;
  onStraighten?: (v: boolean) => void;
}): HTMLElement {
  const box = h('div', { class: 'pen-pop', role: 'dialog' });
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (opts.kind === 'eraser') {
    box.append(h('div', { class: 'pp-title' }, '지우개'));
    const row = h('div', { class: 'pp-row' });
    for (const [label, v] of [['작게', 8], ['보통', 14], ['크게', 28]] as Array<[string, number]>) {
      const b = h('button', { type: 'button', class: 'pp-chip' + (opts.prefs.eraser === v ? ' on' : ''), 'data-er': String(v) }, label);
      b.addEventListener('click', () => {
        opts.onEraser?.(v);
        row.querySelectorAll('.pp-chip').forEach((x) => x.classList.toggle('on', x === b));
      });
      row.append(b);
    }
    box.append(row);
    const clear = h('button', { type: 'button', class: 'pp-wide' }, '이 페이지 잉크 모두 지우기');
    clear.addEventListener('click', () => opts.onClearPage?.());
    box.append(clear);
    return box;
  }
  const hl = opts.kind === 'hl';
  const cur: PenPreset = { ...(opts.preset as PenPreset) };
  const preview = h('canvas', { class: 'pp-preview', width: '440', height: '64' }) as HTMLCanvasElement;
  const drawPreview = () => {
    const c = preview.getContext('2d')!;
    c.clearRect(0, 0, 440, 64);
    c.strokeStyle = cur.color;
    c.globalAlpha = hl ? 0.4 : 1;
    c.lineCap = 'round';
    c.lineWidth = cur.size * (hl ? 1 : 1.25);
    c.beginPath();
    c.moveTo(24, 40);
    c.bezierCurveTo(140, 8, 260, 64, 416, 24);
    c.stroke();
  };
  const colors = hl ? HL_COLORS : PEN_COLORS;
  const grid = h('div', { class: 'pp-colors' + (hl ? ' hl' : '') });
  const renderGrid = () => {
    grid.innerHTML = '';
    for (const c of colors) {
      const b = h('button', { type: 'button', class: 'pp-sw' + (c.toLowerCase() === cur.color.toLowerCase() ? ' on' : ''), title: COLOR_NAMES[c] || c, 'data-color': c });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => set({ color: c }));
      grid.append(b);
    }
    if (!hl) {
      const custom = h('label', { class: 'pp-sw custom', title: '직접 고르기' });
      const input = h('input', { type: 'color', value: cur.color }) as HTMLInputElement;
      input.addEventListener('input', () => set({ color: input.value }, false));
      input.addEventListener('change', () => set({ color: input.value }));
      custom.append(input);
      grid.append(custom);
    }
  };
  const recentRow = h('div', { class: 'pp-recent' });
  const renderRecent = () => {
    recentRow.innerHTML = '';
    const list = opts.prefs.recent.filter((c) => !colors.includes(c)).slice(0, 6);
    if (hl || !list.length) {
      recentRow.hidden = true;
      return;
    }
    recentRow.hidden = false;
    recentRow.append(h('span', { class: 'pp-label' }, '최근'));
    for (const c of list) {
      const b = h('button', { type: 'button', class: 'pp-sw small', title: c, 'data-color': c });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => set({ color: c }));
      recentRow.append(b);
    }
  };
  const min = hl ? 8 : 1;
  const max = hl ? 40 : 24;
  const slider = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(cur.size), class: 'pp-slider', 'aria-label': '굵기' }) as HTMLInputElement;
  const num = h('span', { class: 'pp-num' }, String(cur.size));
  const sizeLabel = h('span', { class: 'pp-label' }, '굵기');
  const minus = h('button', { type: 'button', class: 'pp-step', title: '가늘게' }, '−');
  const plus = h('button', { type: 'button', class: 'pp-step', title: '굵게' }, '+');
  minus.addEventListener('click', () => set({ size: Math.max(min, cur.size - 1) }));
  plus.addEventListener('click', () => set({ size: Math.min(max, cur.size + 1) }));
  slider.addEventListener('input', () => set({ size: Number(slider.value) }));
  function set(p: Partial<PenPreset>, remember = true) {
    Object.assign(cur, p);
    slider.value = String(cur.size);
    num.textContent = String(cur.size);
    if (p.color && remember && !colors.includes(p.color)) {
      opts.prefs.recent = [p.color, ...opts.prefs.recent.filter((c) => c !== p.color)].slice(0, 6);
      renderRecent();
    }
    renderGrid();
    drawPreview();
    opts.onChange({ ...cur });
  }
  box.append(h('div', { class: 'pp-title' }, hl ? '형광펜' : '펜'), preview, grid, recentRow, h('div', { class: 'pp-size' }, sizeLabel, minus, slider, plus, num));
  if (!hl && opts.onStraighten) {
    const lab = h('label', { class: 'pp-check' });
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = opts.prefs.straighten;
    cb.addEventListener('change', () => opts.onStraighten?.(cb.checked));
    lab.append(cb, document.createTextNode('잠깐 멈추면 곧은 선'));
    box.append(lab);
  }
  renderGrid();
  renderRecent();
  drawPreview();
  return box;
}
