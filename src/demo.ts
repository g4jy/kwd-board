// 체험 화면: 지어낸 학생(Mina K)과 가짜 KWD 폴더로 모든 기능을 눌러 본다.
// 선생님 / 학생 폰 / 학생 태블릿 / 선생님 태블릿 / 나란히 보기 — 기기 틀 안의 창들은 같은 브라우저라 바로 같이 움직인다.
import { h, toast } from './ui';
import { setDemo, useDemoFolder, boardIdFor, rememberBoardFolder, demoRun, nextDemoRun } from './kwdfolder';
import { loadIndex, saveIndex } from './store';

export const DEMO_FOLDER = 'Mina K (9000001)';

export type DemoView = 'phone' | 'tablet' | 'pen' | 'split';
const DEVICES: Record<string, { w: number; h: number; label: string }> = {
  phone: { w: 390, h: 844, label: '학생 폰' },
  tablet: { w: 820, h: 1180, label: '학생 태블릿' },
  pen: { w: 1180, h: 820, label: '선생님 태블릿 (펜)' },
  laptop: { w: 1366, h: 860, label: '선생님 노트북' },
};

export async function enterDemo(): Promise<string> {
  setDemo(true);
  await useDemoFolder();
  const bid = boardIdFor(DEMO_FOLDER);
  rememberBoardFolder(bid, DEMO_FOLDER);
  return bid;
}

export class DemoScreen {
  readonly root: HTMLElement;
  private alive = true;
  private onResize = () => this.fit();

  constructor(view?: DemoView) {
    this.root = h('div', { class: 'demo' + (view ? ' demo-view' : '') });
    if (view) void this.renderView(view);
    else this.renderPick();
    window.addEventListener('resize', this.onResize);
  }

  private renderPick() {
    const bid = boardIdFor(DEMO_FOLDER);
    void bid;
    this.root.append(
      h('div', { class: 'demo-head' }, h('h1', {}, 'KWD 수업 판 · 체험'), h('a', { class: 'linkish', href: '#/' }, '← 시작 화면')),
      h('p', { class: 'demo-lead' }, '지어낸 학생 Mina K 의 오늘 수업(#12 추석)으로 모든 기능을 눌러 보세요. 슬라이드·PDF·사진·웹 학습지·마크다운·소리·영상·유튜브·학생 과제가 페이지마다 깔려 있어요. 진짜 KWD 폴더와 판은 건드리지 않아요.'),
    );
    const grid = h('div', { class: 'demo-grid' });
    const card = (icon: string, title: string, desc: string, go: () => void, cls = '') => {
      const b = h('button', { type: 'button', class: 'demo-card ' + cls }, h('span', { class: 'dc-icon' }, icon), h('span', { class: 'dc-title' }, title), h('span', { class: 'dc-desc' }, desc));
      b.addEventListener('click', go);
      grid.append(b);
    };
    card('🧑‍🏫', '선생님 (노트북)', 'KWD 폴더가 연결된 모습. 오늘 수업 → 학생 → 판, 이 학생 패널까지', async () => {
      await enterDemo();
      location.hash = '#/';
    }, 'main');
    card('📱', '학생 · 폰', '학생이 폰으로 볼 때. 옆 작은 선생님 화면에서 쓰면 바로 보여요', () => (location.hash = '#/demo/phone'));
    card('📲', '학생 · 태블릿', '학생이 태블릿으로 볼 때 (펜으로 쓰기 허락하면 같이 써요)', () => (location.hash = '#/demo/tablet'));
    card('✍️', '선생님 · 태블릿', '선생님이 태블릿+펜으로 수업할 때 (손가락=이동, 펜=쓰기)', () => (location.hash = '#/demo/pen'));
    card('🖥️📱', '나란히 보기', '선생님 화면과 학생 폰을 한 화면에', () => (location.hash = '#/demo/split'));
    this.root.append(grid);
    const foot = h('div', { class: 'demo-foot' });
    const reset = h('button', { type: 'button', class: 'linkish' }, '체험 판 처음부터 다시');
    reset.addEventListener('click', () => {
      const old = `demo${demoRun()}`;
      saveIndex(loadIndex().filter((b) => !b.id.startsWith(old)));
      try {
        indexedDB.deleteDatabase('kwd-board-' + boardIdFor(DEMO_FOLDER));
      } catch {
        /* ignore */
      }
      nextDemoRun();
      toast('새 체험 판을 준비했어요');
    });
    const quit = h('button', { type: 'button', class: 'linkish' }, '체험 끝내기');
    quit.addEventListener('click', () => {
      setDemo(false);
      location.hash = '#/';
    });
    foot.append(reset, quit, h('span', { class: 'home-note' }, '파일 고르기·폴더 고르기 창은 Claude 앱 안 브라우저에서는 열리지 않아요. 크롬·엣지에서는 돼요.'));
    this.root.append(foot);
  }

  private frames: Array<{ wrap: HTMLElement; frame: HTMLIFrameElement; dev: { w: number; h: number } }> = [];

