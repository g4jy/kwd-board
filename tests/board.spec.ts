import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const WS = process.env.WS_URL || 'ws://localhost:1234';
const HTTP = WS.replace(/^ws/, 'http');
const TOKEN = 'testtoken';

// 페이지 안의 window.__kwd 에서 함수를 실행
async function kwd<T>(page: Page, fn: (k: any) => T | Promise<T>): Promise<T> {
  return page.evaluate(async (src: string) => {
    const f = (0, eval)('(' + src + ')');
    return await f((window as any).__kwd);
  }, fn.toString()) as Promise<T>;
}

async function imeType(page: Page, syllables: Array<[string[], string]>) {
  const client = await page.context().newCDPSession(page);
  for (const [steps, final] of syllables) {
    for (const s of steps) await client.send('Input.imeSetComposition', { text: s, selectionStart: -1, selectionEnd: -1 });
    await client.send('Input.insertText', { text: final });
  }
  await client.detach();
}

async function openTeacher(page: Page, id: string, student = '12', srv?: string, tk?: string) {
  const q = `r=t&st=${student}` + (srv ? `&srv=${encodeURIComponent(srv)}` : '') + (tk ? `&tk=${tk}` : '');
  await page.goto(`/#/b/${id}?${q}`);
  await page.waitForSelector('.board-doc');
  await page.waitForFunction(() => !!(window as any).__kwd);
  await page.waitForTimeout(350);
}

const newId = () => 'test' + Math.random().toString(36).slice(2, 8);
const firstDoc = (page: Page) => page.locator('.page-text .board-doc').first();

// 글 안 낱말의 화면 위치
async function wordRect(page: Page, word: string) {
  return page.evaluate((w) => {
    const walker = document.createTreeWalker(document.querySelector('.pages')!, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const i = (n as Text).data.indexOf(w);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + w.length);
        const b = r.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      }
    }
    return null;
  }, word);
}

async function drawLine(page: Page, pts: Array<[number, number]>) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
}

test.describe('판 화면', () => {
  test('홈 → 새 판: 목록 버튼·페이지 목록·확대 조절이 보이고 커서가 글에 있다', async ({ page }) => {
    await page.goto('/#/');
    await page.fill('input[placeholder="학생 번호"]', '12');
    await page.click('button:has-text("새 수업")');
    await page.waitForSelector('.board-doc');
    await expect(page).toHaveURL(/#\/b\/[a-z0-9]{10}\?r=t$/);
    await expect(page.locator('.back-btn')).toBeVisible();
    await expect(page.locator('.rail-item')).toHaveCount(1);
    await expect(page.locator('.zoom .pct')).toHaveText('100%');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('board-doc'))).toBe(true);
    // 도구 줄: 선택 · 글 · 펜3 · 형광 · 지우개 · ↶ · ↷ · 가져오기 · ⋯
    await expect(page.locator('.toolbar button')).toHaveCount(11);
    await page.click('.back-btn');
    await expect(page.locator('h1')).toHaveText('KWD 클래스룸');
    await expect(page.locator('.board-row').first()).toContainText('학생 12');
  });

  test('한글 조합 입력이 깨지지 않고, 타자 중 자동 변환은 없다 (단어 : 뜻은 글로 남음)', async ({ page }) => {
    await openTeacher(page, newId());
    await imeType(page, [[['ㅎ', '호'], '호'], [['ㅂ', '바', '박'], '박']]);
    await page.keyboard.type(' : pumpkin');
    await page.keyboard.press('Enter');
    await page.keyboard.type('만족해요 : to be satisfied');
    await page.keyboard.press('Enter');
    await expect(firstDoc(page)).toContainText('호박 : pumpkin');
    await expect(page.locator('.word-card')).toHaveCount(0);
    expect(await kwd(page, (k) => k.editor().getText())).toContain('만족해요 : to be satisfied');
  });

  test('빈칸·교정·색·변형 표 (선택 메뉴)', async ({ page }) => {
    await openTeacher(page, newId());
    await page.keyboard.type('학부모님들은 ___');
    await expect(page.locator('.blank')).toHaveCount(1);
    await page.keyboard.type('고 말했어요');
    await page.keyboard.press('Enter');
    await page.keyboard.type('저는 학교에 갑니다');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(150);
    await page.click('.bubble button:has-text("교정")');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('감');
    await expect(page.locator('.correction .corr-orig mark.d-sub')).toHaveAttribute('title', '받침');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('마시다');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(150);
    await page.click('.bubble button[title="빨강"]');
    await expect(page.locator('.board-doc span[style*="color"]')).toHaveText('마시다');
    await page.click('.bubble button:has-text("변형 표")');
    await expect(page.locator('.board-doc th')).toHaveCount(4);
  });
});

test.describe('펜', () => {
  test('펜 3칸: 누르면 바뀌고, 한 번 더 누르면 설정창 — 색·굵기·최근 색이 새로고침 뒤에도 남는다', async ({ page }) => {
    const id = newId();
    await openTeacher(page, id);
    await page.click('.pen-slot[data-slot="1"]');
    expect(await kwd(page, (k) => k.tool())).toBe('pen');
    await expect(page.locator('.pen-slot[data-slot="1"]')).toHaveClass(/on/);
    await expect(page.locator('.pen-pop')).toHaveCount(0);
    await page.click('.pen-slot[data-slot="1"]');
    await expect(page.locator('.pen-pop')).toBeVisible();
    await expect(page.locator('.pen-pop .pp-sw[data-color]')).toHaveCount(12);
    await page.click('.pen-pop .pp-sw[title="보라"]');
    await page.locator('.pen-pop .pp-slider').fill('9');
    await page.click('.pen-pop .pp-step[title="굵게"]');
    expect(await kwd(page, (k) => k.ink.style)).toMatchObject({ color: '#6a1b9a', size: 10, hl: false });
    // 직접 고른 색은 '최근'에 남는다 (끌어 고르기 창의 색 코드 칸)
    await page.click('.pen-pop .pp-sw.custom');
    await page.locator('.pen-pop .cp-hex').fill('#123456');
    await page.locator('.pen-pop .cp-hex').press('Tab');
    await expect(page.locator('.pen-pop .pp-recent .pp-sw')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pen-pop')).toHaveCount(0);
    // 형광펜
    await page.click('.pen-slot[data-slot="3"]');
    expect(await kwd(page, (k) => k.tool())).toBe('hl');
    await page.click('.pen-slot[data-slot="3"]');
    await expect(page.locator('.pen-pop .pp-sw[data-color]')).toHaveCount(8);
    await page.click('.pen-pop .pp-sw[title="분홍"]');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__kwd);
    const prefs = await kwd(page, (k) => k.prefs());
    expect(prefs.pens[1]).toMatchObject({ color: '#123456', size: 10 });
    expect(prefs.hl.color).toBe('#ff8fc7');
    expect(prefs.recent[0]).toBe('#123456');
  });

  test('밑줄·동그라미가 글자 대상으로 기록되고, 지우개·되돌리기는 글과 한 스택', async ({ page }) => {
    await openTeacher(page, newId());
    await page.keyboard.type('저는 물을 마셔요.');
    await page.click('.pen-slot[data-slot="1"]');
    const w = (await wordRect(page, '물을'))!;
    const under: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) under.push([w.x - 2 + ((w.w + 4) * i) / 10, w.y + w.h + 3]);
    await drawLine(page, under);
    const m = (await wordRect(page, '마셔요'))!;
    const circ: Array<[number, number]> = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2.1;
      circ.push([m.x + m.w / 2 + Math.cos(a) * (m.w / 2 + 8), m.y + m.h / 2 + Math.sin(a) * (m.h / 2 + 6)]);
    }
    await drawLine(page, circ);
    const inks = await kwd(page, (k) => k.store.events.toArray().filter((e: any) => e.kind === 'ink').map((e: any) => ({ text: e.text, shape: e.data.shape, block: !!e.block })));
    expect(inks[0]).toEqual({ text: '물을', shape: 'underline', block: true });
    expect(inks[1].shape).toBe('circle');
    expect(inks[1].text).toContain('마셔요');
    // 지우개 크기 설정창 → 이 페이지 잉크 모두 지우기 → 되돌리기
    await page.click('.toolbar [data-tool="eraser"]');
    await page.click('.toolbar [data-tool="eraser"]');
    await expect(page.locator('.pen-pop .pp-chip:not([data-mode])')).toHaveCount(3);
    await expect(page.locator('.pen-pop .pp-chip[data-mode]')).toHaveCount(2); // 획 전체 · 닿은 부분만
    await page.click('.pen-pop .pp-wide');
    expect(await kwd(page, (k) => k.store.ink(k.current()).length)).toBe(0);
    await page.click('.toolbar [data-tool="undo"]');
    expect(await kwd(page, (k) => k.store.ink(k.current()).length)).toBe(2);
    await page.click('.toolbar [data-tool="undo"]');
    expect(await kwd(page, (k) => k.store.ink(k.current()).length)).toBe(1);
    await page.click('.toolbar [data-tool="undo"]');
    await page.click('.toolbar [data-tool="undo"]');
    expect(await kwd(page, (k) => k.editor().getText())).toBe('');
    await page.click('.toolbar [data-tool="redo"]');
    expect(await kwd(page, (k) => k.editor().getText())).toBe('저는 물을 마셔요.');
  });
});

