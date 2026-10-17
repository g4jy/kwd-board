import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
await p.goto('http://localhost:4173/#/b/kinds' + Date.now() + '?r=t&st=1');
await p.waitForFunction(() => window.__kwd);
const pb = await (await p.$('.page')).boundingBox();
const kinds = ['fountain', 'ball', 'brush', 'pencil'];
for (let i = 0; i < 4; i++) {
  await p.evaluate((k) => { const pr = window.__kwd.prefs(); pr.active = 0; pr.pens[0] = { color: '#222222', size: 4, kind: k }; window.__kwd.setTool('pen'); }, kinds[i]);
  const y = pb.y + 120 + i * 70;
  await p.mouse.move(pb.x + 80, y); await p.mouse.down();
  for (let t = 1; t <= 30; t++) await p.mouse.move(pb.x + 80 + t * 12, y + Math.sin(t / 4) * 20);
  await p.mouse.up();
}
await p.evaluate(() => { const pr = window.__kwd.prefs(); pr.hl = { color: '#7cc8ff', size: 20, opacity: 0.25 }; window.__kwd.setTool('hl'); });
await p.mouse.move(pb.x + 80, pb.y + 420); await p.mouse.down(); await p.mouse.move(pb.x + 460, pb.y + 420, { steps: 10 }); await p.mouse.up();
await p.evaluate(() => { const pr = window.__kwd.prefs(); pr.hl = { color: '#7cc8ff', size: 20, opacity: 0.7 }; window.__kwd.setTool('hl'); });
await p.mouse.move(pb.x + 80, pb.y + 460); await p.mouse.down(); await p.mouse.move(pb.x + 460, pb.y + 460, { steps: 10 }); await p.mouse.up();
await p.screenshot({ path: '/tmp/kinds.png', clip: { x: pb.x, y: pb.y + 60, width: 560, height: 440 } });
await b.close();
