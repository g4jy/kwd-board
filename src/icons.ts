// 도구 줄 아이콘 (24×24, 선은 currentColor). 글자 단추 대신 한 가지 모양으로 (UI/UX 분석 10/19)
import type { PenKind } from './store';

const svg = (body: string, extra = '') =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const ICONS: Record<string, string> = {
  select: svg('<path d="M6 3.5 17.5 13l-5.2.6 3 6.3-2.3 1-3-6.2L6 18.3z" fill="currentColor" fill-opacity=".12"/>'),
  text: svg('<path d="M5 5.5h14M12 5.5v13M9.5 18.5h5" stroke-width="2.1"/>'),
  eraser: svg('<path d="M4.6 14.6 13.8 5.4a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L11.2 18.4H8.4z"/><path d="M9.2 10.2l5 5M12 18.4h7.5"/>'),
  eraserPart: svg('<path d="M4.6 14.6 13.8 5.4a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L11.2 18.4H8.4z" stroke-dasharray="2.6 2.4"/><path d="M12 18.4h7.5"/>'),
  laser: svg('<path d="M3.5 20.5c3-1 5.2-3.2 6.4-6.4" stroke-opacity=".55" stroke-width="2.4"/><circle cx="14" cy="10" r="3.2" fill="currentColor"/><circle cx="14" cy="10" r="6.6" stroke-opacity=".45"/>'),
  undo: svg('<path d="M9 13.5 4.5 9 9 4.5"/><path d="M4.5 9H14a5.5 5.5 0 0 1 0 11h-3"/>'),
  redo: svg('<path d="M15 13.5 19.5 9 15 4.5"/><path d="M19.5 9H10a5.5 5.5 0 0 0 0 11h3"/>'),
  add: svg('<path d="M12 5v14M5 12h14" stroke-width="2.1"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  camera: svg('<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.3" r="3.3"/>'),
  mic: svg('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>'),
  micOff: svg('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M4 4l16 16"/>'),
  cam: svg('<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="m15.5 11 5-3v8l-5-3"/>'),
  camOff: svg('<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="m15.5 11 5-3v8l-5-3M3.5 4.5l16 15"/>'),
  face: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M6.5 19c1-2.8 3-4.2 5.5-4.2s4.5 1.4 5.5 4.2"/>'),
  layout: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="12" y="11" width="6.5" height="6.5" rx="1.2" fill="currentColor" fill-opacity=".25"/>'),
  move: svg('<path d="M12 3.5v17M3.5 12h17M12 3.5 9.5 6M12 3.5 14.5 6M12 20.5 9.5 18M12 20.5 14.5 18M3.5 12 6 9.5M3.5 12 6 14.5M20.5 12 18 9.5M20.5 12 18 14.5"/>'),
  big: svg('<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6"/>'),
  save: svg('<path d="M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18" stroke-width="2"/>'),
  textbox: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M8 9.5h8M12 9.5v6"/>'),
  // 자료 종류
  web: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17M6.5 6.5h.01M8.8 6.5h.01"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17.5 5-4.5 3.5 3 3-2.5 4.5 4"/>'),
  youtube: svg('<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="m10 9.2 5 2.8-5 2.8z" fill="currentColor"/>'),
  video: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 9h17M3.5 15h17M7.5 5.5V9M7.5 15v3.5M16.5 5.5V9M16.5 15v3.5"/>'),
  audio: svg('<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>'),
  voice: svg('<path d="M4 12h1.5M7.5 8.5v7M11 5.5v13M14.5 8.5v7M18 10.5v3M20.5 12h0"/>'),
  slide: svg('<rect x="3.5" y="4.5" width="17" height="12" rx="1.5"/><path d="M12 16.5v3M8.5 19.5h7"/>'),
  doc: svg('<path d="M6 3.5h8l4.5 4.5v12.5H6z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 15.5h6"/>'),
  homework: svg('<path d="M6 3.5h12v17H6z"/><path d="m9 12 2 2 4-4.5M9 7.5h6"/>'),
  timer: svg('<circle cx="12" cy="13" r="7.5"/><path d="M12 13V9.2M9.5 3.5h5"/>'),
  note: svg('<path d="M5 4.5h14v11l-4 4H5z"/><path d="M15 19.5v-4h4"/>'),
};

export function icon(name: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = ICONS[name] || '';
  return s;
}

// 펜 칸: 펜 끝 모양을 그 펜의 색으로. 몸통은 회색 선, 끝·띠만 색 (어두운 색도 보이게 흰 테두리)
export function penIcon(kind: PenKind | undefined, color: string): string {
  const k = kind || 'fountain';
  const tip: Record<PenKind, string> = {
    fountain: `<path d="M5.2 18.8 7 13.6l3.4 3.4z" fill="${color}" stroke="${color}"/><path d="m6.1 17.9 2-2"  stroke="#fff" stroke-width="1"/>`,
    ball: `<path d="M5.6 18.4 7.6 14l2.4 2.4z" fill="${color}" stroke="${color}"/><circle cx="5.4" cy="18.6" r="1" fill="${color}" stroke="none"/>`,
    brush: `<path d="M4.6 19.4c.4-2.6 1.4-4.6 3-6l3 3c-1.4 1.6-3.4 2.6-6 3z" fill="${color}" stroke="${color}"/>`,
    pencil: `<path d="M5 19 7.2 13.8l3 3z" fill="#e9d3a8" stroke="#a88a55" stroke-width="1"/><path d="M5 19l.9-2.1 1.2 1.2z" fill="${color}" stroke="${color}" stroke-width="1"/>`,
  };
  return svg(
    `<path d="M7.6 13.4 16.4 4.6a2 2 0 0 1 2.9 2.9L10.6 16.2" stroke="#6b665c"/><path d="m14.6 6.4 2.9 2.9" stroke="${color}" stroke-width="2.4"/>${tip[k]}`,
    'class="pen-ic"',
  );
}

export function hlIcon(color: string, opacity: number): string {
  return svg(
    `<path d="M4 20h9" stroke="${color}" stroke-width="4" stroke-opacity="${Math.min(1, opacity + 0.3)}"/><path d="m8.5 15.5 7.8-10.2a1.6 1.6 0 0 1 2.4-.2l1 1a1.6 1.6 0 0 1-.1 2.3L9.6 17.6z" stroke="#6b665c"/><path d="M8.5 15.5 6.6 18l1.4.9 1.6-1.3z" fill="${color}" stroke="${color}" stroke-width="1.2"/>`,
    'class="pen-ic"',
  );
}
