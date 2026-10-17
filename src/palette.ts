// 펜 프리셋과 설정창 (Samsung Notes·GoodNotes 방식)
// 도구 줄에 펜 3칸 + 형광 1칸. 고른 칸을 한 번 더 누르면 설정창: 색 12 + 직접 + 최근, 굵기 슬라이더(−/+), 미리보기.
import { h } from './ui';
import { buildColorPicker } from './colorpicker';
import { PEN_KINDS } from './ink';
import type { PenKind } from './store';

export const PEN_COLORS = ['#222222', '#7a7a7a', '#d32f2f', '#ef6c00', '#f9a825', '#2e7d32', '#00897b', '#1565c0', '#283593', '#6a1b9a', '#d81b60', '#6d4c41'];
export const HL_COLORS = ['#ffd400', '#7ee36b', '#ff8fc7', '#7cc8ff', '#ffab40', '#c39bff', '#ff6b6b', '#5fe0d0'];
export const COLOR_NAMES: Record<string, string> = {
  '#222222': '검정', '#7a7a7a': '회색', '#d32f2f': '빨강', '#ef6c00': '주황', '#f9a825': '노랑', '#2e7d32': '초록', '#00897b': '청록', '#1565c0': '파랑', '#283593': '남색', '#6a1b9a': '보라', '#d81b60': '분홍', '#6d4c41': '갈색',
  '#ffd400': '노랑', '#7ee36b': '초록', '#ff8fc7': '분홍', '#7cc8ff': '파랑', '#ffab40': '주황', '#c39bff': '보라', '#ff6b6b': '빨강', '#5fe0d0': '청록',
};

export interface PenPreset {
  color: string;
  size: number;
  kind?: PenKind; // 펜 종류 (없으면 만년필)
  opacity?: number; // 형광펜 진하기 0..1
}

