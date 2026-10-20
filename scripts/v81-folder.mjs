// v8.1: 수업 끝 → 묻는 창 없이 Student_Lessons/<학생>/녹화/<수업 시각>/ 에 녹화 4줄 + _rec.json + 판 기록(.kwd.zip). 두 번째 수업은 새 폴더
import { chromium } from 'playwright';
import fs from 'node:fs';
import { fixtureFiles, writeOpfs } from './folder-fixture.mjs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v81f';
fs.mkdirSync(OUT, { recursive: true });
const p2 = (n) => String(n).padStart(2, '0');
const d = new Date();
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture'] });
const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
const p = await ctx.newPage();
const errs = [], downloads = [], pickers = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('download', (dl) => downloads.push(dl.suggestedFilename()));
await p.addInitScript(() => { for (const k of ['showSaveFilePicker', 'showDirectoryPicker']) { const f = window[k]; window[k] = (...a) => { (window.__pickers ||= []).push(k); return f ? f(...a) : Promise.reject(new Error('no')); }; } });
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.home');
await p.evaluate(writeOpfs, fixtureFiles(today));
await p.waitForSelector('.lesson-row');
await p.click('.lesson-row:has-text("Mina")');
await p.waitForFunction(() => window.__kwd && document.querySelector('.lesson-btn'));
const lesson = async () => {
  await p.click('.lesson-btn');
  await p.waitForFunction(() => document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 10000 });
  await p.keyboard.type('수업 글');
  await p.waitForTimeout(7000); // 첫 수업은 소리 장치가 처음 깨어나느라 첫 덩어리가 몇 초 늦다(이 PC 크롬 155) — 짧으면 영상·소리 모두 0바이트로 끝난다
  await p.click('.lesson-btn');
  await p.click('.lesson-btn');
  await p.waitForFunction(() => !document.querySelector('.lesson-btn')?.classList.contains('rec'), null, { timeout: 15000 });
  await p.waitForTimeout(1500);
};
await lesson();
const toast1 = await p.locator('.toast').last().innerText().catch(() => '');
await lesson();
const tree = await p.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const sl = await (await root.getDirectoryHandle('kwdwork')).getDirectoryHandle('Student_Lessons');
  const out = {};
  for await (const [sname, sd] of sl.entries()) {
    if (sd.kind !== 'directory') continue;
    let rec;
    try { rec = await sd.getDirectoryHandle('녹화'); } catch { continue; }
    for await (const [ln, ld] of rec.entries()) {
      const files = [];
      for await (const [fn, fh] of ld.entries()) files.push([fn, (await fh.getFile()).size]);
      out[`${sname}/녹화/${ln}`] = files.sort();
    }
  }
  return out;
});
const res = { toast1, tree, downloads, pickers: await p.evaluate(() => window.__pickers || []), errs };
console.log(JSON.stringify(res, null, 1));
await b.close();
