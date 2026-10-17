// v4 흐름 확인: 펜 종류·끌어 고르는 색·형광 진하기·선택 도구·글상자·웹 학습지 창·사진·휠
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const OUT = process.env.OUT || 'test-results/v4';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const res = {};
const K = (fn, arg) => p.evaluate(fn, arg);
await p.goto(`${BASE}/#/b/v4${Date.now()}?r=t&st=1000001`);
await p.waitForFunction(() => window.__kwd && window.__kwd.pages().length);
await p.waitForFunction(() => document.activeElement?.closest?.('.ProseMirror'));
await p.keyboard.type('오늘은 추석 이야기를 해요.');
const page0 = await K(() => window.__kwd.pages()[0].id);

// 1) 펜 1칸 → 한 번 더 → 설정: 볼펜 + 직접 색 끌기
await p.click('.pen-slot[data-slot="0"]');
await p.click('.pen-slot[data-slot="0"]');
await p.click('.pp-kinds [data-kind="ball"]');
await p.click('.pp-sw.custom');
const sv = await (await p.$('.cp-sv')).boundingBox();
await p.mouse.move(sv.x + 10, sv.y + 10);
await p.mouse.down();
await p.mouse.move(sv.x + sv.width * 0.9, sv.y + sv.height * 0.3, { steps: 6 });
await p.mouse.up();
const hue = await (await p.$('.cp-hue')).boundingBox();
await p.mouse.move(hue.x + 5, hue.y + hue.height / 2);
await p.mouse.down();
await p.mouse.move(hue.x + hue.width * 0.62, hue.y + hue.height / 2, { steps: 6 });
await p.mouse.up();
res.penPref = await K(() => window.__kwd.prefs().pens[0]);
await p.screenshot({ path: `${OUT}/1-pen-pop.png` });
await p.keyboard.press('Escape');
// 획 긋기
const pb = await (await p.$('.page')).boundingBox();
const drawLine = async (x0, y0, x1, y1) => {
  await p.mouse.move(x0, y0);
  await p.mouse.down();
  await p.mouse.move(x1, y1, { steps: 10 });
  await p.mouse.up();
};
await drawLine(pb.x + 120, pb.y + 300, pb.x + 400, pb.y + 320);
res.stroke1 = await K((id) => { const a = window.__kwd.store.ink(id).toArray(); const s = a[a.length - 1]; return { k: s.k, color: s.color }; }, page0);

// 2) 형광펜 진하기
await p.click('.pen-slot[data-slot="3"]');
await p.click('.pen-slot[data-slot="3"]');
await p.locator('.pen-pop input[aria-label="진하기"]').fill('60');
await p.locator('.pen-pop .pp-sw[data-color="#c39bff"]').click();
await p.screenshot({ path: `${OUT}/2-hl-pop.png` });
await p.keyboard.press('Escape');
await drawLine(pb.x + 120, pb.y + 380, pb.x + 420, pb.y + 380);
res.stroke2 = await K((id) => { const a = window.__kwd.store.ink(id).toArray(); const s = a[a.length - 1]; return { hl: s.hl, o: s.o, color: s.color }; }, page0);

// 3) 선택 도구: 네모로 두 획 고르기 → 끌어 옮기기 → 지우기 → 되돌리기
await p.click('.toolbar [data-tool="select"]');
res.cursor = await p.evaluate(() => getComputedStyle(document.querySelector('.stage')).cursor.slice(0, 30));
await p.mouse.move(pb.x + 90, pb.y + 270);
await p.mouse.down();
await p.mouse.move(pb.x + 470, pb.y + 420, { steps: 8 });
await p.mouse.up();
res.selected = await K(() => window.__kwd.selection().ink?.ids.length || 0);
const before = await K((id) => window.__kwd.store.ink(id).toArray()[0].pts.slice(0, 2), page0);
await p.mouse.move(pb.x + 250, pb.y + 312);
await p.mouse.down();
await p.mouse.move(pb.x + 300, pb.y + 372, { steps: 8 });
await p.mouse.up();
const after = await K((id) => window.__kwd.store.ink(id).toArray()[0].pts.slice(0, 2), page0);
res.moved = [Math.round(after[0] - before[0]), Math.round(after[1] - before[1])];
await p.screenshot({ path: `${OUT}/3-select.png` });
await p.keyboard.press('Delete');
res.afterDelete = await K((id) => window.__kwd.store.ink(id).length, page0);
await p.keyboard.press('Control+z');
res.afterUndo = await K((id) => window.__kwd.store.ink(id).length, page0);