test.describe('페이지·확대·자료', () => {
  test('무한 판: 노트 밖 어디에나 그리기, 움직이되 놓인 것 밖으로 다 빠져나가지 않음, 확대·전체 보기, 오른쪽 목록', async ({ page }) => {
    await openTeacher(page, newId());
    await page.keyboard.type('노트에 쓴 글');
    // 페이지 추가 단추는 없다 (판 하나)
    await expect(page.locator('.rail-add')).toHaveCount(0);
    await expect(page.locator('.rail-item')).toHaveCount(1);
    // 노트 카드 오른쪽 빈 곳에 그리기 → 판(첫 페이지)에 들어가고 노트 폭(820) 밖 좌표
    const note = (await page.locator('.page.canvas .page-text').boundingBox())!;
    await page.click('.pen-slot[data-slot="1"]');
    await drawLine(page, [[note.x + note.width + 60, note.y + 80], [note.x + note.width + 160, note.y + 120], [note.x + note.width + 220, note.y + 90]]);
    const st = await kwd(page, (k) => k.store.ink(k.pages()[0].id).toArray()[0].pts.slice(0, 2));
    expect(st[0]).toBeGreaterThan(820);
    // 빈 곳 두 번 누르기 → 그 자리 글상자 (노트 밖)
    await page.click('.toolbar [data-tool="text"]');
    await page.mouse.dblclick(note.x + note.width + 120, note.y + 300);
    await page.keyboard.type('밖에 쓴 글상자');
    const bx = await kwd(page, (k) => k.objs(k.pages()[0].id).find((o: any) => o.type === 'box'));
    expect(bx.x).toBeGreaterThan(820);
    // 한참 움직여도 놓인 것이 화면 밖으로 다 빠져나가지 않는다
    const box = (await page.locator('.stage').boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + 300);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 900);
    const v = await kwd(page, (k) => ({ ...k.vp.view, b: k.boxes()[0] }));
    expect(v.y + 400 * v.s).toBeGreaterThan(0); // 노트 위쪽이 화면 위로 다 사라지지 않음
    for (let i = 0; i < 40; i++) await page.mouse.wheel(900, 0);
    const v2 = await kwd(page, (k) => ({ ...k.vp.view }));
    expect(v2.x + 1100 * v2.s).toBeGreaterThan(0);
    // 확대 버튼 · 전체 보기
    await page.click('.zoom .zb[title^="확대"]');
    const s1 = await kwd(page, (k) => k.vp.view.s);
    await page.click('.zoom .zb[title^="축소"]');
    await page.click('.zoom .zb[title^="축소"]');
    expect(await kwd(page, (k) => k.vp.view.s)).toBeLessThan(s1);
    await page.click('.zoom .pct');
    const all = await kwd(page, (k) => { const [cx, cy] = k.vp.center(); return { cx, cy, s: k.vp.view.s }; });
    expect(all.cx).toBeGreaterThan(300);
    expect(all.cx).toBeLessThan(1200);
    // 목록의 노트 → 노트로
    await page.click('.rail-item[data-key="note"]');
    const n = await kwd(page, (k) => k.vp.center());
    expect(n[0]).toBeGreaterThan(200);
    expect(n[0]).toBeLessThan(620);
  });

  test('PDF 슬라이드: 쪽마다 판 위에 한 장씩, 글자층, 쪽 위 동그라미는 그 쪽 글자로 기록, 목록으로 이동', async ({ page }) => {
    await openTeacher(page, newId());
    await page.keyboard.type('수업 노트');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.toolbar [data-tool="import"]').then(() => page.click('.menu button:has-text("PDF")'))]);
    await chooser.setFiles('tests/fixtures/slides.pdf');
    await expect(page.locator('.obj-slide')).toHaveCount(3, { timeout: 20000 });
    expect(await kwd(page, (k) => k.pages().length)).toBe(1);
    await expect(page.locator('.rail-item')).toHaveCount(4);
    const mats = await kwd(page, (k) => Array.from(k.store.matdata.values()).map((d: any) => d.text.map((t: any) => t.s).join(' ')));
    expect(mats[0].replace(/\s/g, '')).toContain('추석에가족이모두모여요');
    // 가져오면 첫 쪽으로 간다
    await expect(page.locator('.rail-item.on')).toHaveAttribute('title', /1\/3/);
    // 첫 쪽 위 '송편' 쯤 동그라미
    await page.click('.pen-slot[data-slot="1"]');
    const sb = (await page.locator('.obj-slide').first().boundingBox())!;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2.1;
      pts.push([sb.x + sb.width * 0.12 + Math.cos(a) * 60, sb.y + sb.height * 0.6 + Math.sin(a) * 25]);
    }
    await drawLine(page, pts);
    expect(await kwd(page, (k) => k.store.ink(k.pages()[0].id).length)).toBe(1);
    const ev = await kwd(page, (k) => k.store.events.toArray().filter((e: any) => e.kind === 'ink').pop());
    expect(ev.block).toMatch(/^mat:/);
    // 목록으로 셋째 쪽 → 화면 가운데가 그 쪽
    await page.keyboard.press('Escape');
    await page.locator('.rail-item').nth(3).click();
    const third = await kwd(page, (k) => k.objs(k.pages()[0].id).filter((o: any) => o.type === 'slide')[2]);
    const c = await kwd(page, (k) => k.vp.center());
    expect(c[0]).toBeGreaterThan(third.x);
    expect(c[0]).toBeLessThan(third.x + third.w);
    const shows = await kwd(page, (k) => k.store.events.toArray().filter((e: any) => e.kind === 'page' && e.data.op === 'show').length);
    expect(shows).toBeGreaterThanOrEqual(2);
  });

  test('HTML 자료: 버튼이 그대로 동작하고 조작이 기록된다', async ({ page }) => {
    await openTeacher(page, newId());
    const html = fs.readFileSync('tests/fixtures/quiz.html', 'utf8');
    await kwd(page, (k) => k); // ready
    await page.evaluate((h) => (window as any).__kwd.importHtmlText(h, '조사 퀴즈'), html);
    await expect(page.locator('.mat-frame')).toHaveCount(1);
    await page.click('.rail-item:has-text("2")');
    const frame = page.frameLocator('.mat-frame');
    await frame.locator('button:has-text("께")').click();
    await expect(frame.locator('#r')).toHaveText('정답!');
    await expect.poll(() => kwd(page, (k) => k.store.events.toArray().filter((e: any) => e.kind === 'interaction').map((e: any) => e.data.name + ':' + e.data.value))).toContain('answer:께');
  });
});

