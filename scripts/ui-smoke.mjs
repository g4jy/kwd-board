// UI/UX 10/19: 단추 크기(도구 줄·위 단추·목록·확대 ≥44, 자료 막대 ≥36), 자료 막대가 판 배율과 상관없이 같은 크기,
// 레이저가 학생 화면에 보이고 사라짐, 도구 줄 위/아래, 타이머 칩. 화면 사진은 OUT 에.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/ui';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const res = {};
const errs = [];
const sizes = (f) => f.evaluate(() => {
  const groups = { toolbar: '.toolbar button', top: '.top-left button, .top-right button', rail: '.rail button', zoom: '.zoom button', objTools: '.obj-tools button' };
  const out = {};
  for (const [k, q] of Object.entries(groups)) {
    out[k] = [...document.querySelectorAll(q)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
      .map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 14)]; });
  }
  return out;
});
const small = (list, min) => list.filter(([w, hh]) => Math.min(w, hh) < min);

// 1) 노트북 선생님 판
{
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => errs.push('laptop: ' + e));
  await p.goto(`${BASE}/#/`);
  await p.waitForSelector('.home');
  await p.click('.home-demo');
  await p.click('.demo-card.main');
  await p.waitForSelector('.roster-grid');
  await p.click('.rs-card:has-text("Mina K")');
  await p.waitForFunction(() => location.hash.startsWith('#/b/'));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/1-laptop.png` });
  const s = await sizes(p);
  res.laptop = { counts: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length])), under44: [...small(s.toolbar, 44), ...small(s.top, 44), ...small(s.rail, 44), ...small(s.zoom, 44)] };
  res.toolbarLabels = s.toolbar.map((x) => x[2]);
  // 자료 고르기 → 막대
  await p.click('[data-tool="select"]');
  const obj = p.locator('.obj-img').first();
  const ob = await obj.boundingBox();
  await p.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await p.waitForTimeout(400);
  const bar1 = await p.locator('.obj.sel > .obj-tools').first().boundingBox().catch(() => null);
  const btn1 = await sizes(p);
  await p.screenshot({ path: `${OUT}/2-selected-35.png` });
  await p.click('.zoom button >> nth=2');
  await p.click('.zoom button >> nth=2');
  await p.click('.zoom button >> nth=2');
  await p.waitForTimeout(500);
  const bar2 = await p.locator('.obj.sel > .obj-tools').first().boundingBox().catch(() => null);
  const pct = await p.locator('.zoom button >> nth=1').innerText();
  await p.screenshot({ path: `${OUT}/3-selected-zoomed.png` });
  res.selBar = { at35: bar1 && [Math.round(bar1.width), Math.round(bar1.height)], zoomed: bar2 && [Math.round(bar2.width), Math.round(bar2.height)], pct, under36: small(btn1.objTools, 36), buttons: btn1.objTools.map((x) => x[2]) };
  // 펜 설정 · 더보기 · 타이머
  await p.keyboard.press('Escape');
  await p.click('.pen-slot >> nth=0');
  await p.click('.pen-slot >> nth=0');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/4-pen-pop.png` });
  await p.keyboard.press('Escape');
  await p.mouse.click(200, 600);
  res.timerBtn = await p.locator('.timer-btn').count();
  await p.click('.timer-btn');
  await p.waitForTimeout(300);
  await p.click('.timer-menu .chip-btn >> nth=0');
  await p.waitForTimeout(1200);
  res.timerChip = await p.locator('.top-left .timer').innerText().catch(() => '');
  await p.click('[data-tool="more"]');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/5-more.png` });
  await p.locator('[data-key="tbTop"]').click();
  await p.waitForTimeout(400);
  const tb = await p.locator('.toolbar').boundingBox();
  res.tbTopY = Math.round(tb.y);
  await p.screenshot({ path: `${OUT}/6-toolbar-top.png` });
  await p.click('[data-tool="more"]');
  await p.locator('[data-key="tbTop"]').click();
  await p.waitForTimeout(300);
  res.tbBackY = Math.round((await p.locator('.toolbar').boundingBox()).y);
  await p.context().close();
}

// 2) 태블릿(터치) · 폰 학생
for (const [name, vp, touch] of [['tablet', { width: 1180, height: 820 }, true], ['phone', { width: 390, height: 844 }, true]]) {
  const c = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: name === 'phone' });
  const p = await c.newPage();
  p.on('pageerror', (e) => errs.push(name + ': ' + e));
  await p.goto(`${BASE}/#/`);
  await p.waitForSelector('.home');
  await p.click('.home-demo');
  await p.click('.demo-card.main');
  await p.waitForSelector('.roster-grid');
  await p.click('.rs-card:has-text("Mina K")');
  await p.waitForFunction(() => location.hash.startsWith('#/b/'));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${OUT}/7-${name}.png` });
  const s = await sizes(p);
  res[name] = { under44: [...small(s.toolbar, 44), ...small(s.top, 44), ...small(s.rail, 44), ...small(s.zoom, 44)], toolbarW: Math.round((await p.locator('.toolbar').boundingBox()).width) };
  await c.close();
}

// 3) 나란히: 레이저가 학생 폰에 보이고 1.5초 뒤 사라진다
{
  const p = await (await b.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  p.on('pageerror', (e) => errs.push('split: ' + e));
  await p.goto(`${BASE}/#/demo/split`);
  await p.waitForFunction(() => [...document.querySelectorAll('.dev-frame')].every((f) => f.src.includes('#/b/')), null, { timeout: 40000 });
  await p.waitForTimeout(3000);
  const fr = (r) => p.frames().find((f) => f.url().includes('r=' + r));
  const t = fr('t'), s = fr('s');
  const red = (f) => f.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll('canvas')) {
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 16) if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 120) n++;
      } catch { /* */ }
    }
    return n;
  });
  res.laserBefore = await red(s);
  await t.evaluate(() => document.querySelector('[data-tool="laser"]').click());
  const tf = await p.locator('.dev-frame').first().boundingBox();
  const sx = tf.x + tf.width * 0.45, sy = tf.y + tf.height * 0.45;
  for (let i = 0; i < 25; i++) {
    await p.mouse.move(sx + i * 8, sy + Math.sin(i / 3) * 20);
    await p.waitForTimeout(30);
  }
  await p.waitForTimeout(250);
  res.laserTeacher = await red(t);
  res.laserStudent = await red(s);
  await p.screenshot({ path: `${OUT}/8-split-laser.png` });
  await p.waitForTimeout(2600);
  res.laserStudentAfter = await red(s);
}
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
