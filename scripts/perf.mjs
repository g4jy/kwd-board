// 루프 6: 20쪽 PDF 가져오기 시간, 긴 글 쪽 잉크 정렬, 쪽 넘김 반응
import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const mk = await b.newPage();
const sl = (n) => `<section style="width:1280px;height:720px;position:relative;font-family:'Noto Sans CJK KR',sans-serif;padding:60px;box-sizing:border-box;background:hsl(${n*17},70%,94%)"><h1 style="font-size:60px">${n}쪽 제목입니다</h1><p style="font-size:38px">한국어 문장 ${n}: 가족이 모두 모여서 송편을 만들어요.</p><img style="width:300px;height:200px;background:#888"></section>`;
await mk.setContent(`<html><head><style>@page{size:1280px 720px;margin:0}body{margin:0}</style></head><body>${Array.from({length:20},(_, i)=>sl(i+1)).join('')}</body></html>`);
await mk.pdf({ path: 'test-results/p20.pdf', width: '1280px', height: '720px', printBackground: true });
const bytes = fs.readFileSync('test-results/p20.pdf');
const srv = process.env.SRV || '';
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
const room = 'perf' + Date.now();
await p.goto(`http://localhost:4173/#/b/${room}?r=t&st=999${srv ? '&srv=' + encodeURIComponent(srv) : ''}`);
await p.waitForFunction(() => window.__kwd);
const t0 = Date.now();
await p.evaluate(async (b64) => { await window.__kwd.importPdfBytes(b64, 'p20.pdf'); }, bytes.toString('base64'));
const tImp = Date.now() - t0;
const pages = await p.evaluate(() => window.__kwd.objs(window.__kwd.pages()[0].id).filter((o) => o.type === 'slide').length + 1);
// 쪽 넘김 반응: 목록으로 20쪽 차례로
const t1 = Date.now();
const ids = await p.evaluate(() => window.__kwd.objs(window.__kwd.pages()[0].id).filter((o) => o.type === 'slide').map((x) => x.id));
for (const id of ids) await p.evaluate((id) => window.__kwd.gotoItem(id), id);
const tNav = (Date.now() - t1) / ids.length;
// 긴 글: 노트에 300줄
await p.evaluate(() => window.__kwd.gotoItem('note'));
const ed = await p.evaluate(() => { const e = window.__kwd.editor(); e.commands.focus('end'); for (let i = 0; i < 300; i++) e.commands.insertContent(`<p>${i}번째 줄 한국어 문장입니다.</p>`); return e.getText().length; });
const t2 = Date.now();
await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const mem = await p.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1);
const boxes = await p.evaluate(() => window.__kwd.boxes().slice(0, 2).map((b) => Math.round(b.h)));
console.log(JSON.stringify({ importMs: tImp, pages, navMs: Math.round(tNav), textLen: ed, frameMs: Date.now() - t2, heapMB: mem, firstBoxH: boxes, errs }));
await b.close();