test.describe('수업 기록 묶음', () => {
  test('.kwd.zip: manifest · board.md(잉크를 글로) · events · 자료 글자층', async ({ page }) => {
    await openTeacher(page, newId(), '1000001');
    await page.keyboard.type('추석에 가족이 모두 모여요.');
    await page.click('.pen-slot[data-slot="1"]');
    const w = (await wordRect(page, '가족이'))!;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) pts.push([w.x + (w.w * i) / 10, w.y + w.h + 3]);
    await drawLine(page, pts);
    await page.keyboard.press('Escape');
    const pdf = fs.readFileSync('tests/fixtures/slides.pdf').toString('base64');
    await page.evaluate(async (b) => await (window as any).__kwd.importPdfBytes(b, '추석 슬라이드'), pdf);
    const b64 = await page.evaluate(async () => {
      const { blob } = await (window as any).__kwd.bundle();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    });
    const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
    const names = Object.keys(zip.files);
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'board.md', 'events.ndjson', 'board.json']));
    expect(names.some((n) => /^materials\/.+\.text\.json$/.test(n))).toBe(true);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.schema).toBe('kwd-lesson-bundle/v1');
    expect(manifest.student).toBe('1000001');
    expect(manifest.pages.length).toBe(1);
    const md = await zip.file('board.md')!.async('string');
    expect(md).toContain('추석에 가족이 모두 모여요.');
    expect(md).toContain("✎ '가족이' 밑줄 (빨강)");
    expect(md).toContain('[슬라이드');
    expect(md).toContain('송편을 만들어요');
    const evs = (await zip.file('events.ndjson')!.async('string')).trim().split('\n').map((l) => JSON.parse(l));
    expect(evs.every((e) => typeof e.t === 'number' && e.role)).toBe(true);
    expect(evs.some((e) => e.kind === 'text' && e.block)).toBe(true);
  });
});

test.describe('학생 메모리', () => {
  test('서버의 memory.json → 머리말·이 학생 패널·점선 힌트 (학생 기기에는 없음)', async ({ browser, request }) => {
    const student = 'm' + Math.random().toString(36).slice(2, 7);
    const mem = {
      student,
      vocab: [
        { kr: '송편', en: 'rice cake', first: '9/24', count: 1, status: 'review' },
        { kr: '마셔요', en: 'drink', first: '6/2', count: 6, status: 'known' },
      ],
      grammar: [{ pattern: '-기를 바랍니다', first: '9/24', count: 1, examples: ['가시기를 바랍니다'] }],
      errors: [{ type: '조사', pattern: '에게/께', wrong: '원장님에게', right: '원장님께', count: 2 }],
      homework: [{ given: '9/24', status: 'open', text: '피자 이야기 녹음' }],
      lessons: [{ id: 'L34', date: '9/24', summary: '추석' }],
      next: { focus: ['-기를 바랍니다'], review: ['송편'], homework: ['피자 이야기 녹음'] },
    };
    const put = await request.put(`${HTTP}/students/${student}/memory.json`, { data: mem, headers: { authorization: 'Bearer ' + TOKEN } });
    expect(put.ok()).toBe(true);
    expect((await request.get(`${HTTP}/students/${student}/memory.json`)).status()).toBe(401);
    const ctxT = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    const ctxS = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const t = await ctxT.newPage();
    const s = await ctxS.newPage();
    const id = newId();
    await openTeacher(t, id, student, WS, TOKEN);
    await expect(t.locator('.mem-btn')).toBeVisible({ timeout: 8000 });
    await expect(firstDoc(t).locator('blockquote')).toContainText('복습: 송편');
    await expect(firstDoc(t).locator('blockquote')).not.toContainText('에게');
    await t.keyboard.type('저는 물을 마셔요.');
    await expect(t.locator('.mem-hint')).toHaveCount(2); // 머리말의 '송편' + 본문 '마셔요'
    await expect(t.locator('.mem-hint').last()).toHaveAttribute('title', /6\/2 처음/);
    await t.click('.mem-btn');
    await expect(t.locator('.mem-panel .mp-row')).toHaveCount(2);
    await t.click('.mem-panel .mp-tab:has-text("오류")');
    await expect(t.locator('.mem-panel')).toContainText('에게/께');
    await t.click('.mem-panel .mp-tab:has-text("단어")');
    await expect(t.locator('.mem-panel .mp-search')).toBeHidden(); // 8개 이하는 찾기 칸 없음
    await expect(t.locator('.mem-panel .mp-row').first()).toContainText('송편');
    await t.click('.mem-panel .mp-ins >> nth=0');
    // 노트 줄로 끼우지 않고 판 위 글상자로 (10/18)
    await expect(t.locator('.obj-box-text').filter({ hasText: '송편 : rice cake' })).toHaveCount(1);
    const memEv = await kwd(t, (k) => k.store.events.toArray().filter((e: any) => e.src === 'memory').length);
    expect(memEv).toBeGreaterThanOrEqual(2);
    // 학생 기기: 머리말은 보이되 메모리·힌트·오류는 없다
    await s.goto(`/#/b/${id}?r=s&srv=${encodeURIComponent(WS)}`);
    await s.waitForSelector('.board-doc');
    await expect(s.locator('blockquote')).toContainText('복습: 송편', { timeout: 10000 });
    await expect(s.locator('.mem-btn')).toBeHidden();
    await expect(s.locator('.mem-hint')).toHaveCount(0);
    const leaked = await s.evaluate(() => JSON.stringify((window as any).__kwd.store.doc.toJSON()).includes('에게/께'));
    expect(leaked).toBe(false);
    await ctxT.close();
    await ctxS.close();
  });
});

