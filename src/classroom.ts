// 교실 (v8): 판 위에 카메라 칸 · 학생 입장 화면 · 수업 시작/끝내기(녹화) · 보기 모드
// 통화는 call.ts(P2P), 녹화는 lessonrec.ts. 판 문서에는 영상·소리·시그널이 들어가지 않는다(카메라 보기 모드 설정만).
import { icon } from './icons';
import { h, toast, downloadBlob } from './ui';
import { Call, fakeMedia, DEFAULT_ICE } from './call';
import { LessonRecorder, type OpenWriter } from './lessonrec';
import { httpBase, type BoardStore, type Role } from './store';

export interface ClassroomHost {
  root: HTMLElement;
  stage: HTMLElement;
  store: BoardStore;
  role: Role;
  demo: boolean;
  serverUrl: () => string;
  lessonDir: (stem: string) => Promise<{ path: string; open: OpenWriter } | null>; // 수업마다 새 폴더 (KWD 폴더가 없으면 null → 내려받기)
  stem: () => string; // 녹화 파일 이름 앞부분
  saveBundle: (open: OpenWriter | null) => Promise<boolean>; // 판 기록(.kwd.zip)을 같은 수업 폴더에
  meta: () => Record<string, unknown>;
  onLessonStarted?: () => void; // 수업 시작 직후 (검증 탭 열기)
}

