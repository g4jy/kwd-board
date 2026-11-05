// T160 보조: (1) 옛 화면 캡처(전) (2) 학생이 판에 들어오면 선생님 카드에 접속 표시가 켜지는지
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
const OUT = path.resolve('test-results/t160');
const KEY = 'testkey-0123456789abcdef', PORT = 8797, WS = 'ws://localhost:1234';
const gas = spawn('node', ['scripts/mock-gas.mjs', String(PORT), path.join(OUT, 'drive/work'), path.join(OUT, 'landing'), KEY], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const init = (ctx, ws) => ctx.addInitScript(([k, u, w]) => { localStorage.setItem('kwd.gasKey', k); localStorage.setItem('kwd.gasUrl', u); if (w) localStorage.setItem('kwd.server', w); }, [KEY, `http://localhost:${PORT}/`, ws]);
const out = {};
for (const [tag, vp] of [['pc', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
  const ctx = await b.newContext({ viewport: vp });
  await init(ctx, '');
  const p = await ctx.newPage();
  await p.goto(`http://localhost:4174/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
  await p.waitForSelector('.roster-grid', { timeout: 30000 });
  await p.screenshot({ path: `${OUT}/before-${tag}.png`, fullPage: true });
  await ctx.close();
}
// 접속 표시
const ctxT = await b.newContext({ viewport: { width: 1280, height: 800 } });
await init(ctxT, WS);
const t = await ctxT.newPage();
await t.goto(`http://localhost:4173/?k=${KEY}&g=${encodeURIComponent(`http://localhost:${PORT}/`)}#/`);
await t.waitForSelector('.th-item');
await t.locator('.th-row').first().click();
await t.waitForFunction(() => /학생 (아직|접속)/.test(document.querySelector('.th-presence')?.textContent || ''), null, { timeout: 20000 });
out.before = await t.locator('.th-presence').innerText();
const code = await t.evaluate(async () => {
  const bid = JSON.parse(localStorage.getItem('kwd.classCodes') || '{}');
  return Object.values(bid)[0];
});
const ctxS = await b.newContext({ viewport: { width: 390, height: 780 }, permissions: ['camera', 'microphone'] });
await init(ctxS, WS);
const s = await ctxS.newPage();
await s.goto(`http://localhost:4173/#/c/${code}?srv=${encodeURIComponent(WS)}`);
await s.waitForSelector('.join .join-go', { timeout: 15000 });
await s.waitForFunction(() => document.querySelector('.join-preview')?.srcObject, null, { timeout: 10000 }).catch(() => {});
await s.click('.join .join-go');
await s.waitForTimeout(4000);
await t.waitForFunction(() => /학생 접속 중/.test(document.querySelector('.th-presence')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
out.after = await t.locator('.th-presence').innerText();
out.code = !!code;
out.studentUrl = s.url();
out.studentBoard = await s.locator('.board-doc').count();
await s.screenshot({ path: OUT + '/student-dbg.png' });
out.studentJoinLeft = await s.locator('.join').count();
await t.screenshot({ path: `${OUT}/presence-pc.png` });
console.log(JSON.stringify(out));
await b.close();
gas.kill();
