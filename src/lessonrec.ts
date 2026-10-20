// 수업 녹화 (선생님 크롬만): 이 탭을 찍되 판(.stage)만 남긴다 + 소리 세 줄(선생님 · 학생 · 자료)
// - 영상: 판 + 선생님 마이크 + 탭 소리(학생·자료·유튜브) (webm). 카메라 칸은 판 밖이라 학생 얼굴은 녹화에 없다 (10/18 결정)
// - 소리: 선생님만 · 학생만 · 자료만(판에 올린 영상·소리 파일) (webm/opus 32kbps) → 밤 루틴 전사
// - 유튜브는 다른 사이트라 소리만 따로 뺄 수 없다 → 재생 구간(몇 초~몇 초, 영상 id)을 _rec.json 에 남긴다(자막으로 대신)
// - 시각: 시작 순간의 판 시계(store.now) 를 _rec.json 에 → 판 사건 기록과 영상 시각이 맞는다
// 파일은 KWD 폴더 Student_Lessons/<학생>/녹화/ 에 1초마다 이어 쓴다. 폴더가 없으면 끝날 때 내려받기.

export interface RecFiles {
  video: string;
  teacher: string;
  student: string;
  media: string;
  meta: string;
}
export interface MediaSpan {
  kind: 'video' | 'audio' | 'youtube';
  name: string;
  ref: string; // 유튜브 영상 id 또는 판 자료 이름
  from_s: number;
  to_s: number | null;
}
type Writer = { write(d: Blob): Promise<void>; close(): Promise<void> };
export type OpenWriter = (name: string) => Promise<Writer | null>;

interface Track {
  rec: MediaRecorder;
  name: string;
  writer: Writer | null;
  chunks: Blob[];
  bytes: number;
  queue: Promise<void>;
}

const pick = (cands: string[]) => cands.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';

export class LessonRecorder {
  private tracks: Track[] = [];
  private display: MediaStream | null = null;
  private ac: AudioContext | null = null;
  startedAt = 0;
  startedPerf = 0;
  files: RecFiles | null = null;
  cropped = '';
  tabAudio = false;
  spans: MediaSpan[] = [];
  onMedia: (op: 'play' | 'stop', span: MediaSpan) => void = () => {};
  onEnded: () => void = () => {};
  private mediaDest: MediaStreamAudioDestinationNode | null = null;
  private hooked = new WeakSet<HTMLMediaElement>();
  private open = new Map<unknown, MediaSpan>();
  private unwatch: Array<() => void> = [];

  get active(): boolean {
    return this.tracks.length > 0;
  }
  bytes(): number {
    return this.tracks.reduce((a, t) => a + t.bytes, 0);
  }

