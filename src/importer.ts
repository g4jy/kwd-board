// 자료 가져오기: PDF(슬라이드는 PDF로 내보내서) → 쪽마다 그림 + 글자층. HTML 자료 → iframe.
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { randomId, TEXT_W, type BoardStore, type MaterialPage } from './store';

let workerReady = false;
function ensureWorker() {
  if (workerReady) return;
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  workerReady = true;
}

// pdf.js 는 한글을 글자마다 따로 줄 때가 많다 → 같은 줄의 가까운 조각은 붙이고, 줄이 바뀌면 줄바꿈
export function joinText(items: Array<{ s: string; x: number; y: number; w: number; h: number }> | undefined): string {
  if (!items?.length) return '';
  let out = '';
  let prev: { s: string; x: number; y: number; w: number; h: number } | null = null;
  for (const it of items) {
    if (prev) {
      const sameLine = Math.abs(it.y - prev.y) < Math.max(4, prev.h * 0.5);
      if (!sameLine) out += '\n';
      else {
        const gap = it.x - (prev.x + prev.w);
        if (gap > prev.h * 0.22 && !out.endsWith(' ') && !it.s.startsWith(' ')) out += ' ';
      }
    }
    out += it.s;
    prev = it;
  }
  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export interface ImportProgress {
  (done: number, total: number): void;
}

// PDF → 자료 페이지들. 현재 페이지 다음에 넣는다. 돌려주는 값: 새 페이지 id 목록
export async function importPdf(store: BoardStore, file: File | ArrayBuffer, name: string, afterIndex: number, progress?: ImportProgress): Promise<string[]> {
  ensureWorker();
  const data = file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const mid = randomId(8);
  const total = doc.numPages;
  const hasText: boolean[] = [];
  const pageIds: string[] = [];
  store.doc.transact(() => store.materials.set(mid, { id: mid, name, type: 'pdf', pages: total, hasText: [] }), 'import');
  for (let n = 1; n <= total; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // 판 페이지는 폭 820. 그림은 2배(1640)로 그려 확대해도 선명하게
    const pageScale = TEXT_W / base.width;
    const w = TEXT_W;
    const hgt = Math.round(base.height * pageScale);
    const renderScale = Math.min(2, 1640 / base.width);
    const vp = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    let img = canvas.toDataURL('image/jpeg', 0.8);
    // 서버가 있으면 그림은 서버에 (웹소켓 한 번에 1MB 제한·문서 크기), 문서에는 열쇠만
    if (store.status === 'connected') {
      const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.8));
      const key = `${mid}-${n}.jpg`;
      if (blob && (await store.putBlob(key, blob))) img = 'blob:' + key;
    }
    // 글자층: 판 페이지 좌표로
    const tc = await page.getTextContent();
    const vp1 = page.getViewport({ scale: pageScale });
    const items: MaterialPage['text'] = [];
    for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjs.Util.transform(vp1.transform, it.transform);
      const fontH = Math.hypot(m[2], m[3]);
      items.push({ s: it.str, x: Math.round(m[4]), y: Math.round(m[5] - fontH), w: Math.round(it.width * pageScale), h: Math.round(fontH) });
    }
    hasText.push(items.length > 0);
    const pid = randomId(8);
    store.doc.transact(() => {
      store.matdata.set(`${mid}/${n}`, { img, w, h: hgt, text: items });
    }, 'import');
    store.addPage({ id: pid, kind: 'material', mid, n, w, h: hgt }, afterIndex + n);
    pageIds.push(pid);
    progress?.(n, total);
    page.cleanup();
  }
  store.doc.transact(() => store.materials.set(mid, { id: mid, name, type: 'pdf', pages: total, hasText }), 'import');
  store.log({ kind: 'material', id: mid, data: { op: 'import', type: 'pdf', name, pages: total, withText: hasText.filter(Boolean).length } });
  await doc.destroy();
  return pageIds;
}

export async function importHtml(store: BoardStore, html: string, name: string, afterIndex: number): Promise<string> {
  const mid = randomId(8);
  const pid = randomId(8);
  const w = TEXT_W;
  const hgt = 1160;
  store.doc.transact(() => {
    store.materials.set(mid, { id: mid, name, type: 'html', pages: 1 });
    store.matdata.set(`${mid}/1`, { html, w, h: hgt });
  }, 'import');
  store.addPage({ id: pid, kind: 'material', mid, n: 1, w, h: hgt }, afterIndex + 1);
  store.log({ kind: 'material', id: mid, data: { op: 'import', type: 'html', name, bytes: html.length } });
  return pid;
}

// HTML 자료 안에서 돌아가는 작은 연결 코드: 자료가 따로 아무것도 안 해도 클릭·입력이 기록된다.
export const HTML_BRIDGE = `<script>(function(){
function send(type,payload){try{parent.postMessage(Object.assign({type:type},payload),'*')}catch(e){}}
window.kwd={event:function(name,value,score){send('kwd:event',{name:name,value:value,score:score})},text:function(t){send('kwd:text',{text:t})}};
document.addEventListener('click',function(e){var el=e.target.closest('button,a,[data-kwd]');if(!el)return;send('kwd:event',{name:el.getAttribute('data-kwd')||'click',value:(el.innerText||'').trim().slice(0,80)})},true);
document.addEventListener('change',function(e){var el=e.target;if(!el||!('value' in el))return;send('kwd:event',{name:el.name||el.id||'input',value:String(el.value).slice(0,120)})},true);
window.addEventListener('load',function(){send('kwd:text',{text:(document.body.innerText||'').slice(0,4000)})});
})();<\/script>`;

export function htmlWithBridge(html: string): string {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, HTML_BRIDGE + '</head>');
  return HTML_BRIDGE + html;
}
