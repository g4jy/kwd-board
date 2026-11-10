// 교실 (v8): 판 위에 카메라 칸 · 학생 입장 화면 · 수업 시작/끝내기(녹화) · 보기 모드
// 통화는 call.ts(P2P), 녹화는 lessonrec.ts. 판 문서에는 영상·소리·시그널이 들어가지 않는다(카메라 보기 모드 설정만).
import { icon } from './icons';
import { h, toast, downloadBlob } from './ui';
import JSZip from 'jszip';
import { listSessions, loadSession, dropSession, patchSession } from './recstore';
import { Call, fakeMedia, DEFAULT_ICE } from './call';
import { LessonRecorder, type OpenWriter, type MeterLevels, type RecFail } from './lessonrec';
import { gasReady } from './gas';
import { finishUpload, pumpUploads, releaseHold } from './recupload';
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
  saveBundle: (open: OpenWriter | null, sid?: string) => Promise<boolean>; // 판 기록(.kwd.zip)을 같은 수업 폴더에
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
  readonly savedBtn: HTMLButtonElement | null = null; // 지난 녹화 다시 받기
  readonly micBtn: HTMLButtonElement | null = null; // 카메라 없이 마이크만 켜고 녹화
  readonly meterEl: HTMLElement | null = null; // 녹화 중 소리 크기 막대 (선생님 · 학생)
  private warnEl: HTMLElement | null = null; // 무음 경고
  private failMsgs: string[] = []; // 수업 중 녹화 실패 (소리 경고와 함께 붉은 줄에, 수업이 끝날 때까지 남김)
  private failEl: HTMLElement | null = null; // 수업 끝 뒤 실패 알림 + 내려받기 단추
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
      this.savedBtn = h('button', { type: 'button', class: 'mic-rec', hidden: '', title: '브라우저에 남겨 둔 지난 수업 녹화를 zip 하나로 다시 받아요' }, '지난 녹화 다시 받기') as HTMLButtonElement;
      this.savedBtn.addEventListener('click', () => void this.redownload());
      this.savedBtn.dataset.none = '1';
      void this.hasSaved().then((v) => ((this.savedBtn!.dataset.none = v ? '' : '1'), (this.savedBtn!.hidden = !v)));
      this.meterEl = h('span', { class: 'rec-meter', hidden: '', title: '녹화 중 소리 크기: 왼쪽 선생님 · 오른쪽 학생' }, h('span', { class: 'rm-l', 'data-k': 'teacher' }, h('i', {}), h('b', {}, '나')), h('span', { class: 'rm-l', 'data-k': 'student' }, h('i', {}), h('b', {}, '학생')));
      this.rec.onLevels = (l) => this.showLevels(l);
      this.rec.onEnded = () => void this.endLesson(); // 크롬의 '공유 중지'
      this.rec.onFail = (k, tr) => this.recFailed(k, tr);
      // 녹화 중 탭 닫기·새로고침 → 브라우저가 한 번 묻는다 (T136x A07-F03). 조각은 이미 브라우저 저장소에 있다
      const unload = (e: BeforeUnloadEvent) => {
        if (!this.rec.active) return;
        e.preventDefault();
        e.returnValue = '';
      };
      window.addEventListener('beforeunload', unload);
      this.offs.push(() => window.removeEventListener('beforeunload', unload));
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
    const go = h('button', { type: 'button', class: 'join-go' }, '들어가기 · Join') as HTMLButtonElement;
    const noCam = h('button', { type: 'button', class: 'linkish join-nocam' }, '카메라 없이 들어가기 · Join without camera');
    const msg = h('p', { class: 'join-msg' }, '카메라와 마이크를 켜는 중…');
    const msgEn = h('p', { class: 'join-en' }, 'Turning on your camera and microphone…');
    const say = (ko: string, en: string) => {
      msg.textContent = ko;
      msgEn.textContent = en;
    };
    const boardOnly = h('button', { type: 'button', class: 'linkish join-board' }, '판만 볼게요 · Just the board');
    const card = h('div', { class: 'join-card' }, h('h2', {}, '한국어 수업'), h('p', { class: 'join-en join-title-en' }, 'Korean lesson'), h('div', { class: 'join-pv' }, pv), meter, msg, msgEn, go, noCam, boardOnly, h('p', { class: 'join-note' }, '이 수업은 복습 자료를 위해 녹화돼요. 녹화에는 판과 목소리만 들어가고 내 얼굴은 들어가지 않아요. 들어가기를 누르면 동의한 것으로 봐요.'), h('p', { class: 'join-en' }, 'This lesson is recorded for review. The recording has the board and voices only, not your face. Pressing Join means you agree.'));
    this.join = h('div', { class: 'join' }, card);
    this.host.root.append(this.join);
    // T136ak: 선생님이 끊은 링크면 입장 화면에서 바로 알린다 (뒤 칩만으로는 안 보임)
    const showBlocked = () => {
      if (!this.host.store.blocked || card.querySelector('.join-blocked')) return;
      card.insertBefore(h('p', { class: 'join-blocked' }, '이 링크는 더 이상 쓸 수 없어요. 선생님께 새 링크를 받으세요. · This link no longer works. Ask your teacher for a new link.'), card.children[2] || null);
      go.disabled = true;
      noCam.setAttribute('disabled', '');
    };
    showBlocked();
    const offBlocked = this.host.store.onStatus(showBlocked);
    const watch = new MutationObserver(() => {
      if (!this.join?.isConnected) (offBlocked(), watch.disconnect());
    });
    watch.observe(this.host.root, { childList: true });
    let stream: MediaStream | null = null;
    let raf = 0;
    void this.getMedia(true).then((s) => {
      stream = s;
      if (!s) {
        say('카메라·마이크를 쓸 수 없어요. 브라우저 주소창의 자물쇠에서 허용하거나, 카메라 없이 들어가세요.', "Can't use the camera or microphone. Allow them with the lock icon in the address bar, or join without camera.");
        return;
      }
      pv.srcObject = s;
      if (s.getVideoTracks().length) say('좋아요. 들어가기를 누르세요.', 'Good. Press Join.');
      else say('카메라가 없어요. 목소리로만 들어가요.', 'No camera. You will join with voice only.');
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
      // 선생님 마이크가 아직 안 켜졌으면 지금 켠다 (11/02: 마이크 없이 녹화돼 소리가 전부 무음이었다)
      if (!this.call?.local?.getAudioTracks().length) {
        const ms = await this.getMedia(false);
        if (ms?.getAudioTracks().length) await this.start(ms);
        else toast('마이크를 쓸 수 없어요 — 선생님 목소리가 녹음되지 않아요. 주소창 자물쇠에서 마이크를 허용해 주세요', 8000);
      }
      const stem = this.host.stem();
      const dir = await this.host.lessonDir(stem.replace(/_#\d+$/, ''));
      this.recOpen = dir?.open || null;
      this.recPath = dir?.path || '';
      await this.rec.start({ stage: this.host.stage, mine: this.call?.local || null, theirs: this.call?.remote() || null, stem, open: this.recOpen || (async () => null), now: this.host.store.now(), tag: String(this.host.meta().student || '').replace(/[^\w-]/g, ''), keep: true, streams: () => ({ mine: this.call?.local || null, theirs: this.call?.remote() || null }) });
      this.failMsgs = this.failMsgs.filter((m) => m.startsWith('판만 자르기'));
      this.failEl?.remove();
      this.failEl = null;
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
    let r: Awaited<ReturnType<LessonRecorder['stop']>>;
    try {
      r = await this.rec.stop({ board: this.host.store.id, ...this.host.meta(), call: this.call?.stats() }, open || (async () => null));
    } catch (e) {
      // 끝내기 자체가 실패해도 조각은 브라우저 저장소에 있다 → 그 자리에서 내려받게
      console.warn('rec stop', e);
      this.host.store.log({ kind: 'lesson', data: { op: 'rec_fail', what: 'stop', error: String(e).slice(0, 120) } });
      this.renderLesson();
      this.showFail(['녹화를 마무리하지 못했어요'], this.rec.lastSid || this.rec.sid);
      return;
    }
    const { saved, blobs, empty, fallback, fails } = r;
    this.host.store.log({ kind: 'lesson', data: { op: 'end', seconds: dur, saved: saved.length, downloaded: blobs.length, mode: saved.length ? 'folder' : 'download', empty: empty.length ? empty : undefined, fails: fails.length ? fails : undefined } });
    this.renderLesson();
    // 폴더에 못 쓰고 내려받기로 끝나면 파일 이름만으로 학생·시각을 알 수 있게 학생 번호를 앞에 붙인다(예: '<학생 폴더 코드> 2026-11-02 20-00_#19_Teacher.webm')
    const sid = this.rec.lastSid;
    const toDrive = !saved.length && !!sid && gasReady();
    const tag = saved.length || toDrive ? '' : String(this.host.meta().student || '').replace(/[^\w-]/g, '');
    const problems: string[] = [];
    if (fallback) {
      // 폴더에 다 못 썼다 → 브라우저 저장소 복사본 전체를 zip 으로 (폴더에 남은 파일은 그대로 둔다)
      problems.push('수업 폴더에 녹화를 다 쓰지 못했어요');
      await this.downloadZip(await loadSession(sid).catch(() => blobs), tag, this.host.stem());
    } else if (!toDrive) await this.downloadZip(blobs, tag, this.host.stem());
    if (!toDrive && sid && !fallback) void patchSession(sid, { localOk: true }); // 이 기기에서 저장 끝 → 오래되면 정리해도 된다
    // 판 기록도 같은 수업 폴더에 (묻는 창 없이). 드라이브로 올리는 수업은 같은 묶음에 얹는다
    const bundled = await this.host.saveBundle(open, toDrive ? sid : '');
    if (toDrive) {
      await releaseHold(sid);
      toast('녹화를 구글 드라이브 작업중으로 올리는 중이에요 · 이 탭을 닫지 말아 주세요', 6000);
      const ok = await finishUpload(sid);
      if (ok) toast('녹화와 판 기록을 구글 드라이브 작업중에 올렸어요', 9000);
      else {
        problems.push('구글 드라이브에 아직 다 못 올렸어요 (이 기기에 남아 있고, 인터넷이 되면 판을 열 때 이어서 올려요)');
        this.host.store.log({ kind: 'lesson', data: { op: 'rec_fail', what: 'upload' } });
      }
      void pumpUploads();
    } else toast(saved.length ? `수업 폴더에 저장했어요 · ${this.recPath}${bundled ? ' (녹화 + 판 기록)' : ''}` : '녹화 파일을 내려받았어요', 6000);
    this.recOpen = null;
    void this.hasSaved().then((v) => this.savedBtn && ((this.savedBtn.dataset.none = v ? '' : '1'), (this.savedBtn.hidden = !v)));
    if (empty.length && dur > 5) problems.push('녹화 파일이 비어 있어요 (' + empty.map((n) => n.replace(/^.*_/, '')).join(', ') + ')');
    for (const f of fails) if (f.kind !== 'crop') problems.push(this.failText(f.kind, f.track));
    if (problems.length) this.showFail([...new Set(problems)], sid);
    this.failMsgs = [];
  }

  // ---- 녹화 실패 알림 (T136x A07-F03): 수업 중엔 붉은 줄에 남기고, 끝나면 붉은 칸 + 그 자리에서 내려받기 ----
  private failText(kind: RecFail, track: string): string {
    const which = /_Teacher\./.test(track) ? '선생님 소리' : /_Student\./.test(track) ? '학생 소리' : /_Media\./.test(track) ? '자료 소리' : /_rec\.json$/.test(track) ? '녹화 기록' : '영상';
    if (kind === 'crop') return '판만 자르기가 안 돼요 — 카메라 칸도 녹화돼요';
    if (kind === 'write') return `수업 폴더에 쓰지 못해요 (${which}) — 이 기기 브라우저에는 남아요`;
    if (kind === 'store') return `이 기기 저장 공간에 녹화를 남기지 못해요 (${which})`;
    return `녹화가 멈춘 것 같아요 (${which} 파일이 15초 넘게 그대로)`;
  }
  private recFailed(kind: RecFail, track: string) {
    const msg = this.failText(kind, track);
    if (!this.failMsgs.includes(msg)) this.failMsgs.push(msg);
    this.host.store.log({ kind: 'lesson', data: { op: 'rec_fail', what: kind, track } });
    this.paintWarn([]);
  }
  private showFail(msgs: string[], sid: string) {
    this.failEl?.remove();
    const dl = h('button', { type: 'button', class: 'rf-dl' }, '녹화 내려받기') as HTMLButtonElement;
    const close = h('button', { type: 'button', class: 'rf-x', 'aria-label': '닫기' }, '닫기');
    const el = h('div', { class: 'rec-fail', role: 'alert' }, h('p', {}, '녹화 확인 필요: ' + msgs.join(' · ')), h('div', { class: 'rf-row' }, dl, close));
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      const parts = sid ? await loadSession(sid).catch(() => []) : [];
      if (parts.length) {
        const s = (await listSessions()).find((x) => x.id === sid);
        await this.downloadZip(parts, s?.tag || '', s?.stem || this.host.stem());
        void patchSession(sid, { localOk: true });
        toast('녹화를 zip 으로 내려받았어요', 6000);
      } else toast('이 기기에 남은 녹화가 없어요', 6000);
      dl.disabled = false;
    });
    close.addEventListener('click', () => (el.remove(), this.failEl === el && (this.failEl = null)));
    this.failEl = el;
    this.host.root.append(el);
  }

  // 내려받기 1개 묶음(zip) — 크롬의 '여러 파일 내려받기' 차단을 피한다. 영상은 이미 압축돼 있어 묶기만(STORE)
  private async downloadZip(blobs: Array<{ name: string; blob: Blob }>, tag: string, stem: string) {
    if (!blobs.length) return;
    try {
      const z = new JSZip();
      for (const b of blobs) z.file(b.name, b.blob, { compression: 'STORE' });
      const out = await z.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
      downloadBlob(`${tag ? tag + ' ' : ''}${stem}_녹화.zip`, out);
    } catch (e) {
      console.warn('zip', e);
      // 묶기 실패 → 낱개로. 크롬이 여러 파일을 막으면 뒤쪽이 빠진다(11/02 _rec.json) → 기록(json)부터
      for (const b of [...blobs].sort((x, y) => Number(!x.name.endsWith('.json')) - Number(!y.name.endsWith('.json')))) downloadBlob(tag ? `${tag} ${b.name}` : b.name, b.blob);
    }
  }

  // 지난 녹화 다시 받기: 브라우저 저장소에 남겨 둔 조각에서 (탭이 닫혔거나 내려받기가 막혔을 때)
  async redownload(): Promise<boolean> {
    const list = await listSessions();
    const s = list[0];
    if (!s) {
      toast('다시 받을 녹화가 없어요');
      return false;
    }
    const parts = await loadSession(s.id);
    if (!parts.length) {
      toast('저장된 조각이 비어 있어요');
      return false;
    }
    await this.downloadZip(parts, s.tag, s.stem);
    toast(`지난 녹화를 다시 받았어요 (${new Date(s.startedAt).toLocaleString('ko-KR')})`, 6000);
    return true;
  }
  async hasSaved(): Promise<boolean> {
    return (await listSessions()).length > 0;
  }
  async dropSaved() {
    for (const s of await listSessions()) await dropSession(s.id);
  }

  // 녹화 중 소리 크기 막대 + 무음 경고 (10초 넘게 안 들리면 크게)
  private showLevels(l: MeterLevels) {
    const m = this.meterEl;
    if (!m) return;
    m.hidden = false;
    const bar = (k: 'teacher' | 'student', db: number) => {
      const el = m.querySelector(`[data-k="${k}"]`) as HTMLElement | null;
      if (!el) return;
      (el.firstElementChild as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, (db + 70) / 60)) * 60)}px`;
      el.dataset.warn = l.warn[k];
    };
    bar('teacher', l.teacher);
    bar('student', l.student);
    const msgs: string[] = [];
    if (l.warn.teacher === 'missing') msgs.push('선생님 마이크가 연결되지 않았어요 — 목소리가 녹음되지 않아요');
    else if (l.warn.teacher === 'quiet') msgs.push('선생님 소리가 10초 넘게 안 들려요 — 마이크 음소거를 확인하세요');
    if (l.warn.student === 'missing') msgs.push('학생 소리가 연결되지 않았어요 — 학생이 마이크를 켰는지 확인하세요');
    else if (l.warn.student === 'quiet') msgs.push('학생 소리가 10초 넘게 안 들려요');
    this.paintWarn(msgs);
  }
  private paintWarn(level: string[]) {
    const msgs = [...this.failMsgs, ...level];
    if (!msgs.length) {
      this.warnEl?.remove();
      this.warnEl = null;
      return;
    }
    if (!this.warnEl) {
      this.warnEl = h('div', { class: 'rec-warn', role: 'alert' });
      this.host.root.append(this.warnEl);
    }
    this.warnEl.textContent = msgs.join(' · ') + ' (녹화는 계속돼요)';
  }

  private renderLesson() {
    const b = this.lessonBtn;
    if (!b) return;
    if (this.meterEl && !this.rec.active) {
      this.meterEl.hidden = true;
      this.warnEl?.remove();
      this.warnEl = null;
    }
    if (this.savedBtn) this.savedBtn.hidden = this.rec.active || this.savedBtn.dataset.none === '1';
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