test.describe('두 기기', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  test.afterEach(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('선생님 → 학생(폰): 같은 좌표, 글·잉크·슬라이드, 여기 보세요·자유·따라가기, 권한, 빈칸, 끊김 복구', async ({ browser }) => {
    const id = newId();
    ctxA = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    ctxB = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const t = await ctxA.newPage();
    const s = await ctxB.newPage();
    await openTeacher(t, id, '7', WS);
    await s.goto(`/#/b/${id}?r=s&srv=${encodeURIComponent(WS)}`);
    await s.click('.join-board');
    await s.waitForSelector('.board-doc');
    await expect(s.locator('.chip .dot')).toHaveClass(/connected/, { timeout: 10000 });
    await expect(t.locator('.chip')).toContainText('학생 연결됨', { timeout: 10000 });
    await expect(s.locator('.toolbar')).toBeHidden();
    await expect(s.locator('.back-btn')).toBeHidden();
    await expect(s.locator('.rail')).toBeHidden();
    // 노트 카드는 폰에서도 같은 판 좌표·같은 폭 (기기마다 다시 흘리지 않는다)
    const geo = (pg: Page) => pg.evaluate(() => { const v = (window as any).__kwd.vp.view; const st = document.querySelector('.stage')!.getBoundingClientRect(); const b = document.querySelector('.page.canvas .page-text')!.getBoundingClientRect(); return [Math.round((b.left - st.left - v.x) / v.s), Math.round(b.width / v.s)]; });
    expect(await geo(s)).toEqual(await geo(t));
    await t.keyboard.type('추석 : Korean harvest festival');
    await expect(s.locator('.board-doc').first()).toContainText('추석 : Korean harvest festival', { timeout: 10000 });
    // 같은 글 크기 → 잉크가 같은 글자 위에
    await t.click('.pen-slot[data-slot="1"]');
    const w = (await wordRect(t, '추석'))!;
    await drawLine(t, [[w.x, w.y + w.h + 3], [w.x + w.w / 2, w.y + w.h + 4], [w.x + w.w, w.y + w.h + 3]]);
    await expect.poll(() => kwd(s, (k) => k.store.ink(k.pages()[0].id).length), { timeout: 10000 }).toBe(1);
    await t.keyboard.press('Escape');
    // 자료(PDF) → 판 위 슬라이드. 학생 화면에도 같은 자리에
    const pdf = fs.readFileSync('tests/fixtures/slides.pdf').toString('base64');
    await t.evaluate(async (b) => await (window as any).__kwd.importPdfBytes(b, '추석'), pdf);
    await expect(s.locator('.obj-slide .slide-img')).toHaveCount(3, { timeout: 15000 });
    // 서버가 있으면 자료 그림은 문서 밖(서버)에 — 문서에는 열쇠만, 학생 화면에 실제로 그려진다
    const imgs = await kwd(t, (k) => Array.from(k.store.matdata.values()).map((d: any) => String(d.img).slice(0, 5)));
    expect(imgs.every((x: string) => x === 'blob:')).toBe(true);
    await expect.poll(() => s.evaluate(() => Array.from(document.querySelectorAll('.slide-img')).every((i: any) => i.complete && i.naturalWidth > 1000)), { timeout: 10000 }).toBe(true);
    // 학생은 처음 한 번 선생님 화면으로 온 뒤로는 자유. 선생님이 '여기 보세요' → 학생 화면이 둘째 쪽으로
    const slides = await kwd(t, (k) => k.objs(k.pages()[0].id).filter((o: any) => o.type === 'slide'));
    await t.locator('.rail-item').nth(2).click();
    await t.click('.look-btn');
    await expect.poll(async () => { const c = await kwd(s, (k) => k.vp.center()); return c[0] > slides[1].x && c[0] < slides[1].x + slides[1].w; }, { timeout: 10000 }).toBe(true);
    await expect(s.locator('.look-flash')).toHaveCount(1);
    // 학생이 손가락으로 움직이면 자유 → '선생님 화면으로' 단추
    const sb = (await s.locator('.stage').boundingBox())!;
    await s.touchscreen.tap(sb.x + 10, sb.y + sb.height - 10).catch(() => undefined);
    await s.evaluate(() => { const st = document.querySelector('.stage')!; st.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true })); });
    await expect(s.locator('.follow-btn')).toBeVisible();
    // 선생님이 목록에서 고르면 학생도 그것으로 (조용히, 10/18)
    await t.click('.rail-item[data-key="note"]');
    await expect.poll(async () => (await kwd(s, (k) => k.vp.center()))[0], { timeout: 10000 }).toBeLessThan(900);
    await expect(s.locator('.look-flash')).toHaveCount(0, { timeout: 5000 });
    // 학생이 다시 움직이면 자유: 선생님이 손으로 판을 밀어도 학생은 그대로, '선생님 화면으로'를 누르면 따라감
    await s.evaluate(() => { const st = document.querySelector('.stage')!; st.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true })); });
    await expect(s.locator('.follow-btn')).toBeVisible();
    const free = await kwd(s, (k) => k.vp.center());
    await t.evaluate(() => { const st = document.querySelector('.stage')!; for (let i = 0; i < 4; i++) st.dispatchEvent(new WheelEvent('wheel', { deltaX: 400, bubbles: true, cancelable: true })); });
    await t.waitForTimeout(500);
    expect(await kwd(s, (k) => k.vp.center())).toEqual(free);
    const tc = await kwd(t, (k) => k.vp.center());
    await s.click('.follow-btn');
    await expect.poll(async () => Math.abs((await kwd(s, (k) => k.vp.center()))[0] - tc[0]), { timeout: 10000 }).toBeLessThan(150);
    // 권한: 학생 글 쓰기
    await t.click('.toolbar [data-tool="more"]');
    await t.click('.menu button:has-text("글 쓰기")');
    await expect(t.locator('.menu')).toHaveCount(1); // 토글을 눌러도 메뉴는 열린 채로
    await t.keyboard.press('Escape');
    await expect(t.locator('.menu')).toHaveCount(0);
    await expect.poll(() => kwd(s, (k) => k.editor().isEditable), { timeout: 10000 }).toBe(true);
    await s.evaluate(() => (window as any).__kwd.editor().commands.focus('end'));
    await expect.poll(() => s.evaluate(() => document.activeElement?.classList.contains('board-doc'))).toBe(true);
    await s.keyboard.press('Enter');
    await s.keyboard.type('학생이 씁니다');
    await expect(t.locator('.board-doc').first()).toContainText('학생이 씁니다', { timeout: 10000 });
    await t.click('.toolbar [data-tool="more"]');
    await t.click('.menu button:has-text("글 쓰기")');
    await expect.poll(() => kwd(s, (k) => k.editor().isEditable), { timeout: 10000 }).toBe(false);
    await t.keyboard.press('Escape');
    // 빈칸은 권한 없이도
    await t.evaluate(() => (window as any).__kwd.editor().commands.focus('end'));
    await expect.poll(() => t.evaluate(() => document.activeElement?.classList.contains('board-doc'))).toBe(true);
    await t.keyboard.press('Enter');
    await t.keyboard.type('오늘은 ___');
    await expect(s.locator('.blank input')).toHaveCount(1, { timeout: 10000 });
    await s.locator('.blank input').fill('추석이에요');
    await s.locator('.blank input').press('Enter');
    await expect(t.locator('.blank input')).toHaveValue('추석이에요', { timeout: 10000 });
    // 끊김 → 선생님이 씀 → 재연결 뒤 합쳐짐
    await s.evaluate(() => (window as any).__kwd.store.provider.disconnect());
    await t.evaluate(() => (window as any).__kwd.editor().commands.focus('end'));
    await expect.poll(() => t.evaluate(() => document.activeElement?.classList.contains('board-doc'))).toBe(true);
    await t.keyboard.press('Enter');
    await t.keyboard.type('끊긴 동안 쓴 줄');
    await t.waitForTimeout(400);
    await expect(s.locator('.board-doc').first()).not.toContainText('끊긴 동안 쓴 줄');
    await s.evaluate(() => (window as any).__kwd.store.provider.connect());
    await expect(s.locator('.board-doc').first()).toContainText('끊긴 동안 쓴 줄', { timeout: 15000 });
    // 서버 시각 보정이 기록 묶음에 들어간다
    const clock = await kwd(t, (k) => ({ off: k.store.clockOffset, rtt: k.store.clockRtt }));
    expect(clock.rtt).toBeGreaterThanOrEqual(0);
  });

  test('보조기기(태블릿): 펜만, 획은 선생님에게 assist 로', async ({ browser }) => {
    const id = newId();
    ctxA = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    ctxB = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const t = await ctxA.newPage();
    const a = await ctxB.newPage();
    await openTeacher(t, id, '3', WS);
    await a.goto(`/#/b/${id}?r=a&srv=${encodeURIComponent(WS)}`);
    await a.waitForSelector('.board-doc');
    await expect(a.locator('.chip .dot')).toHaveClass(/connected/, { timeout: 10000 });
    await expect(a.locator('.toolbar button')).toHaveCount(7); // 펜3·형광·지우개·↶·↷
    await a.click('.pen-slot[data-slot="0"]');
    const box = (await a.locator('.page').first().boundingBox())!;
    await drawLine(a, [[box.x + 100, box.y + 300], [box.x + 200, box.y + 320], [box.x + 300, box.y + 300]]);
    await expect.poll(() => kwd(t, (k) => k.store.ink(k.pages()[0].id).length), { timeout: 10000 }).toBe(1);
    expect(await kwd(t, (k) => k.store.ink(k.pages()[0].id).toArray()[0].role)).toBe('assist');
  });
});

