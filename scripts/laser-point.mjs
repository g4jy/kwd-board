// 레이저로 가리키고 멈추면 판 기록에 'point' 한 줄 (전사 정리 때 '여기'가 어디였는지)
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:4173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${BASE}/#/b/pt${Math.random().toString(36).slice(2, 7)}?r=t&st=12`);
await p.waitForSelector('.board-doc');
await p.waitForFunction(() => !!window.__kwd);
await p.waitForTimeout(500);
await p.keyboard.type('추석에 가족이 모두 모여요.');
await p.keyboard.press('Escape');
await p.click('[data-tool="laser"]');
const w = await p.evaluate(() => { const r = document.querySelector('.board-doc p').getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; });
for (let i = 0; i < 12; i++) { await p.mouse.move(w[0] + i * 6, w[1]); await p.waitForTimeout(25); }
await p.waitForTimeout(1600);
const ev = await p.evaluate(() => window.__kwd.store.events.toArray().filter((e) => e.kind === 'point').map((e) => ({ page: !!e.page, x: e.data?.x, y: e.data?.y, target: e.data?.target ? JSON.stringify(e.data.target).slice(0, 80) : null })));
const tool = await p.evaluate(() => document.querySelector('.board')?.dataset.tool);
console.log(JSON.stringify({ tool, ev, errs }));
await b.close();
