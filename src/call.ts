// 1:1 영상 통화 (P2P, WebRTC). 화면과 분리된 모듈 — 그룹 교실은 같은 인터페이스를 SFU(LiveKit)로 구현하면 된다.
// 소개(시그널)는 Yjs awareness 로 한다: 판 문서에는 들어가지 않고(일시적), 동기 서버·같은 브라우저 창(BroadcastChannel) 어디서나 같은 길로 간다.
// 선생님이 언제나 먼저 묻고(offer) 학생이 답한다(answer). 후보(ICE)는 다 모은 뒤 한 번에 보낸다(서버를 바꿀 필요 없음).
import type { Awareness } from 'y-protocols/awareness';
import type { Role } from './store';

export type Quality = 'good' | 'ok' | 'bad' | 'none';
export interface CallStats {
  rtt: number;
  relayed: boolean;
  quality: Quality;
  state: string;
}
interface RtcMsg {
  to: number;
  n: number;
  kind: 'offer' | 'answer' | 'want';
  sdp?: string;
}
type Listener = () => void;

export const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export class Call {
  local: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private peer = 0; // 상대 awareness client id
  private n = 0; // 협상 번호 (다시 연결할 때마다 +1)
  private answeredN = -1;
  private ice: RTCIceServer[] = DEFAULT_ICE;
  private listeners = new Set<Listener>();
  private retry = 0;
  private statTimer = 0;
  private lastStats: CallStats = { rtt: 0, relayed: false, quality: 'none', state: 'idle' };
  private disposed = false;
  private lastPeerMedia = '';
  private onAw = () => {
    this.onAwareness();
    const pm = JSON.stringify(this.peerMedia());
    if (pm !== this.lastPeerMedia) {
      this.lastPeerMedia = pm;
      this.emit();
    }
  };
  log: (kind: string, data: Record<string, unknown>) => void = () => {};

  constructor(
    private aw: Awareness,
    private role: Role,
  ) {
    aw.on('change', this.onAw);
    this.statTimer = window.setInterval(() => void this.pollStats(), 3000);
  }

  setIceServers(ice: RTCIceServer[]) {
    this.ice = ice.length ? ice : DEFAULT_ICE;
  }
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  remote(): MediaStream | null {
    return this.remoteStream;
  }
  stats(): CallStats {
    return this.lastStats;
  }
  connected(): boolean {
    return !!this.pc && (this.pc.connectionState === 'connected' || this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed');
  }

  // 내 카메라·마이크 (없으면 소리만, 그것도 없으면 받기만)
  async start(stream: MediaStream | null) {
    this.local = stream;
    this.aw.setLocalStateField('media', { cam: !!stream?.getVideoTracks().length, mic: !!stream?.getAudioTracks().length, on: true });
    if (this.role === 'student') this.aw.setLocalStateField('rtc', { to: 0, n: 0, kind: 'want' } satisfies RtcMsg);
    this.emit();
    this.onAwareness();
  }

  setCamera(on: boolean) {
    this.local?.getVideoTracks().forEach((t) => (t.enabled = on));
    this.aw.setLocalStateField('media', { ...((this.aw.getLocalState() as { media?: object })?.media || {}), camOff: !on });
    this.emit();
  }
  setMic(on: boolean) {
    this.local?.getAudioTracks().forEach((t) => (t.enabled = on));
    this.aw.setLocalStateField('media', { ...((this.aw.getLocalState() as { media?: object })?.media || {}), micOff: !on });
    this.emit();
  }
  camOn(): boolean {
    return !!this.local?.getVideoTracks().some((t) => t.enabled);
  }
  micOn(): boolean {
    return !!this.local?.getAudioTracks().some((t) => t.enabled);
  }
  // 상대의 카메라·마이크 상태 (awareness)
  peerMedia(): { camOff?: boolean; micOff?: boolean; on?: boolean } | null {
    const st = this.aw.getStates().get(this.peer) as { media?: { camOff?: boolean; micOff?: boolean; on?: boolean } } | undefined;
    return st?.media || null;
  }

  private states(): Array<[number, { role?: string; media?: { on?: boolean }; rtc?: RtcMsg }]> {
    return Array.from(this.aw.getStates().entries()) as Array<[number, { role?: string; media?: { on?: boolean }; rtc?: RtcMsg }]>;
  }

  private onAwareness() {
    if (this.disposed) return;
    const me = this.aw.clientID;
    const want = this.role === 'teacher' ? 'student' : 'teacher';
    const others = this.states().filter(([id, s]) => id !== me && s.role === want && s.media?.on);
    // 상대가 나갔으면 끊는다
    if (this.peer && !others.some(([id]) => id === this.peer)) {
      this.hangup('left');
      this.peer = 0;
    }
    if (!this.aw.getLocalState() || !(this.aw.getLocalState() as { media?: { on?: boolean } }).media?.on) return;
    if (this.role === 'teacher') {
      // 학생이 들어오면(또는 다시 원하면) 묻는다. 1:1 이라 가장 최근에 온 학생 하나
      const st = others[others.length - 1];
      if (!st) return;
      const [id, s] = st;
      const fresh = id !== this.peer || (s.rtc?.kind === 'want' && (s.rtc.n || 0) >= this.n) || !this.pc;
      if (fresh && !this.offering) void this.offer(id);
      else if (s.rtc?.kind === 'answer' && s.rtc.to === me && s.rtc.n === this.n && this.pc?.signalingState === 'have-local-offer') void this.acceptAnswer(s.rtc.sdp || '');
    } else {
      const t = others.find(([, s]) => s.rtc?.kind === 'offer' && s.rtc.to === me);
      if (t && t[1].rtc!.n !== this.answeredN) void this.answer(t[0], t[1].rtc!);
    }
  }

  private offering = false;
  private newPc(): RTCPeerConnection {
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.remoteStream = new MediaStream();
    if (this.local) for (const t of this.local.getTracks()) pc.addTrack(t, this.local);
    if (!this.local?.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    if (!this.local?.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      if (!this.remoteStream!.getTracks().includes(e.track)) this.remoteStream!.addTrack(e.track);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      this.log('call', { op: pc.connectionState });
      if (pc.connectionState === 'connected') this.retry = 0;
      if (pc.connectionState === 'failed') this.scheduleRetry();
      this.emit();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected') window.setTimeout(() => pc.iceConnectionState === 'disconnected' && this.scheduleRetry(), 4000);
      this.emit();
    };
    this.pc = pc;
    return pc;
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        res();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      pc.addEventListener('icegatheringstatechange', check);
      window.setTimeout(done, 2500); // 다 못 모아도 2.5초 뒤 보낸다(대부분 충분)
    });
  }

  private async offer(peer: number) {
    this.offering = true;
    try {
      this.peer = peer;
      this.n += 1;
      const n = this.n;
      const pc = this.newPc();
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      if (n !== this.n || this.disposed) return;
      this.aw.setLocalStateField('rtc', { to: peer, n, kind: 'offer', sdp: pc.localDescription!.sdp } satisfies RtcMsg);
      this.log('call', { op: 'offer', n });
      this.emit();
    } catch (e) {
      console.warn('offer', e);
    } finally {
      this.offering = false;
    }
    this.onAwareness(); // 그사이 온 답
  }

  private async acceptAnswer(sdp: string) {
    try {
      await this.pc!.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      console.warn('answer', e);
    }
  }

  private async answer(peer: number, msg: RtcMsg) {
    this.answeredN = msg.n;
    this.peer = peer;
    try {
      const pc = this.newPc();
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp || '' });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered(pc);
      if (this.disposed) return;
      this.aw.setLocalStateField('rtc', { to: peer, n: msg.n, kind: 'answer', sdp: pc.localDescription!.sdp } satisfies RtcMsg);
      this.emit();
    } catch (e) {
      console.warn('answer', e);
    }
  }

  private scheduleRetry() {
    if (this.disposed) return;
    const wait = [3000, 6000, 12000][Math.min(this.retry, 2)];
    this.retry += 1;
    this.log('call', { op: 'retry', n: this.retry });
    window.setTimeout(() => this.reconnect(), wait);
  }
  // 다시 연결: 학생은 '다시 원해요', 선생님은 새로 묻는다
  reconnect() {
    if (this.disposed) return;
    if (this.role === 'student') this.aw.setLocalStateField('rtc', { to: this.peer, n: this.answeredN + 1, kind: 'want' } satisfies RtcMsg);
    else if (this.peer) void this.offer(this.peer);
  }

  private hangup(why: string) {
    this.pc?.close();
    this.pc = null;
    this.remoteStream = null;
    this.log('call', { op: 'end', why });
    this.emit();
  }

  private async pollStats() {
    const pc = this.pc;
    if (!pc) {
      this.lastStats = { rtt: 0, relayed: false, quality: 'none', state: this.local ? 'waiting' : 'idle' };
      return;
    }
    try {
      const rep = await pc.getStats();
      let rtt = 0;
      let relayed = false;
      let lost = 0;
      let recv = 0;
      const cands = new Map<string, { candidateType?: string }>();
      rep.forEach((s: { type: string; id: string; candidateType?: string }) => {
        if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s);
      });
      rep.forEach((s: Record<string, unknown>) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          rtt = Math.round(Number(s.currentRoundTripTime || 0) * 1000);
          const l = cands.get(String(s.localCandidateId));
          const r = cands.get(String(s.remoteCandidateId));
          relayed = l?.candidateType === 'relay' || r?.candidateType === 'relay';
        }
        if (s.type === 'inbound-rtp') {
          lost += Number(s.packetsLost || 0);
          recv += Number(s.packetsReceived || 0);
        }
      });
      const lossPct = recv ? (lost / (lost + recv)) * 100 : 0;
      const quality: Quality = !this.connected() ? 'none' : rtt > 400 || lossPct > 8 ? 'bad' : rtt > 200 || lossPct > 3 ? 'ok' : 'good';
      if (relayed !== this.lastStats.relayed && this.connected()) this.log('call', { op: 'route', relayed });
      this.lastStats = { rtt, relayed, quality, state: pc.connectionState };
      this.emit();
    } catch {
      /* 닫힌 연결 */
    }
  }

  stop() {
    this.disposed = true;
    window.clearInterval(this.statTimer);
    this.aw.off('change', this.onAw);
    this.pc?.close();
    this.pc = null;
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    try {
      this.aw.setLocalStateField('media', null);
      this.aw.setLocalStateField('rtc', null);
    } catch {
      /* 이미 닫힘 */
    }
  }
}