test.describe('밤 루틴', () => {
  test('가짜 수업: 기록 묶음 + 시계가 4.2초 틀린 전사 → 글 메아리로 1초 안쪽 복원, 토큰 2만 이하', async ({ page }) => {
    test.setTimeout(120_000);
    await openTeacher(page, newId(), '1000001');
    const lines = ['추석에 가족이 모두 모여요.', '송편을 만들어요. 반달 모양이에요.', '성묘해요. 조상님 무덤에 가요.', '가기를 바랍니다 가시기를 바랍니다', '원장님께 피자가 맛있다고 말씀드렸어요.'];
    for (const l of lines) {
      await page.keyboard.type(l, { delay: 5 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3300); // 글 사건이 기록되도록
    }
    await page.click('.pen-slot[data-slot="1"]');
    const w = (await wordRect(page, '송편을'))!;
    await drawLine(page, [[w.x, w.y + w.h + 3], [w.x + w.w / 2, w.y + w.h + 4], [w.x + w.w, w.y + w.h + 3]]);
    await page.keyboard.press('Escape');
    const pdf = fs.readFileSync('tests/fixtures/slides.pdf').toString('base64');
    await page.evaluate(async (b) => await (window as any).__kwd.importPdfBytes(b, '추석 슬라이드'), pdf);
    await page.evaluate(() => { const k = (window as any).__kwd; k.gotoItem(k.objs(k.pages()[0].id).filter((o: any) => o.type === 'slide')[1].id); });
    const b64 = await page.evaluate(async () => {
      const { blob } = await (window as any).__kwd.bundle();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    });
    const out = path.resolve('test-results/night');
    fs.mkdirSync(out, { recursive: true });
    const bundlePath = path.join(out, 'lesson.kwd.zip');
    fs.writeFileSync(bundlePath, Buffer.from(b64, 'base64'));
    // 전사 만들기: 녹화 파일명 시각은 KST, 실제 녹화 시작은 판 시작 20초 전, 그런데 녹화 PC 시계가 4.2초 느림
    const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
    const evs = (await zip.file('events.ndjson')!.async('string')).trim().split('\n').map((l) => JSON.parse(l));
    const texts = evs.filter((e) => e.kind === 'text' && !e.src);
    const started = Math.min(...evs.map((e) => e.t));
    const skew = -4200; // 녹화 PC 시계가 4.2초 느림 → 파일명이 실제보다 이르다
    const realVideoStart = started - 20000;
    const nameStart = new Date(realVideoStart + skew + 9 * 3600 * 1000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    // 파일명은 초 단위라 버림이 생긴다 → 보정할 값에 포함
    const name = `${nameStart.getUTCFullYear()}-${p2(nameStart.getUTCMonth() + 1)}-${p2(nameStart.getUTCDate())} ${p2(nameStart.getUTCHours())}-${p2(nameStart.getUTCMinutes())}-${p2(nameStart.getUTCSeconds())}.mkv`;
    const nameMs = Date.UTC(nameStart.getUTCFullYear(), nameStart.getUTCMonth(), nameStart.getUTCDate(), nameStart.getUTCHours(), nameStart.getUTCMinutes(), nameStart.getUTCSeconds()) - 9 * 3600 * 1000;
    const lags = [-1200, 400, -600, 900, -300];
    const teacherSegs = texts.map((e, i) => {
      const spokenAt = e.t - 3000 + lags[i % lags.length]; // 말은 타자와 함께
      const start = (spokenAt - realVideoStart) / 1000;
      return { start, end: start + 3, text: `${e.text} 따라 해 보세요.` };
    });
    teacherSegs.push({ start: 5, end: 9, text: 'Hello, how was your weekend?' });
    const transcript = {
      schema: 1,
      source: { name },
      tracks: [
        { label: 'Teacher', stream_start_time: 0, segments: teacherSegs },
        { label: 'Student', stream_start_time: 0, segments: [{ start: 12, end: 14, text: '주말에 등산 갔어요.' }] },
      ],
    };
    const trPath = path.join(out, 'transcript.json');
    fs.writeFileSync(trPath, JSON.stringify(transcript));
    const stdout = execFileSync('python3', ['night/kwd_night.py', 'all', '--bundle', bundlePath, '--transcript', trPath, '--out', out], { encoding: 'utf8' });
    console.log(stdout);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'sync_report.json'), 'utf8'));
    expect(report.echo_matches).toBeGreaterThanOrEqual(4);
    // 기대 보정 = 실제 시작 − 파일명 시각
    const expected = realVideoStart - nameMs;
    expect(Math.abs(-report.applied_offset_ms - expected)).toBeLessThan(1000);
    const compact = fs.readFileSync(path.join(out, 'timeline_compact.md'), 'utf8');
    expect(compact).toContain("펜: '송편을' 밑줄");
    expect(compact).toContain('자료글: -기를 바랍니다');
    expect(compact).toMatch(/\[\d\d:\d\d\] T: /);
    const tokens = JSON.parse(fs.readFileSync(path.join(out, 'tokens.json'), 'utf8'));
    expect(tokens.prompt_total).toBeLessThan(20000);
    const hint = JSON.parse(fs.readFileSync(path.join(out, 'vocab_hint.json'), 'utf8'));
    expect(hint.hotwords).toContain('송편을');
  });

  test('memory 명령: .lesson_data_*.json → memory.json (판이 읽는 모양)', async () => {
    const dir = path.resolve('test-results/student-fake');
    fs.mkdirSync(dir, { recursive: true });
    const mk = (n: number, date: string, vocab: string[], status = 'introduced') => ({
      meta: { preply_id: '1000001', lesson_number: n, date, lesson_id: `S_${date}_L${n}` },
      vocabulary: vocab.map((kr) => ({ kr, en: kr + '-en', student_status: status })),
      grammar_patterns: [{ pattern_kr: '기를 바랍니다', name_en: 'wish', examples: ['먹기를 바랍니다'] }],
      corrections: [{ error_type: '조사', pattern: '에게/께', learner_kr: '원장님에게', corrected_kr: '원장님께' }],
      next_steps: { homework_items: [{ task_en: 'record the pizza story' }] },
    });
    fs.writeFileSync(path.join(dir, '.lesson_data_33.json'), JSON.stringify(mk(33, '2026-09-12', ['반죽', '마셔요'], 'used_correctly')));
    fs.writeFileSync(path.join(dir, '.lesson_data_34.json'), JSON.stringify(mk(34, '2026-09-24', ['송편', '마셔요'], 'used_correctly')));
    const outFile = path.resolve('test-results/student-fake/memory.json');
    execFileSync('python3', ['night/kwd_night.py', 'memory', '--student-dir', dir, '--out', outFile]);
    const mem = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(mem.student).toBe('1000001');
    expect(mem.vocab.find((v: any) => v.kr === '마셔요').count).toBe(2);
    expect(mem.errors[0]).toMatchObject({ type: '조사', pattern: '에게/께', count: 2, right: '원장님께' });
    expect(mem.next.review).toEqual(expect.arrayContaining(['송편']));
    expect(mem.lessons[0].id).toBe('L34');
  });
});

