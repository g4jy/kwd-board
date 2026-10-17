// 시험용 자료: 3쪽짜리 슬라이드 PDF(한국어 글자층) + HTML 인터랙티브 자료
import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch();
const p = await b.newPage();
const slide = (n, title, body) => `<section style="width:1280px;height:720px;page-break-after:always;font-family:'Noto Sans CJK KR',sans-serif;padding:60px;box-sizing:border-box;background:${n%2?'#fff8ec':'#eef6ff'}"><h1 style="font-size:64px;margin:0 0 30px">${title}</h1><p style="font-size:40px;line-height:1.6">${body}</p><div style="position:absolute;bottom:30px;right:60px;font-size:24px">${n}/3</div></section>`;
await p.setContent(`<html><head><style>@page{size:1280px 720px;margin:0}body{margin:0}section{position:relative}</style></head><body>
${slide(1,'추석','추석에 가족이 모두 모여요.<br>송편을 만들어요.')}
${slide(2,'-기를 바랍니다','가기를 바랍니다 → 가시기를 바랍니다<br>건강하시기를 바랍니다.')}
${slide(3,'연습','선생님께 ___ 말씀드렸어요.<br>원장님께 피자가 맛있다고 했어요.')}
</body></html>`);
await p.pdf({ path: 'tests/fixtures/slides.pdf', width: '1280px', height: '720px', printBackground: true });
await b.close();
fs.writeFileSync('tests/fixtures/quiz.html', `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:40px;font-size:28px}button{font-size:26px;padding:12px 22px;margin:8px;border-radius:12px;border:2px solid #333;background:#fff}#r{margin-top:20px;font-weight:bold}</style></head><body>
<h2>알맞은 것을 고르세요</h2><p>원장님___ 말씀드렸어요.</p>
<button data-kwd="choice" onclick="pick(this,false)">에게</button><button data-kwd="choice" onclick="pick(this,true)">께</button><button data-kwd="choice" onclick="pick(this,false)">한테</button>
<div id="r"></div>
<script>function pick(el,ok){document.getElementById('r').textContent=ok?'정답!':'다시 해 봐요';if(window.kwd)window.kwd.event('answer',el.textContent,ok?1:0)}</script></body></html>`);
console.log(fs.statSync('tests/fixtures/slides.pdf').size, 'bytes');