  private async renderView(view: DemoView) {
    const bid = await enterDemo();
    if (!this.alive) return;
    const bar = h('div', { class: 'demo-bar' }, h('a', { class: 'linkish', href: '#/demo' }, '← 체험 고르기'));
    const tabs = h('div', { class: 'demo-tabs' });
    for (const [v, l] of [['phone', '학생 폰'], ['tablet', '학생 태블릿'], ['pen', '선생님 태블릿'], ['split', '나란히']] as const) {
      const a = h('a', { class: 'demo-tab' + (v === view ? ' on' : ''), href: `#/demo/${v}` }, l);
      tabs.append(a);
    }
    bar.append(tabs);
    const stage = h('div', { class: 'demo-stage demo-' + view });
    this.root.append(bar, stage);
    const teacherUrl = `#/b/${bid}?r=t`;
    const studentUrl = `#/b/${bid}?r=s`;
    const add = (devKey: string, url: string, role: string, big: boolean) => {
      const dev = DEVICES[devKey];
      const wrap = h('div', { class: 'dev-wrap' + (big ? ' big' : ' small') + ' dev-' + devKey });
      const frame = h('iframe', { class: 'dev-frame', title: dev.label, src: './' + url, width: String(dev.w), height: String(dev.h), allow: 'autoplay; clipboard-write; microphone; camera; fullscreen' }) as HTMLIFrameElement;
      const box = h('div', { class: 'dev-box' }, frame);
      wrap.append(h('div', { class: 'dev-label' }, dev.label + (role ? ' · ' + role : '')), box);
      stage.append(wrap);
      this.frames.push({ wrap, frame, dev });
    };
    // 선생님 창을 먼저 (판을 깔고, 학생 창은 같은 판을 받는다)
    if (view === 'split') {
      add('laptop', teacherUrl, '여기서 써 보세요', true);
      add('phone', studentUrl, '바로 따라와요', true);
    } else if (view === 'pen') {
      add('pen', teacherUrl, '펜·손가락', true);
      add('phone', studentUrl, '학생', false);
    } else {
      add(view, studentUrl, '학생이 보는 화면', true);
      add('laptop', teacherUrl, '여기서 써 보면 학생 화면에 바로', false);
    }
    // 학생 창이 선생님보다 먼저 열리면 빈 판을 받으니, 선생님 창이 판을 깐 뒤 학생 창을 다시 연다
    const [first, second] = this.frames;
    const teacher = first.frame.src.includes('r=t') ? first : second;
    const student = teacher === first ? second : first;
    student.frame.src = 'about:blank';
    const t0 = Date.now();
    const wait = window.setInterval(() => {
      const w = teacher.frame.contentWindow as (Window & { __kwd?: { pages(): unknown[]; store: { meta: { get(k: string): unknown } } } }) | null;
      const done = !!w?.__kwd?.store?.meta?.get('demoReady');
      if (done || Date.now() - t0 > 20000 || !this.alive) {
        window.clearInterval(wait);
        if (this.alive) student.frame.src = './' + studentUrl;
      }
    }, 400);
    window.setTimeout(() => this.fit(), 0);
  }

  private fit() {
    const n = this.frames.length;
    if (!n) return;
    const stage = this.root.querySelector('.demo-stage') as HTMLElement | null;
    if (!stage) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const narrow = W < 760;
    // 큰 것은 남은 자리의 대부분, 작은 것은 오른쪽(좁으면 아래) 작게
    const bigs = this.frames.filter((f) => f.wrap.classList.contains('big'));
    const smalls = this.frames.filter((f) => !f.wrap.classList.contains('big'));
    const gap = 16;
    const labelH = 24;
    const smallShare = smalls.length ? (narrow ? 0 : 0.3) : 0;
    const totalBigW = bigs.reduce((a, f) => a + f.dev.w, 0);
    const availW = W * (1 - smallShare) - gap * (bigs.length + 1);
    const sBig = Math.min(1, availW / totalBigW, (H - labelH - gap * 3) / Math.max(...bigs.map((f) => f.dev.h)));
    for (const f of bigs) this.scale(f, narrow && smalls.length ? Math.min(sBig, (W - gap * 2) / f.dev.w) : sBig);
    for (const f of smalls) {
      const s = narrow ? Math.min((W - gap * 2) / f.dev.w, 0.5) : Math.min((W * smallShare - gap) / f.dev.w, (H - labelH - gap) / f.dev.h);
      this.scale(f, s);
    }
  }

  private scale(f: { wrap: HTMLElement; frame: HTMLIFrameElement; dev: { w: number; h: number } }, s: number) {
    const box = f.wrap.querySelector('.dev-box') as HTMLElement;
    box.style.width = Math.round(f.dev.w * s) + 'px';
    box.style.height = Math.round(f.dev.h * s) + 'px';
    f.frame.style.transform = `scale(${s})`;
  }

  destroy() {
    this.alive = false;
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}