// 체험·시험용 가짜 카메라: 캔버스에 그린 얼굴 대신 그림(KWD 선화) + 조용한 소리
export function fakeMedia(label: string, tone: string): MediaStream {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 240;
  const g = c.getContext('2d')!;
  let t = 0;
  const draw = () => {
    t += 1;
    g.fillStyle = tone;
    g.fillRect(0, 0, 320, 240);
    g.strokeStyle = '#1f2a44';
    g.lineWidth = 4;
    g.fillStyle = '#fff';
    const bob = Math.sin(t / 12) * 3;
    g.beginPath();
    g.arc(160, 100 + bob, 38, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(92, 240);
    g.quadraticCurveTo(100, 160 + bob, 160, 158 + bob);
    g.quadraticCurveTo(220, 160 + bob, 228, 240);
    g.fill();
    g.stroke();
    void label; // 이름은 카메라 칸에 따로
  };
  draw();
  const iv = window.setInterval(draw, 66);
  const s = (c as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(15);
  try {
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    const o = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.0001; // 거의 무음
    o.connect(gain).connect(dst);
    o.start();
    s.addTrack(dst.stream.getAudioTracks()[0]);
  } catch {
    /* 소리 없음 */
  }
  s.getVideoTracks()[0].addEventListener('ended', () => window.clearInterval(iv));
  return s;
}