export interface PenPrefs {
  pens: PenPreset[];
  hl: PenPreset;
  eraser: number;
  active: number; // 0..2 펜, 3 형광
  recent: string[];
  recentHl?: string[];
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
    bar.style.opacity = String(Math.min(1, (p.opacity ?? 0.35) + 0.35));
    b.append(bar);
  } else {
    const dot = h('span', { class: 'slot-dot' });
    const d = Math.max(11, Math.min(22, 9 + p.size * 0.8));
    dot.style.width = dot.style.height = d + 'px';
    dot.style.background = p.color;
    b.append(dot);
    if (p.kind && p.kind !== 'fountain') b.append(h('span', { class: 'slot-kind' }, PEN_KINDS.find((k) => k.id === p.kind)?.label.slice(0, 1) || ''));
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
  if (hl && cur.opacity == null) cur.opacity = 0.35;
  const preview = h('canvas', { class: 'pp-preview', width: '440', height: '64' }) as HTMLCanvasElement;
  const drawPreview = () => {
    const c = preview.getContext('2d')!;
    c.clearRect(0, 0, 440, 64);
    c.strokeStyle = cur.color;
    c.globalAlpha = hl ? cur.opacity ?? 0.35 : cur.kind === 'pencil' ? 0.78 : 1;
    c.lineCap = 'round';
    const base = cur.size * (hl ? 1 : cur.kind === 'brush' ? 1.9 : cur.kind === 'ball' ? 1.05 : cur.kind === 'pencil' ? 0.9 : 1.25);
    // 붓·만년필은 가운데가 굵고 끝이 가늘게
    const tapered = !hl && (cur.kind === 'brush' || !cur.kind || cur.kind === 'fountain');
    const steps = 40;
    let px = 24, py = 40;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = 24 + 392 * t;
      const y = 40 - Math.sin(t * Math.PI * 1.6) * 16;
      c.lineWidth = tapered ? Math.max(0.6, base * (0.35 + 0.65 * Math.sin(t * Math.PI))) : base;
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(x, y);
      c.stroke();
      px = x;
      py = y;
    }
  };
  const colors = hl ? HL_COLORS : PEN_COLORS;
  const recentKey = hl ? 'recentHl' : 'recent';
  const recentList = (): string[] => ((opts.prefs as unknown as Record<string, string[] | undefined>)[recentKey] || []).filter((c) => !colors.includes(c)).slice(0, 6);
  const grid = h('div', { class: 'pp-colors' + (hl ? ' hl' : '') });
  let pickerOpen = !colors.includes(cur.color.toLowerCase()) && !colors.includes(cur.color);
  const picker = buildColorPicker(cur.color, (c) => set({ color: c }, false), (c) => set({ color: c }));
  const pickerWrap = h('div', { class: 'pp-picker' }, picker.el);
  const renderGrid = () => {
    grid.innerHTML = '';
    for (const c of colors) {
      const b = h('button', { type: 'button', class: 'pp-sw' + (c.toLowerCase() === cur.color.toLowerCase() ? ' on' : ''), title: COLOR_NAMES[c] || c, 'data-color': c });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => set({ color: c }));
      grid.append(b);
    }
    const custom = h('button', { type: 'button', class: 'pp-sw custom' + (pickerOpen ? ' on' : ''), title: '끌어서 직접 고르기', 'aria-expanded': String(pickerOpen) });
    custom.addEventListener('click', () => {
      pickerOpen = !pickerOpen;
      pickerWrap.hidden = !pickerOpen;
      picker.set(cur.color);
      renderGrid();
    });
    grid.append(custom);
  };
  pickerWrap.hidden = !pickerOpen;
  const recentRow = h('div', { class: 'pp-recent' });
  const renderRecent = () => {
    recentRow.innerHTML = '';
    const list = recentList();
    if (!list.length) {
      recentRow.hidden = true;
      return;
    }
    recentRow.hidden = false;
    recentRow.append(h('span', { class: 'pp-label' }, '최근'));
    for (const c of list) {
      const b = h('button', { type: 'button', class: 'pp-sw small' + (c.toLowerCase() === cur.color.toLowerCase() ? ' on' : ''), title: c, 'data-color': c });
      b.style.setProperty('--c', c);
      b.addEventListener('click', () => {
        set({ color: c });
        picker.set(c);
      });
      recentRow.append(b);
    }
  };
  // 펜 종류
  const kinds = h('div', { class: 'pp-kinds', role: 'radiogroup', 'aria-label': '펜 종류' });
  const renderKinds = () => {
    kinds.innerHTML = '';
    for (const k of PEN_KINDS) {
      const on = (cur.kind || 'fountain') === k.id;
      const b = h('button', { type: 'button', class: 'pp-chip' + (on ? ' on' : ''), 'data-kind': k.id, role: 'radio', 'aria-checked': String(on) }, k.label);
      b.addEventListener('click', () => set({ kind: k.id }));
      kinds.append(b);
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
  // 형광 진하기
  const op = h('input', { type: 'range', min: '15', max: '75', step: '5', value: String(Math.round((cur.opacity ?? 0.35) * 100)), class: 'pp-slider', 'aria-label': '진하기' }) as HTMLInputElement;
  const opNum = h('span', { class: 'pp-num' }, Math.round((cur.opacity ?? 0.35) * 100) + '%');
  op.addEventListener('input', () => set({ opacity: Number(op.value) / 100 }));
  function set(p: Partial<PenPreset>, remember = true) {
    Object.assign(cur, p);
    slider.value = String(cur.size);
    num.textContent = String(cur.size);
    opNum.textContent = Math.round((cur.opacity ?? 0.35) * 100) + '%';
    if (p.color && remember && !colors.includes(p.color)) {
      const r = opts.prefs as unknown as Record<string, string[] | undefined>;
      r[recentKey] = [p.color, ...(r[recentKey] || []).filter((c) => c !== p.color)].slice(0, 6);
      renderRecent();
    }
    if (p.color && remember) renderGrid();
    if (p.kind) renderKinds();
    drawPreview();
    opts.onChange({ ...cur });
  }
  box.append(h('div', { class: 'pp-title' }, hl ? '형광펜' : '펜'), preview);
  if (!hl) box.append(kinds);
  box.append(grid, pickerWrap, recentRow, h('div', { class: 'pp-size' }, sizeLabel, minus, slider, plus, num));
  if (hl) box.append(h('div', { class: 'pp-size' }, h('span', { class: 'pp-label' }, '진하기'), op, opNum));
  if (!hl && opts.onStraighten) {
    const lab = h('label', { class: 'pp-check' });
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = opts.prefs.straighten;
    cb.addEventListener('change', () => opts.onStraighten?.(cb.checked));
    lab.append(cb, document.createTextNode('잠깐 멈추면 곧은 선'));
    box.append(lab);
  }
  renderKinds();
  renderGrid();
  renderRecent();
  drawPreview();
  return box;
}