test.describe('태블릿 입력·성능', () => {
  test('펜 필압 기록, 펜 쓴 뒤 손가락은 이동·확대, S펜 옆 버튼은 지우개', () => {
    const out = execFileSync('node', ['scripts/pen-touch.mjs'], { encoding: 'utf8' }).trim().split('\n').pop()!;
    const r = JSON.parse(out);
    expect(r.errs).toEqual([]);
    expect(r.afterPen).toBe(1);
    const pr = (JSON.parse('[' + r.stroke.sample.replace(/^\[/, '').replace(/,[^,]*$/, '') + ']') as number[]).filter((_, i) => i % 3 === 2);
    expect(Math.max(...pr) - Math.min(...pr)).toBeGreaterThan(0.1); // 필압이 변한다
    expect(r.afterSide).toBe(0);
    expect(r.afterFinger).toBe(1);
    expect(JSON.parse(r.vp1).view.y).toBeLessThan(JSON.parse(r.vp0).view.y - 50);
    expect(r.afterPinch).toBe(1);
    expect(r.zoom).not.toContain('100%');
  });
  test('20쪽 PDF 10초 안, 쪽 이동 50ms 안, 긴 글 쪽 정상', () => {
    const r = JSON.parse(execFileSync('node', ['scripts/perf.mjs'], { encoding: 'utf8' }).trim().split('\n').pop()!);
    expect(r.errs).toEqual([]);
    expect(r.pages).toBe(21);
    expect(r.importMs).toBeLessThan(10000);
    expect(r.navMs).toBeLessThan(50);
    expect(r.firstBoxH[0]).toBeGreaterThan(5000);
  });
});

test.describe('v4: 펜 종류·선택·글상자·KWD 폴더', () => {
  test('펜 종류·끌어 고른 색·형광 진하기·선택 도구·글상자·웹 학습지 창·사진 비율·학습지 위 확대', () => {
    const r = JSON.parse(execFileSync('node', ['scripts/v4-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v4t' } }));
    expect(r.errs).toEqual([]);
    expect(r.penPref.kind).toBe('ball');
    expect(r.penPref.color).not.toBe('#222222');
    expect(r.stroke1).toEqual({ k: 'ball', color: r.penPref.color });
    expect(r.stroke2).toEqual({ hl: true, o: 0.6, color: '#c39bff' });
    expect(r.selected).toBe(2);
    expect(r.moved).toEqual([50, 60]);
    expect(r.afterDelete).toBe(0);
    expect(r.afterUndo).toBe(2);
    expect(r.boxes).toHaveLength(1);
    expect(r.boxes[0].text).toBe('여기 상자 글');
    expect(r.boxesAfterEmpty).toBe(1);
    expect(r.htmlBesideNote).toBe(true);
    expect(r.htmlMove).toEqual([-60, 40]);
    expect(r.htmlSize[0]).toBeLessThan(-60);
    expect(r.quiz).toBe('정답!');
    expect(r.zoomOverHtml[1]).toBeGreaterThan(r.zoomOverHtml[0] * 1.2);
    expect(r.iframeCursor).toContain('url(');
    expect(r.img.ratio).toBe(3);
    expect(r.md).toContain('[글상자');
    expect(r.md).toContain('여기 상자 글');
  });
  test('KWD 폴더: 오늘 수업 → 학생 → 이 학생 패널 6칸, 자료를 판에, 체험 학생, 학생 기기에는 없음', () => {
    const r = JSON.parse(execFileSync('node', ['scripts/folder-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/foldert' } }));
    expect(r.errs).toEqual([]);
    expect(r.noFolderCard).toBe('KWD 폴더 연결하기');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1]).toContain('시작');
    expect(r.url).toMatch(/^\/b\/k[a-z0-9]{8}d\d{6}\?r=t$/);
    expect(r.chip).toBe('Mina K');
    expect(r.tabs).toEqual(['오늘', '수업안·자료', '과제', '학생 정보', '지난 수업', '단어']);
    expect(r.today).toContain('주말에 부산에 갔어요');
    expect(r.boardText).toContain('송편');
    expect(r.plan).toContain('맛 형용사');
    expect(r.htmlObj).toBe('#3_수업페이지');
    expect(r.lessonDoc).toContain('수업 2');
    expect(r.vocab.length).toBeGreaterThanOrEqual(5);
    expect(r.header).toBe(''); // 노트에 머리말 없음 (대화 재료가 대신)
    expect(r.hints).toBeGreaterThan(0);
    expect(r.trialTabs).toContain('오늘');
    expect(r.trialToday).toContain('여행 한국어');
    expect(r.studentMemBtn).toBe(true);
  });
});