// 4) 글 도구: 빈 곳 두 번 → 글상자 → 쓰기
await p.click('.toolbar [data-tool="text"]');
await p.mouse.dblclick(pb.x + 520, pb.y + 640);
await p.waitForTimeout(150);
await p.keyboard.type('여기 상자 글');
await p.waitForTimeout(150);
res.boxes = await K((id) => window.__kwd.objs(id).filter((o) => o.type === 'box').map((o) => ({ x: o.x, y: o.y, text: window.__kwd.store.boxFragment(o.id).toString().replace(/<[^>]+>/g, '') })), page0);
// 빈 상자 만들고 떠나면 사라짐
await p.mouse.dblclick(pb.x + 200, pb.y + 800);
await p.waitForTimeout(100);
await p.mouse.click(pb.x + 300, pb.y + 150);
await p.waitForTimeout(400);
res.boxesAfterEmpty = await K((id) => window.__kwd.objs(id).filter((o) => o.type === 'box').length, page0);

// 5) 웹 학습지 창: 옮기기·크기
const html = fs.readFileSync('tests/fixtures/quiz.html', 'utf8').replace('<body>', '<body style="background:#1d1f24;color:#eee">');
await K(([h]) => window.__kwd.placeHtml(h, '퀴즈'), [html]);
await p.waitForTimeout(500);
const o1 = await K((id) => window.__kwd.objs(id).find((o) => o.type === 'html'), page0);
res.htmlBelowText = o1.y > 100; // 쓴 글 아래에 놓인다
await K((o) => window.__kwd.vp.set({ y: 120 - o.y * window.__kwd.vp.view.s }), o1);
await p.waitForTimeout(100);
const bar = await (await p.$('.obj-html .obj-bar')).boundingBox();
await p.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
await p.mouse.down();
await p.mouse.move(bar.x + bar.width / 2 - 60, bar.y + bar.height / 2 + 40, { steps: 6 });
await p.mouse.up();
const o2 = await K((id) => window.__kwd.objs(id).find((o) => o.type === 'html'), page0);
res.htmlMove = [o2.x - o1.x, o2.y - o1.y];
await p.hover('.obj-html');
const sz = await (await p.$('.obj-html .obj-size')).boundingBox();
await p.mouse.move(sz.x + 8, sz.y + 8);
await p.mouse.down();
await p.mouse.move(sz.x - 100, sz.y - 60, { steps: 6 });
await p.mouse.up();
const o3 = await K((id) => window.__kwd.objs(id).find((o) => o.type === 'html'), page0);
res.htmlSize = [o3.w - o2.w, o3.h - o2.h];
// 학습지 안에서 단추 누르기 + Ctrl 휠 확대
const fr = p.frameLocator('.obj-frame');
await fr.locator('button:has-text("께")').click();
res.quiz = await fr.locator('#r').textContent();
const s0 = await K(() => window.__kwd.vp.view.s);
const fb = await (await p.$('.obj-frame')).boundingBox();
await p.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
await p.keyboard.down('Control');
await p.mouse.wheel(0, -300);
await p.keyboard.up('Control');
await p.waitForTimeout(300);
const s1 = await K(() => window.__kwd.vp.view.s);
res.zoomOverHtml = [s0, s1];
res.iframeCursor = await fr.locator('html').evaluate((el) => getComputedStyle(el).cursor.slice(0, 20));
await p.screenshot({ path: `${OUT}/4-html-obj.png` });

// 6) 사진: 원래 비율로 놓이기
await p.click('.zoom .pct');
const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('.toolbar [data-tool="import"]').then(() => p.click('.menu button:has-text("사진")'))]);
const png = OUT + '/wide.png';
await p.evaluate(() => 0);
const c = await b.newPage();
await c.setContent('<canvas id=c width=600 height=200></canvas><script>const x=document.getElementById("c").getContext("2d");x.fillStyle="#3a7";x.fillRect(0,0,600,200);x.fillStyle="#fff";x.font="60px sans-serif";x.fillText("사진 3:1",150,120)</script>');
fs.writeFileSync(png, Buffer.from((await c.evaluate(() => document.getElementById('c').toDataURL('image/png'))).split(',')[1], 'base64'));
await c.close();
await chooser.setFiles(png);
await p.waitForFunction((id) => window.__kwd.objs(id).some((o) => o.type === 'img'), page0, { timeout: 5000 });
const img = await K((id) => window.__kwd.objs(id).find((o) => o.type === 'img'), page0);
res.img = { w: img.w, h: img.h, ratio: Math.round((img.w / img.h) * 100) / 100 };
await p.screenshot({ path: `${OUT}/5-image.png` });
// 기록 묶음에 글상자 들어가나
res.md = await K(async () => { const z = await window.__kwd.bundle(); return z.files['board.md']; });
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await b.close();
