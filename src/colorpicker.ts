// 끌어서 고르는 색 고르기: 진하기·밝기 네모 + 색상 막대. 손가락·펜·마우스 모두 끌기로 정확히.
import { h } from './ui';

export function hexToHsv(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return [hh, max ? d / max : 0, max];
}

export function hsvToHex(hh: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (u: number) => Math.round((u + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

export interface ColorPicker {
  el: HTMLElement;
  set(hex: string): void;
}

// onInput: 끄는 동안 계속, onCommit: 손을 뗄 때 한 번 (최근 색에 넣기)
export function buildColorPicker(initial: string, onInput: (hex: string) => void, onCommit: (hex: string) => void): ColorPicker {
  let [hue, sat, val] = hexToHsv(initial);
  const el = h('div', { class: 'cp' });
  const sv = h('div', { class: 'cp-sv', 'aria-label': '색 진하기·밝기 (끌어서 고르기)', role: 'slider' });
  const svKnob = h('span', { class: 'cp-knob' });
  sv.append(svKnob);
  const hueBar = h('div', { class: 'cp-hue', 'aria-label': '색상 (끌어서 고르기)', role: 'slider' });
  const hueKnob = h('span', { class: 'cp-knob' });
  hueBar.append(hueKnob);
  const swatch = h('span', { class: 'cp-swatch' });
  const hexIn = h('input', { type: 'text', class: 'cp-hex', maxlength: '7', spellcheck: 'false', 'aria-label': '색 코드' }) as HTMLInputElement;
  hexIn.addEventListener('keydown', (e) => e.stopPropagation());
  hexIn.addEventListener('change', () => {
    const v = hexIn.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      [hue, sat, val] = hexToHsv(v.startsWith('#') ? v : '#' + v);
      paint();
      onCommit(cur());
    } else paint();
  });
  el.append(sv, hueBar, h('div', { class: 'cp-row' }, swatch, hexIn));
  const cur = () => hsvToHex(hue, sat, val);
  function paint() {
    sv.style.setProperty('--hue', `hsl(${hue}, 100%, 50%)`);
    svKnob.style.left = sat * 100 + '%';
    svKnob.style.top = (1 - val) * 100 + '%';
    hueKnob.style.left = (hue / 360) * 100 + '%';
    const c = cur();
    svKnob.style.background = c;
    swatch.style.background = c;
    if (document.activeElement !== hexIn) hexIn.value = c;
  }
  const drag = (target: HTMLElement, move: (fx: number, fy: number) => void) => {
    const at = (e: PointerEvent) => {
      const r = target.getBoundingClientRect();
      move(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
      paint();
      onInput(cur());
    };
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);
      at(e);
      const mv = (ev: PointerEvent) => at(ev);
      const up = () => {
        target.removeEventListener('pointermove', mv);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        onCommit(cur());
      };
      target.addEventListener('pointermove', mv);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  };
  drag(sv, (fx, fy) => {
    sat = fx;
    val = 1 - fy;
  });
  drag(hueBar, (fx) => {
    hue = Math.min(359.9, fx * 360);
    if (sat < 0.05 && val > 0.2) sat = 0.85; // 회색에서 색상을 끌면 색이 보이게
  });
  paint();
  return {
    el,
    set(hex: string) {
      [hue, sat, val] = hexToHsv(hex);
      paint();
    },
  };
}
