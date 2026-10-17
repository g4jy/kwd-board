// 작은 DOM 도우미
export function h(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'hidden') el.hidden = true;
    else if (k === 'readonly') (el as HTMLInputElement).readOnly = true;
    else if (k === 'value') (el as HTMLInputElement).value = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

// claude.ai 아티팩트 창 안에서는 파일 내려받기·인쇄·웹소켓이 막혀 있다. 그때는 클립보드로 대신한다.
export const EMBEDDED = (() => {
  try {
    if (window.self === window.top) return false;
    void window.top!.location.href; // 같은 주소 안의 창(체험 화면의 기기 틀)이면 막힌 게 아니다
    return false;
  } catch {
    return true;
  }
})();

export function download(name: string, content: string, type: string) {
  if (EMBEDDED) {
    navigator.clipboard
      .writeText(content)
      .then(() => toast(`${name} 내용을 복사했어요 (이 창에서는 내려받기가 막혀 있어요)`))
      .catch(() => toast('이 창에서는 내려받기가 막혀 있어요. 설치본에서 받으세요.'));
    return;
  }
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function fmtDate(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDateTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${hh}:${mm}`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function downloadBlob(name: string, blob: Blob) {
  if (EMBEDDED) {
    toast('이 창에서는 내려받기가 막혀 있어요. 설치본에서 받으세요.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function clearToast() {
  toastEl?.classList.remove('show');
}

export function toast(msg: string, ms = 1800) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast' });
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), ms);
}
