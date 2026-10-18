// 교실 (v8): 판 위에 카메라 칸 · 학생 입장 화면 · 수업 시작/끝내기(녹화) · 보기 모드
// 통화는 call.ts(P2P), 녹화는 lessonrec.ts. 판 문서에는 영상·소리·시그널이 들어가지 않는다(카메라 보기 모드 설정만).
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
  openWriter: OpenWriter; // KWD 폴더 학생 녹화/ (없으면 null)
  stem: () => string; // 녹화 파일 이름 앞부분
  saveBundle: () => Promise<void>;
  meta: () => Record<string, unknown>;
}

type CamView = 'board' | 'cams';
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
  private rec = new LessonRecorder();
  private remoteV: HTMLVideoElement;
  private localV: HTMLVideoElement;
  private status: HTMLElement;
  private ctrl: HTMLElement;
  private join: HTMLElement | null = null;
  private timer = 0;
  private confirmEnd = 0;
  private offs: Array<() => void> = [];

  constructor(private host: ClassroomHost) {
    const { role } = host;
    this.dock = h('div', { class: 'cam-dock', 'data-state': 'off' });
    this.remoteV = h('video', { class: 'cam-remote', autoplay: '', playsinline: '' }) as HTMLVideoElement;
    this.localV = h('video', { class: 'cam-local', autoplay: '', playsinline: '' }) as HTMLVideoElement;
    this.localV.muted = true;
    this.status = h('div', { class: 'cam-status' });
    this.ctrl = h('div', { class: 'cam-ctrl' });
    const remoteBox = h('div', { class: 'cam-tile remote' }, this.remoteV, h('span', { class: 'cam-name' }, role === 'teacher' ? '학생' : '선생님'), h('span', { class: 'cam-wait' }, role === 'teacher' ? '학생을 기다리는 중' : '선생님을 기다리는 중'));
    const localBox = h('div', { class: 'cam-tile local' }, this.localV, h('span', { class: 'cam-name' }, '나'));
    this.dock.append(h('div', { class: 'cam-tiles' }, remoteBox, localBox), this.status, this.ctrl);
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
      this.rec.onEnded = () => void this.endLesson(); // 크롬의 '공유 중지'
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
    // 상태 한 줄
    const st = c.stats();
    const q = { good: '연결 좋음', ok: '조금 느림', bad: '연결 나쁨', none: '' }[st.quality];
    this.status.textContent = !c.local && !on ? '' : live ? `${q}${st.rtt ? ` · ${st.rtt}ms` : ''}${st.relayed ? ' · 중계' : ''}${pm?.micOff ? ' · 상대 마이크 꺼짐' : ''}` : this.host.role === 'teacher' ? '학생이 링크로 들어오면 바로 연결돼요' : '선생님을 기다리는 중';
    this.status.dataset.q = live ? st.quality : 'none';
    // 단추
    this.ctrl.innerHTML = '';
    const btn = (label: string, title: string, fn: () => void, cls = '') => {
      const b = h('button', { type: 'button', class: 'cam-b ' + cls, title }, label);
      b.addEventListener('click', fn);
      this.ctrl.append(b);
      return b;
    };
    if (!c.local) {
      if (this.host.role === 'teacher') btn('카메라 켜기', '카메라와 마이크를 켜고 학생을 기다려요', () => void this.getMedia(true).then((s) => (s ? this.start(s) : toast('카메라·마이크를 쓸 수 없어요. 주소창 자물쇠에서 허용해 주세요'))), 'primary');
      else if (!this.join) btn('카메라 켜기', '카메라·마이크 켜기', () => this.showJoin(), 'primary');
      return;
    }
    btn(c.micOn() ? '마이크 끄기' : '마이크 켜기', '', () => (c.setMic(!c.micOn()), this.render()), c.micOn() ? '' : 'off');
    btn(c.camOn() ? '카메라 끄기' : '카메라 켜기', '', () => (c.setCamera(!c.camOn()), this.render()), c.camOn() ? '' : 'off');
    if (this.host.role === 'teacher') {
      const big = this.view() === 'cams';
      btn(big ? '판 보기' : '얼굴 크게', '학생 화면도 같이 바뀌어요', () => this.setView(big ? 'board' : 'cams'));
    }
    const st2 = c.stats();
    if (st2.quality === 'bad' || ['failed', 'disconnected'].includes(st2.state)) btn('다시 연결', '연결이 나쁠 때', () => c.reconnect(), 'ghost');
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

  private async startLesson() {
    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: unknown };
    if (!md?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      toast('녹화는 컴퓨터의 크롬·엣지에서 돼요');
      return;
    }
    try {
      this.lessonBtn!.disabled = true;
      await this.rec.start({ stage: this.host.stage, mine: this.call?.local || null, theirs: this.call?.remote() || null, stem: this.host.stem(), open: this.host.openWriter, now: this.host.store.now() });
      this.host.store.meta.set('recording', { startedAt: this.rec.startedAt, files: this.rec.files, crop: this.rec.cropped || 'none' });
      this.host.store.log({ kind: 'lesson', data: { op: 'start', rec: this.rec.files, crop: this.rec.cropped || 'none' } });
      toast(this.rec.cropped ? '수업을 시작했어요 · 판과 목소리를 녹화해요' : '수업을 시작했어요 · 녹화 중');
    } catch (e) {
      console.warn('rec', e);
      toast('녹화를 시작하지 못했어요. 크롬이 묻는 창에서 이 탭을 고르고 공유를 눌러 주세요', 5000);
    } finally {
      this.lessonBtn!.disabled = false;
      this.renderLesson();
    }
  }

  async endLesson() {
    if (!this.rec.active) return;
    this.confirmEnd = 0;
    const dur = Math.round((this.host.store.now() - this.rec.startedAt) / 1000);
    const { saved, blobs } = await this.rec.stop({ board: this.host.store.id, ...this.host.meta(), call: this.call?.stats() }, this.host.openWriter);
    this.host.store.log({ kind: 'lesson', data: { op: 'end', seconds: dur, saved: saved.length } });
    for (const b of blobs) downloadBlob(b.name, b.blob);
    toast(saved.length ? `녹화 ${saved.length}개를 학생 폴더 녹화/ 에 저장했어요` : '녹화 파일을 내려받았어요', 5000);
    this.renderLesson();
    await this.host.saveBundle();
  }

  private renderLesson() {
    const b = this.lessonBtn;
    if (!b) return;
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