  // stage: 남길 요소. mine/theirs: 내 마이크·상대 소리 (없어도 됨)
  async start(opts: { stage: HTMLElement; mine: MediaStream | null; theirs: MediaStream | null; stem: string; open: OpenWriter; now: number }) {
    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia(o: unknown): Promise<MediaStream> };
    this.display = await md.getDisplayMedia({
      video: { frameRate: 15, width: { max: 1920 }, height: { max: 1080 } },
      // 탭 소리: 학생 목소리 + 판 자료 + 유튜브 (영상 파일에만 섞는다)
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'exclude',
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
    const vt = this.display.getVideoTracks()[0] as MediaStreamTrack & { restrictTo?(t: unknown): Promise<void>; cropTo?(t: unknown): Promise<void> };
    // 판만: 요소 캡처(겹친 카메라 칸·패널 빼고) → 안 되면 영역 자르기
    const W = window as unknown as { RestrictionTarget?: { fromElement(e: Element): Promise<unknown> }; CropTarget?: { fromElement(e: Element): Promise<unknown> } };
    try {
      if (W.RestrictionTarget && vt.restrictTo) {
        await vt.restrictTo(await W.RestrictionTarget.fromElement(opts.stage));
        this.cropped = 'element';
      } else if (W.CropTarget && vt.cropTo) {
        await vt.cropTo(await W.CropTarget.fromElement(opts.stage));
        this.cropped = 'region';
      }
    } catch (e) {
      console.warn('crop', e);
    }
    vt.addEventListener('ended', () => this.onEnded()); // '공유 중지'를 누르면
    // 소리
    const ac = new AudioContext();
    this.ac = ac;
    // 멈춘(suspended) 소리 맥락이면 소리 줄이 데이터를 안 내고, 영상도 소리 줄을 기다려 0바이트로 끝난다 → 꼭 깨운다
    if (ac.state !== 'running') await Promise.race([ac.resume().catch(() => {}), new Promise((r) => window.setTimeout(r, 2000))]);
    const mix = ac.createMediaStreamDestination();
    // 아무 소리가 없는 줄도 끊기지 않게(모든 줄의 시각이 맞도록) 무음을 흘린다
    const hush = ac.createConstantSource();
    const hushG = ac.createGain();
    hushG.gain.value = 0;
    hush.connect(hushG);
    hush.start();
    const dest = () => {
      const d = ac.createMediaStreamDestination();
      hushG.connect(d);
      return d;
    };
    const solo = (s: MediaStream | null) => {
      const d = dest();
      if (s?.getAudioTracks().length) {
        const src = ac.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
        src.connect(d);
        src.connect(mix);
      }
      return d.stream;
    };
    const tab = this.display.getAudioTracks()[0] || null;
    this.tabAudio = !!tab;
    const teacherAudio = solo(opts.mine);
    // 탭 소리가 있으면 학생 소리는 거기 이미 들어 있다 → 영상에는 선생님 + 탭만
    const studentOnly = dest();
    if (opts.theirs?.getAudioTracks().length) {
      const src = ac.createMediaStreamSource(new MediaStream(opts.theirs.getAudioTracks()));
      src.connect(studentOnly);
      if (!tab) src.connect(mix);
    }
    const studentAudio = studentOnly.stream;
    this.mediaDest = dest();
    if (tab) ac.createMediaStreamSource(new MediaStream([tab])).connect(mix);
    const video = new MediaStream([vt, ...mix.stream.getAudioTracks()]);
    const vMime = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    const aMime = pick(['audio/webm;codecs=opus', 'audio/webm']);
    this.startedAt = opts.now;
    this.startedPerf = performance.now();
    this.files = { video: `${opts.stem}.webm`, teacher: `${opts.stem}_Teacher.webm`, student: `${opts.stem}_Student.webm`, media: `${opts.stem}_Media.webm`, meta: `${opts.stem}_rec.json` };
    const add = async (stream: MediaStream, name: string, mime: string, bps: { videoBitsPerSecond?: number; audioBitsPerSecond?: number }) => {
      const rec = new MediaRecorder(stream, { mimeType: mime, ...bps });
      const t: Track = { rec, name, writer: await opts.open(name), chunks: [], bytes: 0, queue: Promise.resolve() };
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        t.bytes += e.data.size;
        if (t.writer) t.queue = t.queue.then(() => t.writer!.write(e.data)).catch((err) => console.warn('write', err));
        else t.chunks.push(e.data);
      };
      this.tracks.push(t);
      return rec;
    };
    const recs = [
      await add(video, this.files.video, vMime, { videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 64_000 }),
      await add(teacherAudio, this.files.teacher, aMime, { audioBitsPerSecond: 32_000 }),
      await add(studentAudio, this.files.student, aMime, { audioBitsPerSecond: 32_000 }),
      await add(this.mediaDest.stream, this.files.media, aMime, { audioBitsPerSecond: 32_000 }),
    ];
    for (const r of recs) r.start(1000);
    this.spans = [];
    this.watchMedia(opts.stage.ownerDocument || document);
  }

