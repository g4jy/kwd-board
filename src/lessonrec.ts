// 수업 녹화 (선생님 크롬만): 이 탭을 찍되 판(.stage)만 남긴다 + 소리 두 줄(선생님 · 학생)
// - 영상: 판 + 두 사람 소리 섞은 것 (webm). 카메라 칸은 판 밖이라 학생 얼굴은 녹화에 없다 (10/18 결정)
// - 소리: 선생님만 · 학생만 (webm/opus 32kbps) → 밤 루틴 전사(Teacher/Student 두 트랙)
// - 시각: 시작 순간의 판 시계(store.now) 를 _rec.json 에 → 판 사건 기록과 영상 시각이 맞는다
// 파일은 KWD 폴더 Student_Lessons/<학생>/녹화/ 에 1초마다 이어 쓴다. 폴더가 없으면 끝날 때 내려받기.

export interface RecFiles {
  video: string;
  teacher: string;
  student: string;
  meta: string;
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
  onEnded: () => void = () => {};

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
      audio: false,
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
    const mix = ac.createMediaStreamDestination();
    const solo = (s: MediaStream | null) => {
      const d = ac.createMediaStreamDestination();
      if (s?.getAudioTracks().length) {
        const src = ac.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
        src.connect(d);
        src.connect(mix);
      }
      return d.stream;
    };
    const teacherAudio = solo(opts.mine);
    const studentAudio = solo(opts.theirs);
    const video = new MediaStream([vt, ...mix.stream.getAudioTracks()]);
    const vMime = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    const aMime = pick(['audio/webm;codecs=opus', 'audio/webm']);
    this.startedAt = opts.now;
    this.startedPerf = performance.now();
    this.files = { video: `${opts.stem}.webm`, teacher: `${opts.stem}_Teacher.webm`, student: `${opts.stem}_Student.webm`, meta: `${opts.stem}_rec.json` };
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
    ];
    for (const r of recs) r.start(1000);
  }

  // 끝: 파일을 닫고, 폴더가 없던 것은 Blob 으로 돌려준다
  async stop(meta: Record<string, unknown>, open: OpenWriter): Promise<{ saved: string[]; blobs: Array<{ name: string; blob: Blob }> }> {
    const saved: string[] = [];
    const blobs: Array<{ name: string; blob: Blob }> = [];
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
    const metaText = JSON.stringify(
      {
        schema: 'kwd-lesson-rec/v1',
        started_at: this.startedAt,
        started_at_iso: new Date(this.startedAt).toISOString(),
        duration_s: Math.round((performance.now() - this.startedPerf) / 1000),
        files: this.files,
        crop: this.cropped || 'none',
        faces: { student: false, teacher: false },
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
    return { saved, blobs };
  }
}