test.describe('v5: 체험 화면·지우개 부분·자료 종류·숙제·요약', () => {
  test.describe.configure({ timeout: 240_000 });
  test('체험: 고르기 → 오늘 수업 → 무한 판(노트·수업 페이지·사진·유튜브·듣기·학생 과제) → 이 학생 6칸·과제·단어/문형 DB·요약', () => {
    const r = JSON.parse(execFileSync('node', ['scripts/demo-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/demot' } }).replace(/^[^{]*/, ''));
    expect(r.errs).toEqual([]);
    expect(r.cards).toEqual(['선생님 (노트북)', '학생 · 폰', '학생 · 태블릿', '선생님 · 태블릿', '나란히 보기']);
    expect(r.home[0]).toContain('Mina K.');
    expect(r.badge).toContain('체험 중');
    expect(r.pages).toBe(1); // 무한 판 하나
    for (const t of ['html', 'img', 'youtube', 'video', 'audio', 'box']) expect(r.objs).toContain(t);
    expect(r.rail).not.toContain('노트'); // 수업안 노트 없음 (10/18): 빈 노트는 접혀 있고 목록에도 없다
    expect(r.rail[0]).toBe('웹 학습지 · #12 수업 페이지');
    expect(r.firstText.trim()).toBe('');
    expect(r.tabs).toEqual(['오늘', '수업안·자료', '과제', '학생 정보', '지난 수업', '단어']);
    expect(r.tab_plan).toContain('영상');
    expect(r.tab_hw).toContain('지난 수업');
    expect(r.tab_hw).toContain('수업에서 짚을 것');
    expect(r.tab_today).toContain('오늘 50분');
    expect(r.summary).toContain('웹 학습지');
    expect(r.tab_vocab).toContain('단어 232'); // 수업 18 + 카드로만 214
    expect(r.rel).toContain('같은 묶음');
    expect(r.grammarRows).toBe(4);
  });
  test('체험 기기 화면: 나란히·폰·태블릿 — 선생님 글이 학생 창에, 유튜브 크게는 둘 다 → 선생님이 닫으면 학생도, 권한 토글은 메뉴가 안 닫힘', () => {
    const out = execFileSync('node', ['scripts/demo-views.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/demot' } });
    const r = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1));
    expect(r.errs).toEqual([]);
    expect(r.sPages).toBe(r.tPages);
    expect(r.sSees).toBe(true);
    expect([r.tPopup, r.sPopup, r.sPopupAfter]).toEqual([1, 1, 0]);
    expect(r.menuStillOpen).toBe(1);
    expect(r.toggleFlip[0]).not.toBe(r.toggleFlip[1]);
  });
  test('지우개 닿은 부분만 · 문서/소리 가져오기 · 막힌 고르기 창 안내 · KWD 숙제(가짜 서버) · 수업 요약', () => {
    const out = execFileSync('node', ['scripts/v5-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v5t' } });
    const r = JSON.parse(out.slice(out.indexOf('{\n')));
    expect(r.errs).toEqual([]);
    expect(r.blocked).toContain('크롬이나 엣지');
    expect(r.strokes0).toBe(2);
    expect(r.strokesPart).toHaveLength(3); // 위 획이 둘로
    expect(r.strokesAfterWhole).toBe(2);
    expect(r.afterUndo).toBe(3);
    expect(r.mdPage).toContain('<h1');
    expect(r.mdPage).toContain('<strong>보름달</strong>');
    expect(r.audioDur).toBeGreaterThan(5);
    expect(r.summary).toContain('교정');
    expect(r.summary).toContain('사건 기록');
    expect(r.hwSum).toContain('지난 수업(10/12) 뒤');
    expect(r.hwGroups[0]).toContain('추석에 송편을 만들었어요');
    expect(r.hwGroups[0]).toContain('선생님: 글씨가 예뻐요');
    expect(r.hwPlaced).toEqual(['box', 'img']);
    expect(r.hwCalls.slice(0, 5)).toEqual(['teacher.board:key', 'teacher.history:key', 'teacher.student:key', 'teacher.day:key', 'media.get:key']);
    expect(r.keyInDoc).toBe(false);
  });
});

test.describe('v6: 무한 판 · 같은 좌표 · 여기 보세요 · 학습지 단계별 필기 · 과제 탭', () => {
  test.describe.configure({ timeout: 240_000 });
  test('선생님·학생(폰) 같은 판 좌표 · 여기 보세요 · 학습지 고르기가 함께 · 단계마다 필기·글상자 · 필기 넣은 학습지 파일 · 기록 묶음 · 과제 탭 · 시간 나누기', () => {
    const out = execFileSync('node', ['scripts/v6-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v6t' } });
    const r = JSON.parse(out.slice(out.indexOf('{\n')));
    expect(r.errs).toEqual([]);
    expect(r.pages).toBe(1);
    expect(r.geoS).toEqual(r.geoT); // 사진·학습지·노트·제목이 두 기기에서 같은 판 좌표·크기
    expect(r.geoT.font).toContain('Pretendard');
    expect(r.studentSeesWs).toBe(true);
    expect(r.flash).toBe(1);
    expect(r.studentPick).toBe(true);
    expect([r.ink1, r.box1]).toEqual([1, 1]);
    expect([r.stepT, r.stepS]).toEqual([2, '2 / 7']);
    expect(r.boxesVisibleStep2).toBe(0);
    expect([r.ink2, r.studentInk2]).toEqual([1, 1]);
    expect([r.backStep, r.boxesVisibleStep1]).toEqual([1, 1]);
    // (headless 크롬은 한글 파일 이름을 download 로 바꿔 줌 — 실제 크롬에서는 이름 그대로, PC 에서 확인)
    expect(r.annotated.name).toMatch(/수업필기_\d{4}-\d{2}-\d{2}\.html$|^download$/);
    expect(r.annotated.steps).toEqual(['1', '2']);
    expect(r.annotated.hasState).toBe(true);
    expect([r.viewStep1Paths, r.viewStep2Paths]).toEqual([1, 1]);
    expect(r.bundle.ws).toHaveLength(1);
    expect(r.bundle.md.join(' ')).toContain('글상자: 1단계 메모');
    expect(r.hwSum).toContain('6일 중 5일 함');
    expect(r.hwDays).toBe(6);
    expect(r.hwPoints).toBe(4);
    expect(r.hwThumbs).toBeGreaterThanOrEqual(3);
    expect(r.plan).toHaveLength(4);
    expect(r.timer).toBe(true);
  });
});