  private t(): number {
    return Math.round((performance.now() - this.startedPerf) / 100) / 10;
  }
  private begin(key: unknown, kind: MediaSpan['kind'], name: string, ref: string) {
    if (this.open.has(key)) return;
    const sp: MediaSpan = { kind, name, ref, from_s: this.t(), to_s: null };
    this.open.set(key, sp);
    this.spans.push(sp);
    this.onMedia('play', sp);
  }
  private end(key: unknown) {
    const sp = this.open.get(key);
    if (!sp) return;
    sp.to_s = this.t();
    this.open.delete(key);
    this.onMedia('stop', sp);
  }

  // 판 위 자료의 재생을 지켜본다: 파일(영상·소리)은 소리를 '자료' 줄로, 유튜브는 구간만
  private watchMedia(doc: Document) {
    const isCam = (el: Element) => !!el.closest('.cam-dock, .join');
    const nameOf = (el: Element) => (el.closest('.obj, .popup')?.querySelector('.obj-name, .popup-title')?.textContent || '').replace(/^[▶♪]\s*/, '').trim();
    const hook = (el: HTMLMediaElement) => {
      if (this.hooked.has(el) || !this.ac || !this.mediaDest) return;
      try {
        const cs = (el as HTMLMediaElement & { captureStream?(): MediaStream }).captureStream?.();
        if (!cs) return;
        this.hooked.add(el);
        const used = new Set<string>();
        const wire = () => {
          for (const t of cs.getAudioTracks()) {
            if (used.has(t.id) || !this.ac || !this.mediaDest) continue;
            used.add(t.id);
            this.ac.createMediaStreamSource(new MediaStream([t])).connect(this.mediaDest);
          }
        };
        wire();
        cs.addEventListener('addtrack', wire); // 소리 줄은 재생이 시작된 뒤에 붙기도 한다
      } catch (e) {
        console.warn('media capture', e);
      }
    };
    const onPlay = (e: Event) => {
      const el = e.target as HTMLMediaElement;
      if (!(el instanceof HTMLMediaElement) || isCam(el)) return;
      hook(el);
      const nm = nameOf(el) || (el instanceof HTMLVideoElement ? '영상' : '소리');
      this.begin(el, el instanceof HTMLVideoElement ? 'video' : 'audio', nm, nm);
    };
    const onStop = (e: Event) => {
      const el = e.target as HTMLMediaElement;
      if (el instanceof HTMLMediaElement) this.end(el);
    };
    doc.addEventListener('playing', onPlay, true);
    for (const k of ['pause', 'ended', 'emptied']) doc.addEventListener(k, onStop, true);
    // 지금 이미 재생 중인 것
    doc.querySelectorAll('audio, video').forEach((el) => {
      const m = el as HTMLMediaElement;
      if (!m.paused && !isCam(m)) onPlay({ target: m } as unknown as Event);
    });
    // 유튜브: iframe API 의 상태 알림(postMessage). 각 판 유튜브에 '듣고 있어요'를 보낸다
    const yts = new Map<Window, HTMLIFrameElement>();
    const ytId = (f: HTMLIFrameElement) => /\/embed\/([\w-]{11})/.exec(f.src)?.[1] || '';
    const listen = (f: HTMLIFrameElement) => {
      if (!/youtube(-nocookie)?\.com\/embed\//.test(f.src)) return;
      const say = () => {
        if (f.contentWindow) {
          yts.set(f.contentWindow, f);
          f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: ytId(f), channel: 'widget' }), '*');
        }
      };
      say();
      f.addEventListener('load', say);
    };
    doc.querySelectorAll('iframe').forEach((f) => listen(f as HTMLIFrameElement));
    const mo = new MutationObserver((ms) => {
      for (const m of ms)
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLIFrameElement) listen(n);
          else if (n instanceof Element) n.querySelectorAll('iframe').forEach((f) => listen(f as HTMLIFrameElement));
        });
    });
    mo.observe(doc.body, { childList: true, subtree: true });
    const onMsg = (e: MessageEvent) => {
      if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
      const f = yts.get(e.source as Window);
      if (!f) return;
      let d: { event?: string; info?: unknown } = {};
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const st = d.event === 'onStateChange' ? Number(d.info) : d.event === 'infoDelivery' ? Number((d.info as { playerState?: number })?.playerState ?? NaN) : NaN;
      if (Number.isNaN(st)) return;
      if (st === 1) this.begin(f, 'youtube', nameOf(f) || '유튜브', ytId(f));
      else if (st === 0 || st === 2 || st === -1) this.end(f);
    };
    window.addEventListener('message', onMsg);
    this.unwatch.push(() => {
      doc.removeEventListener('playing', onPlay, true);
      for (const k of ['pause', 'ended', 'emptied']) doc.removeEventListener(k, onStop, true);
      mo.disconnect();
      window.removeEventListener('message', onMsg);
    });
  }

  // 끝: 파일을 닫고, 폴더가 없던 것은 Blob 으로 돌려준다
  async stop(meta: Record<string, unknown>, open: OpenWriter): Promise<{ saved: string[]; blobs: Array<{ name: string; blob: Blob }>; empty: string[] }> {
    const saved: string[] = [];
    const blobs: Array<{ name: string; blob: Blob }> = [];
    for (const k of Array.from(this.open.keys())) this.end(k);
    this.unwatch.forEach((f) => f());
    this.unwatch = [];
    await Promise.all(
      this.tracks.map(
        (t) =>
          new Promise<void>((res) => {
            if (t.rec.state === 'inactive') return res();
            t.rec.addEventListener('stop', () => res(), { once: true });
            t.rec.stop();
          }),
      ),
    );
    for (const t of this.tracks) {
      await t.queue;
      if (t.writer) {
        await t.writer.close();
        saved.push(t.name);
      } else blobs.push({ name: t.name, blob: new Blob(t.chunks, { type: t.rec.mimeType }) });
    }
    // 0바이트 줄 점검 — 학생·자료 줄은 비는 수업도 있어 알림은 영상·선생님 줄만, 크기는 모두 기록
    const sizes: Record<string, number> = {};
    for (const t of this.tracks) sizes[t.name] = t.bytes;
    const empty = this.tracks.filter((t) => !t.bytes && (t.name === this.files?.video || t.name === this.files?.teacher)).map((t) => t.name);
    const metaText = JSON.stringify(
      {
        schema: 'kwd-lesson-rec/v2',
        started_at: this.startedAt,
        started_at_iso: new Date(this.startedAt).toISOString(),
        duration_s: Math.round((performance.now() - this.startedPerf) / 1000),
        files: this.files,
        crop: this.cropped || 'none',
        faces: { student: false, teacher: false },
        // 전사용: 소리 줄마다 무엇이 들어 있나 + 판 자료 재생 구간(녹화 시작부터 초)
        audio: {
          teacher: '선생님 마이크만',
          student: '학생 목소리만',
          media: '판에 올린 영상·소리 파일만 (유튜브 제외)',
          video: this.tabAudio ? '선생님 마이크 + 탭 소리(학생·자료·유튜브)' : '선생님 + 학생 + 자료',
        },
        media: this.spans,
        bytes: sizes,
        ...meta,
      },
      null,
      1,
    );
    if (this.files) {
      const w = await open(this.files.meta);
      if (w) {
        await w.write(new Blob([metaText], { type: 'application/json' }));
        await w.close();
        saved.push(this.files.meta);
      } else blobs.push({ name: this.files.meta, blob: new Blob([metaText], { type: 'application/json' }) });
    }
    this.display?.getTracks().forEach((t) => t.stop());
    this.display = null;
    void this.ac?.close();
    this.ac = null;
    this.tracks = [];
    return { saved, blobs, empty };
  }
}
