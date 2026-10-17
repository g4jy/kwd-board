// 웹 학습지 + 수업 때 단계마다 쓴 필기·글상자 → 한 파일 (학생에게 보내거나 다시 열어 보기)
// 학습지는 원래 크기 그대로 iframe 으로 띄우고, 학습지가 알려 주는 단계에 맞춰 그 단계의 필기를 겹친다.
import type { BoardStore, PageObject } from './store';
import { htmlWithBridge } from './importer';
import { strokeSvgPath, strokeAlpha } from './ink';
import { boxPlainText, wsLayerId } from './objects';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function wsAnnotations(store: BoardStore, o: PageObject) {
  const steps: Record<number, { paths: Array<{ d: string; c: string; a: number }>; boxes: Array<{ x: number; y: number; w: number; html: string }> }> = {};
  let count = 0;
  // 이 학습지의 필기층이 있는 단계들 (문서에 이미 있는 것만 — 없는 이름을 새로 만들지 않게)
  const found = new Set<number>();
  for (const key of store.doc.share.keys()) {
    const m = new RegExp('^(?:ink|obj):ws:' + o.id + ':(\\d+)$').exec(key);
    if (m) found.add(Number(m[1]));
  }
  for (const n of Array.from(found).sort((a, b) => a - b)) {
    const id = wsLayerId(o.id, n);
    const ink = store.ink(id).toArray();
    const boxes = store.objList(id).filter((b) => b.type === 'box');
    if (!ink.length && !boxes.length) continue;
    steps[n] = {
      paths: ink.map((s) => ({ d: strokeSvgPath(s), c: s.color, a: strokeAlpha(s) })).filter((p) => p.d),
      boxes: boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, html: boxPlainText(store, b.id).split('\n').map((l) => `<p>${esc(l)}</p>`).join('') })),
    };
    count += ink.length + boxes.length;
  }
  return { steps, count };
}

export function annotatedWorksheet(store: BoardStore, o: PageObject, studentName = ''): { html: string; count: number } | null {
  const md = o.mid ? store.matdata.get(`${o.mid}/1`) : undefined;
  if (md?.html == null) return null;
  const { steps, count } = wsAnnotations(store, o);
  const states: Record<string, unknown> = {};
  for (const [k, v] of store.doc.getMap<unknown>('wsstate:' + o.id)) states[k] = v;
  const W = Math.round(o.w - 2), H = Math.round(o.h - 34);
  const t = Number(store.meta.get('startedAt') || store.meta.get('createdAt') || Date.now());
  const d = new Date(t);
  const date = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  const title = `${o.name || '웹 학습지'} — 수업 필기 ${date}`;
  const src = JSON.stringify(htmlWithBridge(md.html)).replace(/<\//g, '<\\/');
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>html,body{margin:0;background:#f3f1ec;font-family:'Pretendard Variable',Pretendard,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#222}
.top{max-width:${W}px;margin:14px auto 8px;padding:0 12px;font-size:14px;color:#6b665c}.top b{color:#222}
#outer{margin:0 auto 24px}#wrap{position:relative;transform-origin:0 0;width:${W}px;height:${H}px;box-shadow:0 8px 24px rgba(0,0,0,.08);border-radius:8px;overflow:hidden;background:#fff}
iframe{border:0;width:${W}px;height:${H}px;display:block}svg{position:absolute;left:0;top:0;pointer-events:none}
#boxes{position:absolute;inset:0;pointer-events:none}.box{position:absolute;font-size:17px;line-height:1.5;background:rgba(255,255,255,.85);border-radius:6px;padding:2px 8px}.box p{margin:0}</style></head>
<body><div class="top"><b>${esc(o.name || '웹 학습지')}</b>${studentName ? ' · ' + esc(studentName) : ''} · ${date} 수업 필기 — 단계를 넘기면 그때 쓴 필기가 보여요</div>
<div id="outer"><div id="wrap"><iframe id="f" sandbox="allow-scripts allow-forms" title="학습지"></iframe><svg id="ink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg><div id="boxes"></div></div></div>
<script>
var ANN=${JSON.stringify(steps)},STATES=${JSON.stringify(states)},W=${W},H=${H};
var f=document.getElementById('f'),ink=document.getElementById('ink'),boxes=document.getElementById('boxes'),wrap=document.getElementById('wrap'),outer=document.getElementById('outer');
f.srcdoc=${src};
function show(n){var a=ANN[n]||{paths:[],boxes:[]};ink.innerHTML=a.paths.map(function(p){return '<path d="'+p.d+'" fill="'+p.c+'" fill-opacity="'+p.a+'"/>'}).join('');boxes.innerHTML=a.boxes.map(function(b){return '<div class="box" style="left:'+b.x+'px;top:'+b.y+'px;width:'+b.w+'px">'+b.html+'</div>'}).join('')}
addEventListener('message',function(e){if(e.source!==f.contentWindow)return;var d=e.data||{};if(d.type==='kwd:step')show(d.n);if(d.type==='kwd:hello'){for(var k in STATES)f.contentWindow.postMessage({type:'kwd:state',key:k,val:STATES[k]},'*');f.contentWindow.postMessage({type:'kwd:goto',n:1},'*')}});
function fit(){var s=Math.min(1,(innerWidth-16)/W);wrap.style.transform='scale('+s+')';outer.style.width=W*s+'px';outer.style.height=H*s+'px'}
show(1);fit();addEventListener('resize',fit);
</script></body></html>`;
  return { html, count };
}