test.describe('v7: 수업 묶음 · 배분 고치기 · 대화 재료 · 로드맵 · 도구 바꿔도 화면 그대로 · 나란히 따라오기', () => {
  test.describe.configure({ timeout: 240_000 });
  test('묶음(lesson_packet/v1)을 읽어 보여 주고, 판 문서에는 넣지 않는다', () => {
    const out = execFileSync('node', ['scripts/v7-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v7t' } });
    const r = JSON.parse(out.slice(out.indexOf('{\n')));
    expect(r.errs).toEqual([]);
    expect(r.splitStudentSeesWs).toBe(true);
    expect(r.splitFlash).toBe(0);
    expect(r.demoCardsEmoji).toBe(false);
    expect(r.lessonEmoji).toBe(false);
    expect(r.lessonIll).toBeGreaterThanOrEqual(15);
    expect(r.homeSplit).toBe('대화 5 · 과제 피드백 10 · 본 수업 30 · 마무리 5');
    expect(r.toolJump).toBe(0);
    expect(r.why).toContain('추석에 한 일');
    expect(r.plan).toEqual(['대화 5분', '과제 피드백 10분', '본 수업 30분', '마무리 5분']);
    expect(r.noteInsertButtons).toBe(0);
    expect(r.planEdited).toEqual(['대화 7분', '과제 피드백 10분', '본 수업 27분', '마무리 5분']);
    expect(r.timer).toMatch(/^대화 [67]:\d\d$/);
    expect(r.kitWords).toBe(10);
    expect(r.kitExamples).toBe(7);
    expect(r.kitPlaced).toEqual(['box:대화 재료']);
    expect(r.look).toBe(true);
    expect(r.rm.steps).toEqual(['m1:done', 'm2:done', 'm3:done', 'm4:now', 'm5:next', 'm6:later']);
    expect(r.rm.pace).toBe('조금 빠름');
    expect(r.rm.todo).toBe(2);
    expect(r.packetInDoc).toEqual([]);
    expect(r.manifestPacket).toMatch(/^pk_demo_mina_\d{4}-\d{2}-\d{2}$/);
    expect(r.segEvents.at(-1)).toBe('segment:talk');
  });
});

test.describe('v7.1: 수업안 노트 없음 · 학생 정보 탭 · 단어 단계 거르기', () => {
  test.describe.configure({ timeout: 240_000 });
  test('노트 접힘 · 학생 카드·로드맵·지금 상태·자주 틀린 것·배운 문형·원본 문서 · 씨앗/새싹 단계와 작은 단계 · 수업/카드', () => {
    const out = execFileSync('node', ['scripts/v71-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v71t' } });
    const r = JSON.parse(out.slice(out.indexOf('{\n')));
    expect(r.errs).toEqual([]);
    expect([r.noteText, r.noteFolded, r.railNote]).toEqual(['', 1, 0]);
    expect(r.noteH).toBeLessThan(140);
    expect([r.noteTyped, r.noteOpen]).toEqual(['메모 한 줄', 0]); // 누르면 펼쳐져 바로 쓴다
    expect(r.st.facts[0]).toBe('씨앗 6');
    expect(r.st.roadmapSteps).toBe(6);
    expect(r.st.now).toEqual(['익숙해요', '흔들려요', '다음에']);
    expect(r.st.errRows).toBe(5);
    expect(r.st.errMore).toBe('1개 더 보기');
    expect(r.st.patRows).toBe(8);
    expect(r.st.docs).toEqual(['학생 프로필', '로드맵 문서', '학습 상태 문서']);
    expect(r.st.oldMdOpen).toBe(0); // 긴 문서를 탭에 펼치지 않는다
    expect(r.docView).toContain('Executive');
    expect(r.backOk).toBe(1);
    expect(r.v.chips.map((c: string) => c.split('\n')[0])).toEqual(['전체', '씨앗', '새싹', '잎새']);
    expect(r.v.saessak).toBe(54);
    expect(r.v.sub.map((c: string) => c.split('\n')[0])).toEqual(['1', '2', '3', '4']);
    expect(r.v.saessak2).toBe(16);
    expect(r.v.firstRow).toContain('새싹 2');
    expect([r.v.lesson, r.v.cards]).toEqual([18, 214]);
    expect(r.v.stageFirst).toContain('씨앗 1');
    expect(r.v.chipsSrs.map((c: string) => c.split('\n')[0])).toEqual(['익히는 중', '외움', '자꾸 잊음']);
    expect(r.v.lapsingRows).toBe(true);
    expect(r.v.lapsing).toBeGreaterThan(r.v.lapsingSaessak);
    expect(r.v.lapsingSaessak).toBeGreaterThan(0);
  });
});

test.describe('v8: 교실 (1:1 통화 · 녹화)', () => {
  test.describe.configure({ timeout: 240_000 });
  test('선생님 카메라 → 학생 입장 → 서로 영상·소리 → 얼굴 크게(학생도) → 수업 시작(판만 녹화) → 끝내기 → 파일 4개 + 기록', () => {
    const out = execFileSync('node', ['scripts/v8-smoke.mjs'], { encoding: 'utf8', env: { ...process.env, OUT: 'test-results/v8t' } });
    const r = JSON.parse(out.slice(out.indexOf('{\n')));
    expect(r.errs).toEqual([]);
    expect([r.joinBefore, r.dockBefore]).toEqual([1, 'off']); // 학생은 바로 입장 화면, 선생님 카메라는 아직
    expect(r.studentCamBtn).toBe('카메라 켜기'); // 판만 보다가도 켤 수 있다
    expect(r.teacherAuto).toBe(true); // 학생이 들어오면 선생님 카메라 저절로
    expect(r.fixedLink.id).toMatch(/^kabcd2345d\d{6}$/);
    expect(r.fixedLink.role).toContain('role-student');
    expect(r.fixedLink.hash).toBe('#/c/kabcd2345'); // 즐겨찾기 주소가 그대로 남는다
    expect(r.fixedLink.join).toBe(true);
    expect(r.joinText).toContain('녹화');
    expect(r.connected).toBe(true);
    expect(r.statusT).toContain('연결');
    expect(r.audioTracks).toBe(1);
    expect(r.peerMicOff).toBe(true);
    expect(r.bigBoth).toBe(2);
    expect(r.recLabel).toContain('녹화');
    expect(r.crop).toBe('element'); // 판만 (카메라 칸·패널 빠짐)
    expect(r.confirm).toContain('한 번 더');
    const names = r.files.map((f: { name: string }) => f.name);
    expect(names.filter((n: string) => /\.webm$/.test(n))).toHaveLength(3);
    expect(names.some((n: string) => /_Teacher\.webm$/.test(n))).toBe(true);
    expect(names.some((n: string) => /_Student\.webm$/.test(n))).toBe(true);
    expect(names.some((n: string) => /\.kwd\.zip$/.test(n))).toBe(true);
    for (const f of r.files) expect(f.bytes).toBeGreaterThan(400);
    expect(r.meta.faces).toEqual({ student: false, teacher: false });
    expect(r.meta.crop).toBe('element');
    expect(r.events).toContain('lesson:start');
    expect(r.events).toContain('lesson:end');
    expect(r.events).toContain('call:connected');
    expect(r.afterLeave).toBe('wait');
  });
});