type CamView = 'board' | 'cams';
// 카메라 칸 배치 (기기마다 따로 저장, 상대 화면은 안 바뀜): 겹쳐(내 화면 작게) · 위아래 · 나란히 · 나 숨기기
type CamMode = 'pip' | 'stack' | 'side' | 'solo';
interface CamLayout {
  mode: CamMode;
  w: number; // 0 = 기본 폭
  x?: number;
  y?: number;
}
const MODES: Array<[CamMode, string]> = [
  ['pip', '겹쳐 보기'],
  ['stack', '위아래'],
  ['side', '나란히'],
  ['solo', '내 화면 숨기기'],
];
async function camAllowed(): Promise<boolean> {
  try {
    const q = (n: string) => navigator.permissions.query({ name: n as PermissionName });
    const [c, m] = await Promise.all([q('camera'), q('microphone')]);
    return c.state === 'granted' && m.state === 'granted';
  } catch {
    return false;
  }
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class Classroom {
  readonly call: Call | null = null;
  readonly dock: HTMLElement;
  readonly lessonBtn: HTMLButtonElement | null = null;
  readonly micBtn: HTMLButtonElement | null = null; // 카메라 없이 마이크만 켜고 녹화
  private rec = new LessonRecorder();
  private remoteV: HTMLVideoElement;
  private localV: HTMLVideoElement;
  private status: HTMLElement;
  private ctrl: HTMLElement;
  private join: HTMLElement | null = null;
  private timer = 0;
  private confirmEnd = 0;
  private offs: Array<() => void> = [];
  private recOpen: OpenWriter | null = null;
  private recPath = '';
  private tiles!: HTMLElement;
  private grip!: HTMLElement;
  private layKey = '';
  private lay: CamLayout = { mode: 'pip', w: 0 };
  private layOpen = false;
  private extra!: HTMLElement;
  private ctrlTimer = 0;

  constructor(private host: ClassroomHost) {
    const { role } = host;
    this.dock = h('div', { class: 'cam-dock', 'data-state': 'off' });
    this.remoteV = h('video', { class: 'cam-remote', autoplay: '', playsinline: '' }) as HTMLVideoElement;
    this.localV = h('video', { class: 'cam-local', autoplay: '', playsinline: '' }) as HTMLVideoElement;
    this.localV.muted = true;
    this.status = h('div', { class: 'cam-status' });
    this.ctrl = h('div', { class: 'cam-ctrl' });
    this.extra = h('div', { class: 'cam-extra' });
    const remoteBox = h('div', { class: 'cam-tile remote' }, this.remoteV, h('span', { class: 'cam-name' }, role === 'teacher' ? '학생' : '선생님'), h('span', { class: 'cam-wait' }, role === 'teacher' ? '학생을 기다리는 중' : '선생님을 기다리는 중'));
    const localBox = h('div', { class: 'cam-tile local' }, this.localV, h('span', { class: 'cam-name' }, '나'));
    this.grip = h('span', { class: 'cam-grip', title: '끌어서 크기 바꾸기' });
    this.tiles = h('div', { class: 'cam-tiles', title: '끌어서 옮기기' }, remoteBox, localBox, this.grip);
    this.dock.append(this.tiles, this.status, this.ctrl, this.extra);
    this.layKey = 'kwd.camLayout.' + role;
    this.lay = this.loadLayout();
    this.bindLayout();
    if (role === 'assist') {
      this.dock.hidden = true;
      return;
    }
    this.call = new Call(host.store.awareness, role);
    this.call.log = (kind, data) => host.store.log({ kind: 'call', data: { ...data, k: kind } });
    this.offs.push(this.call.on(() => this.render()));
    host.root.append(this.dock);
    if (role === 'teacher') {
      this.lessonBtn = h('button', { type: 'button', class: 'lesson-btn' }, '수업 시작') as HTMLButtonElement;
      this.lessonBtn.addEventListener('click', () => void this.toggleLesson());
      this.micBtn = h('button', { type: 'button', class: 'mic-rec', title: '카메라는 켜지 않고 마이크만 켜서 수업을 녹화해요' }, '마이크만 녹화') as HTMLButtonElement;
      this.micBtn.addEventListener('click', () => void this.micOnlyLesson());
      this.rec.onEnded = () => void this.endLesson(); // 크롬의 '공유 중지'
      this.rec.onMedia = (op, sp) => host.store.log({ kind: 'media', data: { op, kind: sp.kind, name: sp.name, ref: sp.ref, at_s: op === 'play' ? sp.from_s : sp.to_s } });
    }
    const setObs = () => this.applyView();
    host.store.settings.observe(setObs);
    this.offs.push(() => host.store.settings.unobserve(setObs));
    this.timer = window.setInterval(() => this.renderLesson(), 1000);
    void this.loadIce();
    if (host.demo) void this.start(fakeMedia(role === 'teacher' ? '선생님' : '학생', role === 'teacher' ? '#f3d98b' : '#9cc5b0'));
    else if (role === 'student') {
      // v8.1: 링크로 들어오면 바로 입장 화면 (선생님보다 먼저 와도 된다). '판만 볼게요'면 카메라 칸의 '카메라 켜기'로 나중에
      this.showJoin();
    } else if (role === 'teacher') {
      // 학생이 카메라를 켜고 들어오면 선생님 카메라도 저절로 (이 PC에서 한 번 허용해 둔 뒤부터)
      const aw = host.store.awareness;
      let asked = false;
      const check = () => {
        if (this.call?.local || asked) return;
        const studentOn = Array.from(aw.getStates().values()).some((s) => (s as { role?: string }).role === 'student' && (s as { media?: { on?: boolean } }).media?.on);
        if (!studentOn) return;
        asked = true;
        void camAllowed().then(async (ok) => {
          if (this.call?.local) return;
          const st = ok ? await this.getMedia(true) : null;
          if (st) {
            await this.start(st);
            toast('학생이 들어와서 카메라를 켰어요');
          } else {
            toast('학생이 들어왔어요 · 오른쪽 위 카메라 켜기를 눌러 주세요', 6000);
            this.dock.classList.add('nudge');
          }
        });
      };
      aw.on('change', check);
      this.offs.push(() => aw.off('change', check));
      check();
    }
    this.render();
    this.applyView();
  }

  // TURN 열쇠: 서버(워커)가 1시간짜리를 준다. 없으면 STUN 만
  private async loadIce() {
    const srv = this.host.serverUrl();
    if (!srv || !this.call) return;
    try {
      const r = await fetch(httpBase(srv) + '/turn?room=' + encodeURIComponent(this.host.store.id), { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { iceServers?: RTCIceServer[] | RTCIceServer };
      const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
      if (list.length) this.call.setIceServers([...DEFAULT_ICE, ...list]);
    } catch {
      /* 서버에 /turn 이 없으면 STUN 만 */
    }
  }

  private async getMedia(video: boolean): Promise<MediaStream | null> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return null;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      return await md.getUserMedia({ audio, video: video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } : false });
    } catch {
      try {
        return await md.getUserMedia({ audio }); // 카메라만 안 될 때
      } catch {
        return null;
      }
    }
  }

  async start(stream: MediaStream | null) {
    if (!this.call) return;
    this.dock.classList.remove('nudge');
    this.localV.srcObject = stream;
    await this.call.start(stream);
    this.host.store.log({ kind: 'call', data: { op: 'join', cam: !!stream?.getVideoTracks().length, mic: !!stream?.getAudioTracks().length } });
    this.render();
  }

  // ---- 학생 입장 화면: 내 카메라 미리보기 + 마이크 막대 + 들어가기 ----
  private showJoin() {
    const pv = h('video', { class: 'join-preview', autoplay: '', playsinline: '' }) as HTMLVideoElement;
    pv.muted = true;
    const meter = h('div', { class: 'join-meter' }, h('i', {}));
    const go = h('button', { type: 'button', class: 'join-go' }, '들어가기') as HTMLButtonElement;
    const noCam = h('button', { type: 'button', class: 'linkish join-nocam' }, '카메라 없이 들어가기');
    const msg = h('p', { class: 'join-msg' }, '카메라와 마이크를 켜는 중…');
    const boardOnly = h('button', { type: 'button', class: 'linkish join-board' }, '판만 볼게요');
    const card = h('div', { class: 'join-card' }, h('h2', {}, '한국어 수업'), h('div', { class: 'join-pv' }, pv), meter, msg, go, noCam, boardOnly, h('p', { class: 'join-note' }, '이 수업은 복습 자료를 위해 녹화돼요. 녹화에는 판과 목소리만 들어가고 내 얼굴은 들어가지 않아요. 들어가기를 누르면 동의한 것으로 봐요.'));
    this.join = h('div', { class: 'join' }, card);
    this.host.root.append(this.join);
    let stream: MediaStream | null = null;
    let raf = 0;
    void this.getMedia(true).then((s) => {
      stream = s;
      if (!s) {
        msg.textContent = '카메라·마이크를 쓸 수 없어요. 브라우저 주소창의 자물쇠에서 허용하거나, 카메라 없이 들어가세요.';
        return;
      }
      pv.srcObject = s;
      msg.textContent = s.getVideoTracks().length ? '좋아요. 들어가기를 누르세요.' : '카메라가 없어요. 목소리로만 들어가요.';
      try {
        const ac = new AudioContext();
        const an = ac.createAnalyser();
        ac.createMediaStreamSource(s).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const bar = meter.firstElementChild as HTMLElement;
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          bar.style.width = Math.min(100, peak * 1.6) + '%';
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        /* 막대 없음 */
      }
    });
    const enter = (s: MediaStream | null) => {
      cancelAnimationFrame(raf);
      this.join?.remove();
      this.join = null;
      void this.start(s);
    };
    go.addEventListener('click', () => enter(stream));
    boardOnly.addEventListener('click', () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      this.join?.remove();
      this.join = null;
      this.render();
    });
    noCam.addEventListener('click', () => {
      stream?.getVideoTracks().forEach((t) => {
        t.stop();
        stream!.removeTrack(t);
      });
      enter(stream);
    });
  }

  // ---- 카메라 칸 ----
  private render() {
    const c = this.call;
    if (!c) return;
    const on = !!c.local || this.host.demo;
    const remote = c.remote();
    if (this.remoteV.srcObject !== remote) this.remoteV.srcObject = remote;
    const live = c.connected() && !!remote?.getTracks().length;
    const pm = c.peerMedia();
    this.dock.dataset.state = !on && !c.local ? 'off' : live ? 'live' : 'wait';
    this.dock.classList.toggle('peer-cam-off', !!pm?.camOff || (live && !remote?.getVideoTracks().length));
    this.dock.classList.toggle('my-cam-off', !c.camOn());
    this.dock.classList.toggle('my-mic-off', !!c.local && !c.micOn());
    // 상태 한 줄
    const st = c.stats();
    const q = { good: '연결 좋음', ok: '조금 느림', bad: '연결 나쁨', none: '' }[st.quality];
    this.status.textContent = !c.local && !on ? '' : live ? `${q}${st.rtt ? ` · ${st.rtt}ms` : ''}${st.relayed ? ' · 중계' : ''}${pm?.micOff ? ' · 상대 마이크 꺼짐' : ''}` : this.host.role === 'teacher' ? '학생이 링크로 들어오면 바로 연결돼요' : '선생님을 기다리는 중';
    this.status.dataset.q = live ? st.quality : 'none';
    // 잘 연결돼 있을 때는 상태 줄을 숨긴다 (판을 덜 가리게). 문제가 있을 때만 보인다
    this.status.classList.toggle('quiet', live && (st.quality === 'good' || st.quality === 'ok') && !pm?.micOff);
    // 단추: 통화 중에는 칸 안 아래쪽에 아이콘으로, 마우스를 올리거나(태블릿은 한 번 누르면) 보인다 (10/19)
    this.ctrl.innerHTML = '';
    this.extra.innerHTML = '';
    const over = !!c.local;
    this.ctrl.classList.toggle('over', over);
    if (over && this.ctrl.parentElement !== this.tiles) this.tiles.append(this.ctrl);
    if (!over && this.ctrl.parentElement !== this.dock) this.dock.insertBefore(this.ctrl, this.extra);
    const btn = (label: string, title: string, fn: () => void, cls = '', ic = '', into: HTMLElement = this.ctrl) => {
      const b = h('button', { type: 'button', class: 'cam-b ' + cls, title: title || label, 'aria-label': label }, ...(ic ? [icon(ic), h('span', { class: 'cam-lbl' }, label)] : [label]));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      into.append(b);
      return b;
    };
    if (!c.local) {
      if (this.host.role === 'teacher') btn('카메라 켜기', '카메라와 마이크를 켜고 학생을 기다려요', () => void this.getMedia(true).then((s) => (s ? this.start(s) : toast('카메라·마이크를 쓸 수 없어요. 주소창 자물쇠에서 허용해 주세요'))), 'primary');
      else if (!this.join) btn('카메라 켜기', '카메라·마이크 켜기', () => this.showJoin(), 'primary');
      return;
    }
    btn(c.micOn() ? '마이크 끄기' : '마이크 켜기', '', () => (c.setMic(!c.micOn()), this.render()), c.micOn() ? '' : 'off', c.micOn() ? 'mic' : 'micOff');
    btn(c.camOn() ? '카메라 끄기' : '카메라 켜기', '', () => (c.setCamera(!c.camOn()), this.render()), c.camOn() ? '' : 'off', c.camOn() ? 'cam' : 'camOff');
    if (this.host.role === 'teacher') {
      const big = this.view() === 'cams';
      btn(big ? '판 보기' : '얼굴 크게', big ? '판 보기 · 학생 화면도 같이 바뀌어요' : '얼굴 크게 · 학생 화면도 같이 바뀌어요', () => this.setView(big ? 'board' : 'cams'), big ? 'on' : '', 'face');
    }
    if (!this.dock.classList.contains('big')) btn('배치', '카메라 칸 모양·자리', () => ((this.layOpen = !this.layOpen), this.render()), 'lay-b' + (this.layOpen ? ' on' : ''), 'layout');
    if (this.layOpen && !this.dock.classList.contains('big')) this.extra.append(this.layoutMenu());
    const st2 = c.stats();
    if (st2.quality === 'bad' || ['failed', 'disconnected'].includes(st2.state)) btn('다시 연결', '연결이 나쁠 때', () => c.reconnect(), 'ghost', '', this.extra);
  }

  // ---- 카메라 칸 배치: 끌어서 옮기기 · 모서리로 크기 · 배치 고르기 (이 기기에만 저장) ----
  private loadLayout(): CamLayout {
    try {
      const j = JSON.parse(localStorage.getItem(this.layKey) || 'null') as CamLayout | null;
      if (j && MODES.some(([m]) => m === j.mode)) return { mode: j.mode, w: Number(j.w) || 0, x: j.x, y: j.y };
    } catch {
      /* 없음 */
    }
    return { mode: 'pip', w: 0 };
  }
  private saveLayout() {
    try {
      localStorage.setItem(this.layKey, JSON.stringify(this.lay));
    } catch {
      /* ignore */
    }
  }
  layout(): CamLayout {
    return { ...this.lay };
  }
  setLayout(p: Partial<CamLayout> | null) {
    this.lay = p === null ? { mode: 'pip', w: 0 } : { ...this.lay, ...p };
    this.saveLayout();
    this.applyLayout();
  }
  private applyLayout() {
    const d = this.dock;
    const { mode, w, x, y } = this.lay;
    d.dataset.layout = mode;
    if (w) d.style.setProperty('--cam-w', w + 'px');
    else d.style.removeProperty('--cam-w');
    const moved = x !== undefined && y !== undefined;
    d.classList.toggle('moved', moved);
    if (moved) {
      // 화면이 작아져도 칸이 밖으로 나가지 않게
      const r = d.getBoundingClientRect();
      const cx = Math.max(4, Math.min(x!, window.innerWidth - Math.max(80, r.width) - 4));
      const cy = Math.max(4, Math.min(y!, window.innerHeight - 60));
      d.style.left = cx + 'px';
      d.style.top = cy + 'px';
    } else {
      d.style.left = '';
      d.style.top = '';
    }
  }
  private bindLayout() {
    const d = this.dock;
    const drag = (e: PointerEvent, kind: 'move' | 'size') => {
      if (d.classList.contains('big') || e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = d.getBoundingClientRect();
      const tw = this.tiles.getBoundingClientRect().width;
      const sx = e.clientX, sy = e.clientY;
      let movedPx = 0;
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture?.(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        movedPx = Math.max(movedPx, Math.abs(dx) + Math.abs(dy));
        if (movedPx < 5) return;
        d.classList.add('dragging');
        if (kind === 'move') {
          this.lay = { ...this.lay, x: Math.round(r.left + dx), y: Math.round(r.top + dy) };
        } else {
          const per = this.lay.mode === 'side' ? 2 : 1;
          const nw = Math.round(Math.max(120, Math.min(window.innerWidth - 24, tw + dx)) / per);
          // 오른쪽에 붙어 있던 칸은 왼쪽 위 자리를 고정하고 키운다
          this.lay = { ...this.lay, w: Math.max(120, Math.min(720, nw)), x: Math.round(r.left), y: Math.round(r.top) };
        }
        this.applyLayout();
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        d.classList.remove('dragging');
        if (movedPx >= 5) {
          this.saveLayout();
          d.classList.add('was-dragged');
          window.setTimeout(() => d.classList.remove('was-dragged'), 0);
        }
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    };
    this.tiles.addEventListener('pointerdown', (e) => {
      if (e.target === this.grip || (e.target as HTMLElement).closest('.cam-ctrl')) return;
      drag(e, 'move');
    });
    // 태블릿: 칸을 한 번 누르면 단추가 4초 보인다 (마우스는 올리면 보인다)
    this.tiles.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.cam-ctrl') || d.classList.contains('was-dragged')) return;
      d.classList.add('ctrl-on');
      window.clearTimeout(this.ctrlTimer);
      this.ctrlTimer = window.setTimeout(() => d.classList.remove('ctrl-on'), 4000);
    });
    this.grip.addEventListener('pointerdown', (e) => drag(e, 'size'));
    const onResize = () => this.applyLayout();
    window.addEventListener('resize', onResize);
    this.offs.push(() => window.removeEventListener('resize', onResize));
    this.applyLayout();
  }
  private layoutMenu(): HTMLElement {
    const box = h('div', { class: 'cam-lay' });
    for (const [m, label] of MODES) {
      const b = h('button', { type: 'button', class: 'cam-b' + (this.lay.mode === m ? ' on' : ''), 'data-mode': m }, label);
      b.addEventListener('click', () => {
        this.setLayout({ mode: m });
        this.layOpen = false;
        this.render();
      });
      box.append(b);
    }
    const reset = h('button', { type: 'button', class: 'cam-b ghost' }, '처음대로');
    reset.addEventListener('click', () => {
      this.setLayout(null);
      this.layOpen = false;
      this.render();
    });
    box.append(reset, h('span', { class: 'cam-lay-note' }, '칸을 끌면 옮겨지고, 오른쪽 아래 모서리를 끌면 크기가 바뀌어요. 이 기기에만 저장돼요.'));
    return box;
  }

  // ---- 보기 모드: 판 + 작은 카메라 / 얼굴 크게 (선생님이 바꾸면 학생도) ----
  private view(): CamView {
    return this.host.store.getSetting<CamView>('camView', 'board');
  }
  private setView(v: CamView) {
    this.host.store.setSetting('camView', v);
    this.host.store.log({ kind: 'call', data: { op: 'view', view: v } });
  }
  private applyView() {
    const big = this.view() === 'cams';
    this.dock.classList.toggle('big', big);
    this.host.root.classList.toggle('cams-big', big);
    this.render();
  }

  // ---- 수업 시작 / 끝내기 (녹화) ----
  private async toggleLesson() {
    if (!this.rec.active) return this.startLesson();
    if (Date.now() - this.confirmEnd > 4000) {
      this.confirmEnd = Date.now();
      this.renderLesson();
      return;
    }
    await this.endLesson();
  }

  private async micOnlyLesson() {
    if (this.rec.active) return;
    if (!this.call?.local?.getAudioTracks().length) {
      const s = await this.getMedia(false);
      if (!s?.getAudioTracks().length) {
        toast('마이크를 쓸 수 없어요. 주소창 자물쇠에서 허용해 주세요');
        return;
      }
      await this.start(s);
    }
    await this.startLesson();
  }

  private async startLesson() {
    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: unknown };
    if (!md?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      toast('녹화는 컴퓨터의 크롬·엣지에서 돼요');
      return;
    }
    try {
      this.lessonBtn!.disabled = true;
      const stem = this.host.stem();
      const dir = await this.host.lessonDir(stem.replace(/_#\d+$/, ''));
      this.recOpen = dir?.open || null;
      this.recPath = dir?.path || '';
      await this.rec.start({ stage: this.host.stage, mine: this.call?.local || null, theirs: this.call?.remote() || null, stem, open: this.recOpen || (async () => null), now: this.host.store.now() });
      this.host.store.meta.set('recording', { startedAt: this.rec.startedAt, files: this.rec.files, crop: this.rec.cropped || 'none' });
      this.host.store.log({ kind: 'lesson', data: { op: 'start', rec: this.rec.files, crop: this.rec.cropped || 'none' } });
      toast(this.rec.cropped ? '수업을 시작했어요 · 판과 목소리를 녹화해요' : '수업을 시작했어요 · 녹화 중');
      this.host.onLessonStarted?.();
    } catch (e) {
      console.warn('rec', e);
      toast('녹화를 시작하지 못했어요. 크롬이 묻는 창에서 이 탭을 고르고 공유를 눌러 주세요', 5000);
    } finally {
      this.lessonBtn!.disabled = false;
      this.renderLesson();
    }
  }

  private ending = false;
  async endLesson() {
    if (!this.rec.active || this.ending) return; // '공유 중지'와 '끝내기'가 겹쳐도 한 번만
    this.ending = true;
    try {
      await this.endLessonOnce();
    } finally {
      this.ending = false;
    }
  }

  private async endLessonOnce() {
    this.confirmEnd = 0;
    const dur = Math.round((this.host.store.now() - this.rec.startedAt) / 1000);
    const open = this.recOpen;
    const { saved, blobs, empty } = await this.rec.stop({ board: this.host.store.id, ...this.host.meta(), call: this.call?.stats() }, open || (async () => null));
    this.host.store.log({ kind: 'lesson', data: { op: 'end', seconds: dur, saved: saved.length, empty: empty.length ? empty : undefined } });
    this.renderLesson();
    for (const b of blobs) downloadBlob(b.name, b.blob);
    // 판 기록도 같은 수업 폴더에 (묻는 창 없이)
    const bundled = await this.host.saveBundle(open);
    toast(saved.length ? `수업 폴더에 저장했어요 · ${this.recPath}${bundled ? ' (녹화 + 판 기록)' : ''}` : '녹화 파일을 내려받았어요', 6000);
    this.recOpen = null;
    if (empty.length && dur > 5) toast('주의: 녹화 파일이 비어 있어요 (' + empty.map((n) => n.replace(/^.*_/, '')).join(', ') + ') · 마이크 허용과 소리 줄을 확인해 주세요', 9000);
  }

  private renderLesson() {
    const b = this.lessonBtn;
    if (!b) return;
    if (this.micBtn) this.micBtn.hidden = this.rec.active || !!this.call?.local?.getAudioTracks().length;
    if (!this.rec.active) {
      b.textContent = '수업 시작';
      b.classList.remove('rec', 'confirm');
      return;
    }
    const s = (this.host.store.now() - this.rec.startedAt) / 1000;
    const confirm = Date.now() - this.confirmEnd < 4000;
    b.classList.add('rec');
    b.classList.toggle('confirm', confirm);
    b.textContent = confirm ? '정말 끝낼까요? 한 번 더' : `● 녹화 ${fmt(s)} · 끝내기`;
    if (!confirm && this.confirmEnd) this.confirmEnd = 0;
  }

  recording(): boolean {
    return this.rec.active;
  }

  destroy() {
    window.clearInterval(this.timer);
    if (this.rec.active) void this.endLesson();
    this.offs.forEach((f) => f());
    this.call?.stop();
    this.join?.remove();
    this.dock.remove();
  }
}
