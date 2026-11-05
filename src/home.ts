// 선생님 첫 화면 (T160): 오늘 수업 목록 → 학생 줄을 누르면 수업 카드(전·중·후). 연결·폴더·방 코드·체험은 ⚙ 설정 한 곳.
// 학생 이름·정보는 선생님 열쇠로 런타임에만 불러온다 (이 저장소에는 없음). 학생 정보는 읽기만.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { loadIndex, saveIndex, randomId, getServerUrl, setServerUrl, DEFAULT_SERVER } from './store';
import { h, fmtDateTime, toast } from './ui';
import { gasReady, gasCall } from './gas';
import { listSessions } from './recstore';
import { hubCards, HUB_URL, type HubCard } from './homework';
import { loadStudentInfo, infoFor, packetFor, canUseFolder, folderState, pickWorkFolder, useDroppedItems, reopenFolder, listStudents, briefFor, boardIdFor, ensureClassCode, rememberBoardFolder, folderForBoard, forgetFolder, ymd, isDemo, loadRoster, saveRosterEdit, loadRosterTeacher, type StudentEntry, type BriefLesson, type StudentInfo, type Roster, type RosterStudent, type RosterEdit, type RosterStatus } from './kwdfolder';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);
const HW_LABEL: Record<string, [string, string]> = {
  done: ['과제 했음', 'ok'],
  doing: ['과제 하는 중', 'warn'],
  open: ['과제 안 함', 'bad'],
  wait: ['과제 안 함 · 승인 대기', 'bad'],
  skipped: ['과제 건너뜀', 'mute'],
  rest: ['쉬는 날', 'mute'],
  none: ['과제 세트 없음', 'mute'],
};
const mins = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
const nowMin = () => new Date().getHours() * 60 + new Date().getMinutes();

// 오늘 수업 한 줄에 필요한 것을 한곳에 모은 값
interface Row {
  l: BriefLesson;
  info?: StudentInfo;
  hub?: HubCard;
  sid: string;
  checks: string[];
}

export class HomeScreen {
  readonly root: HTMLElement;
  private alive = true;
  private names = new Map<string, string>(); // 학생 번호 → 이름 (열쇠가 있을 때 화면에서만)
  private peek: { provider: WebsocketProvider; doc: Y.Doc } | null = null;
  private openCard: HTMLElement | null = null;

  constructor() {
    this.root = h('div', { class: 'home th' });
    void this.render();
  }

  private async openStudent(folder: string, id: string) {
    await ensureClassCode(folder);
    const bid = boardIdFor(folder);
    rememberBoardFolder(bid, folder);
    location.hash = `#/b/${bid}?r=t&st=${encodeURIComponent(id || folder)}`;
  }

  private async copyStudentLink(folder: string) {
    const code = await ensureClassCode(folder);
    if (!code) return toast('체험 화면에서는 학생 링크가 없어요');
    const srv = getServerUrl();
    const srvQ = srv && srv !== DEFAULT_SERVER ? `?srv=${encodeURIComponent(srv)}` : '';
    const url = `${location.origin}${location.pathname}#/c/${code}${srvQ}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('학생 링크를 복사했어요');
    } catch {
      window.prompt('학생 링크 (복사해 주세요)', url);
    }
  }

  private async render() {
    this.stopPeek();
    this.openCard = null;
    this.root.innerHTML = '';
    const d = new Date();
    const gear = h('button', { type: 'button', class: 'th-icon', 'aria-label': '설정', title: '설정' }, '⚙');
    const hub = h('a', { class: 'th-hub', href: HUB_URL, target: '_blank', rel: 'noopener' }, '허브로');
    const head = h('div', { class: 'th-head' }, h('div', { class: 'th-title' }, h('h1', {}, '오늘 수업'), h('span', { class: 'home-date' }, `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`)), h('div', { class: 'th-tools' }, hub, gear));
    this.root.append(head);
    const set = h('div', { class: 'th-settings', hidden: '' });
    gear.addEventListener('click', () => {
      set.hidden = !set.hidden;
      gear.classList.toggle('on', !set.hidden);
    });
    this.root.append(set);
    const main = h('div', { class: 'home-main' });
    this.root.append(main);

    const remote = gasReady();
    const fs = canUseFolder() ? await folderState() : { state: 'none' as const, name: '' };
    if (!this.alive) return;
    let connected = false;
    let problem = '';
    if (remote) {
      const wait = h('p', { class: 'empty th-loading' }, '구글 드라이브에서 불러오는 중…');
      main.append(wait);
      const ok = await gasCall('ping', {}, 20_000).then(() => '', (e: Error) => e.message || 'fail');
      if (!this.alive) return;
      wait.remove();
      if (!ok) connected = true;
      else problem = ok === 'auth' ? '이 기기의 열쇠가 맞지 않아요. 선생님 링크를 다시 열어 주세요.' : ok === 'net' ? '구글 드라이브에 닿지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.' : '구글 드라이브 연결이 아직 준비되지 않았어요 (' + ok + ').';
    } else if (canUseFolder() && fs.state === 'granted') connected = true;
    else if (canUseFolder() && (fs.state === 'prompt' || fs.state === 'denied')) problem = `폴더 접근을 다시 허용해야 해요 (${fs.name}).`;
    else problem = '이 기기는 아직 연결되지 않았어요. 선생님 링크로 한 번 열면 저절로 연결돼요.';

    if (connected) await this.renderToday(main);
    else {
      const card = h('div', { class: 'th-empty' }, h('p', { class: 'th-empty-t' }, problem));
      const row = h('div', { class: 'th-empty-a' });
      if (remote) {
        const again = h('button', { type: 'button', class: 'primary' }, '다시 시도');
        again.addEventListener('click', () => void this.render());
        row.append(again);
      } else if (canUseFolder() && (fs.state === 'prompt' || fs.state === 'denied')) {
        const b = h('button', { type: 'button', class: 'primary' }, '폴더 다시 열기');
        b.addEventListener('click', async () => ((await reopenFolder()) ? void this.render() : toast('폴더를 열지 못했어요. 설정에서 다시 골라 주세요.')));
        row.append(b);
      }
      const more = h('button', { type: 'button' }, '설정 열기');
      more.addEventListener('click', () => {
        set.hidden = false;
        gear.classList.add('on');
      });
      row.append(more);
      card.append(row);
      main.append(card);
    }
    this.renderSettings(set, connected, fs.state !== 'none' ? fs.name : '');
    if (!connected) {
      this.root.insertBefore(main, set); // 안 될 때는 이유와 [다시 시도]가 설정보다 위
      set.hidden = false;
      gear.classList.add('on');
    }
  }

  // ---- 오늘 수업 목록 ----
  private async renderToday(main: HTMLElement) {
    const skel = h('p', { class: 'empty th-loading' }, '오늘 수업을 불러오는 중…');
    main.append(skel);
    const [brief, infos, hubs, students] = await Promise.all([briefFor(ymd()).catch(() => null), loadStudentInfo().catch(() => [] as StudentInfo[]), hubCards().catch(() => null), listStudents().catch(() => [] as StudentEntry[])]);
    if (!this.alive) return;
    skel.remove();
    for (const s of students) if (s.id) this.names.set(s.id, s.name);
    const lessons = brief?.lessons || [];
    const rows: Row[] = lessons.map((l) => {
      const info = infoFor(infos, l.folder, l.name);
      const hub = hubs?.find((c) => (!!info?.st && c.student_id === info.st) || (!!info?.sno && c.sno === info.sno) || (!!c.name && norm(c.name) === norm(l.name)));
      return { l, info, hub, sid: (/\(([^)]+)\)/.exec(l.folder) || [])[1] || '', checks: this.checksOf(l) };
    });
    const sec = h('section', { class: 'th-list' });
    if (!rows.length) sec.append(h('div', { class: 'th-empty' }, h('p', { class: 'th-empty-t' }, brief ? '오늘은 잡힌 수업이 없어요.' : '오늘 아침 브리핑이 아직 없어요. 아래 ‘학생 전체’에서 학생을 고르세요.')));
    const now = nowMin();
    let nextMarked = false;
    for (const r of rows) {
      const t = mins(r.l.time);
      const past = t >= 0 && now > t + 50;
      const live = t >= 0 && now >= t - 5 && now <= t + 50;
      const next = !past && !live && !nextMarked;
      if (live || next) nextMarked = true;
      sec.append(this.item(r, past, live ? 'live' : next ? 'next' : ''));
    }
    main.append(sec);
    if (hubs === null && rows.length) main.append(h('p', { class: 'th-foot' }, '과제 했음/안 함 표시는 숙제 연결(판 안 메뉴 ‘숙제 연결’)이 있어야 나와요.'));
    // 학생 전체 (목표 × 수준 표) — 둘째 자리
    const roster = await loadRoster();
    if (!this.alive) return;
    const det = h('details', { class: 'th-all' });
    det.append(h('summary', {}, `학생 전체${roster ? ' ' + roster.students.length : students.length ? ' ' + students.length : ''}`));
    if (roster && roster.students.length) det.append(this.rosterGrid(roster, students));
    else det.append(this.studentList(students));
    main.append(det);
  }

  // 확인할 것: 내가 한 약속 중 안 끝난 것 · 학생에게 물어볼 것 · 학생이 헷갈린 말
  private checksOf(l: BriefLesson): string[] {
    const out: string[] = [];
    for (const p of l.promises?.tutor || []) if (p.text && !/done|끝|완료/i.test(p.status || '')) out.push('약속: ' + p.text);
    for (const r of l.rapport || []) if (r.follow_up) out.push('물어볼 것: ' + r.follow_up);
    const st = (l.warmup_struggled || []).map((x) => (typeof x === 'string' ? x : x.kr)).filter(Boolean);
    if (st.length) out.push('헷갈린 말: ' + st.slice(0, 5).join(', '));
    return out;
  }

  private item(r: Row, past: boolean, mark: '' | 'live' | 'next'): HTMLElement {
    const { l } = r;
    const it = h('article', { class: 'th-item' + (past ? ' past' : '') + (mark ? ' ' + mark : '') });
    const lv = (l as unknown as { level?: string }).level || '';
    const level = r.info?.level || (/^L\d/.test(lv) ? lv : '');
    const unit = r.info?.next_unit || (l.next_lesson ? `수업 #${l.next_lesson}` : '');
    const sub = h('span', { class: 'th-sub' });
    if (level) sub.append(h('span', { class: 'th-l' }, level));
    if (unit) sub.append(h('span', {}, '다음 ' + unit));
    const hw = r.hub?.today?.state ? HW_LABEL[r.hub.today.state] : undefined;
    if (hw) sub.append(h('span', { class: 'th-chip ' + hw[1] }, hw[0]));
    if (r.checks.length) sub.append(h('span', { class: 'th-chip todo' }, `확인할 것 ${r.checks.length}`));
    const go = h('button', { type: 'button', class: 'primary' }, '판 열기');
    const cp = h('button', { type: 'button' }, '학생 링크 복사');
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.openStudent(l.folder, r.sid);
    });
    cp.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.copyStudentLink(l.folder);
    });
    const row = h('div', { class: 'th-row', role: 'button', tabindex: '0', 'aria-expanded': 'false' }, h('span', { class: 'th-time' }, l.time || '—'), h('span', { class: 'th-main' }, h('span', { class: 'th-name' }, l.name, mark ? h('em', {}, mark === 'live' ? '지금' : '다음') : ''), sub), h('span', { class: 'th-acts' }, go, cp));
    // 오늘 묶음이 있으면 시간 배분 한 줄 (대화 5 · 과제 10 · 본 30 · 마무리 5)
    void packetFor(l.folder).then((pk) => {
      const segs = pk?.time_split?.segments;
      if (segs?.length) row.querySelector('.th-main')?.append(h('span', { class: 'lr-split' }, segs.map((g) => `${g.label_ko} ${g.minutes}`).join(' · ')));
    });
    const card = h('div', { class: 'th-card', hidden: '' });
    const toggle = () => {
      const open = card.hidden;
      if (this.openCard && this.openCard !== card) {
        this.openCard.hidden = true;
        this.openCard.parentElement?.querySelector('.th-row')?.setAttribute('aria-expanded', 'false');
        this.stopPeek();
      }
      card.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
      this.openCard = open ? card : null;
      if (open) void this.fillCard(card, r);
      else this.stopPeek();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && e.target === row && (e.preventDefault(), toggle()));
    it.append(row, card);
    return it;
  }

  // ---- 수업 카드: 전 · 중 · 후 ----
  private async fillCard(card: HTMLElement, r: Row) {
    const { l, info } = r;
    card.innerHTML = '';
    const col = (title: string) => {
      const c = h('div', { class: 'th-col' }, h('h3', {}, title));
      card.append(c);
      return c;
    };
    const line = (c: HTMLElement, label: string, text: string, cls = '') => {
      if (!text) return;
      c.append(h('p', { class: 'th-line ' + cls }, h('b', {}, label), text));
    };
    const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
    // 전
    const pre = col('수업 전');
    const core = l.last_core;
    const last = [core?.overview, ...(core?.taught?.length ? ['배운 것: ' + core.taught.slice(0, 5).join(', ')] : []), ...(core?.corrections?.length ? ['고친 것: ' + core.corrections.slice(0, 2).join(', ')] : [])].filter((x): x is string => !!x).slice(0, 3);
    pre.append(h('p', { class: 'th-k' }, `지난 수업${l.last_lesson ? ' #' + l.last_lesson : ''}${l.last_date ? ' · ' + l.last_date.slice(5).replace('-', '/') : ''}`));
    if (last.length) for (const t of last) pre.append(h('p', { class: 'th-li' }, t));
    else pre.append(h('p', { class: 'empty' }, '지난 수업 기록이 아직 없어요.'));
    const plan = (l.prep?.summary || []).map((x) => x.replace(/`|\*\*/g, ''));
    pre.append(h('p', { class: 'th-k' }, '오늘 수업안'));
    if (plan.length) for (const t of plan.slice(0, 3)) pre.append(h('p', { class: 'th-li' }, t));
    else if (l.next_focus) pre.append(h('p', { class: 'th-li' }, l.next_focus));
    else pre.append(h('p', { class: 'empty' }, '오늘 수업안이 아직 없어요.'));
    const planLinks = Object.values(l.prep?.files || {}).filter((f) => !!f?.link);
    if (planLinks.length) {
      const a = h('p', { class: 'th-links' });
      for (const f of planLinks.slice(0, 3)) a.append(link(f.link as string, f.name || '수업안'));
      pre.append(a);
    }
    line(pre, '피할 주제', list(info?.avoid_topics).join(', '), 'warn');
    line(pre, '알아 둘 것', [...list(info?.know), ...list(info?.memo).slice(-2)].slice(0, 3).join(' · '));
    if (r.checks.length) {
      pre.append(h('p', { class: 'th-k' }, `확인할 것 ${r.checks.length}`));
      for (const c of r.checks) pre.append(h('p', { class: 'th-li' }, c));
    }
    // 중
    const mid = col('수업 중');
    const go = h('button', { type: 'button', class: 'primary big' }, '판 열기');
    go.addEventListener('click', () => void this.openStudent(l.folder, r.sid));
    const dot = h('p', { class: 'th-presence' }, h('i', { class: 'dot off' }), h('span', {}, '학생 접속 확인 중…'));
    const rec = h('p', { class: 'th-line' }, h('b', {}, '녹화'), h('span', {}, '확인 중…'));
    mid.append(go, dot, rec);
    // 후
    const post = col('수업 후');
    const hw = r.hub?.today?.state ? HW_LABEL[r.hub.today.state] : undefined;
    if (hw) line(post, '과제', hw[0] + (r.hub?.today?.est ? ` · 예상 ${r.hub.today.est}분` : ''), hw[1] === 'bad' ? 'warn' : '');
    else line(post, '과제', l.promises?.submissions || '과제 상태는 숙제 연결이 있어야 나와요', 'mute');
    const docs = h('p', { class: 'th-links' });
    if (l.links?.lesson_doc) docs.append(link(l.links.lesson_doc, '지난 수업 정리 문서'));
    if (l.links?.folder) docs.append(link(l.links.folder, '학생 폴더'));
    docs.append(link(HUB_URL, '허브에서 보기'));
    post.append(docs);
    const boards = loadIndex().filter((b) => folderForBoard(b.id) === l.folder || (!!r.sid && b.student === r.sid));
    if (boards.length) {
      post.append(h('p', { class: 'th-k' }, '지난 판'));
      for (const b of boards.slice(0, 3)) post.append(h('a', { class: 'th-board', href: `#/b/${b.id}?r=t` }, fmtDateTime(b.lastAt || b.createdAt)));
    }
    // 이 기기의 녹화 상태 + 학생 접속(서버가 있을 때 판 방을 잠깐 엿봄)
    const tag = r.sid.replace(/[^\w-]/g, '');
    const recs = (await listSessions().catch(() => [])).filter((x) => x.tag === tag);
    const x = recs[0];
    rec.lastChild!.textContent = !x ? '이 기기에서 한 녹화 없음' : `${fmtDateTime(x.startedAt)} · ${x.uploaded ? '드라이브에 올라감' : x.ended ? '올리는 중' : '녹화 중'}`;
    if (!card.isConnected || card.hidden) return;
    await ensureClassCode(l.folder);
    if (!card.isConnected || card.hidden) return;
    this.watchStudent(boardIdFor(l.folder), dot);
  }

  // 판 방의 접속자를 읽기만 한다 (내 상태는 알리지 않음). 서버 주소가 없으면 안내만
  private watchStudent(bid: string, dot: HTMLElement) {
    this.stopPeek();
    const set = (on: boolean, text: string) => {
      dot.innerHTML = '';
      dot.append(h('i', { class: 'dot ' + (on ? 'on' : 'off') }), h('span', {}, text));
    };
    const srv = getServerUrl();
    if (!srv) return set(false, '학생 접속은 서버에 연결해야 보여요 (판 안에서는 보여요)');
    try {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(srv.replace(/\/+$/, ''), 'kwd-' + bid, doc, { connect: true });
      provider.awareness.setLocalState(null);
      this.peek = { provider, doc };
      const upd = () => {
        const n = Array.from(provider.awareness.getStates().values()).filter((s) => (s as { role?: string }).role === 'student').length;
        set(n > 0, n > 0 ? `학생 접속 중${n > 1 ? ' ' + n : ''}` : provider.wsconnected ? '학생 아직 안 들어왔어요' : '서버에 연결 중…');
      };
      provider.awareness.on('change', upd);
      provider.on('status', upd);
      upd();
    } catch {
      set(false, '접속 상태를 읽지 못했어요');
    }
  }
  private stopPeek() {
    if (!this.peek) return;
    try {
      this.peek.provider.destroy();
      this.peek.doc.destroy();
    } catch {
      /* ignore */
    }
    this.peek = null;
  }

  private studentList(students: StudentEntry[]): HTMLElement {
    const all = h('section', { class: 'home-sec' });
    const search = h('input', { type: 'search', class: 'home-search', placeholder: `학생 ${students.length}명 중 찾기`, 'aria-label': '학생 찾기', lang: 'ko' }) as HTMLInputElement;
    const list = h('div', { class: 'student-list' });
    const draw = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const rows = students.filter((s) => !q || s.folder.toLowerCase().includes(q)).slice(0, q ? 60 : 12);
      for (const s of rows) {
        const r = h('button', { type: 'button', class: 'student-row' }, h('span', { class: 'sr-name' }, s.name), h('span', { class: 'sr-meta' }, [s.trial ? '체험' : '', s.lessons ? `지난 #${s.lessons}` : '', s.lastDate ? s.lastDate.slice(5).replace('-', '/') : ''].filter(Boolean).join(' · ') + ' ›'));
        r.addEventListener('click', () => this.openStudent(s.folder, s.id));
        list.append(r);
      }
      if (!rows.length) list.append(h('p', { class: 'empty' }, '찾는 학생이 없어요.'));
      if (!q && students.length > 12) list.append(h('p', { class: 'home-note' }, '최근 수업 순 12명 · 이름으로 찾으면 전부 · 학생 표(_roster.json)가 생기면 목표 × 수준 표로 보여요'));
    };
    search.addEventListener('input', draw);
    all.append(h('h2', {}, '학생'), search, list);
    draw();
    return all;
  }

  // 가로 = 수준(단계 씨앗~나무), 세로 = 목표(수업 목적). 칸마다 학생 카드: 이름 · 나라 · 꼭 알아야 할 것 1~2줄
  private rosterGrid(roster: Roster, students: StudentEntry[]): HTMLElement {
    const sec = h('section', { class: 'home-sec roster' });
    const byFolder = new Map(students.map((s) => [s.folder, s]));
    const cutoff = ymd(new Date(Date.now() - 60 * 86400000));
    // 상태: 선생님이 정한 것 > 자동화의 active > 최근 60일 수업
    const statusOf = (r: RosterStudent): RosterStatus => (r.returning ? 'active' : r.status) || (r.active !== undefined ? (r.active ? 'active' : 'paused') : r.last_lesson && r.last_lesson >= cutoff ? 'active' : 'paused');
    const isActive = (r: RosterStudent) => statusOf(r) === 'active';
    type View = 'now' | 'all' | 'arch';
    let view: View = roster.students.some(isActive) ? 'now' : 'all';
    let dragging = false;
    let dragFolder = '';
    const search = h('input', { type: 'search', class: 'home-search roster-search', placeholder: '이름·나라로 찾기', 'aria-label': '학생 찾기', lang: 'ko' }) as HTMLInputElement;
    const chips: Record<View, HTMLButtonElement> = {
      now: h('button', { type: 'button', class: 'rs-chip' }) as HTMLButtonElement,
      all: h('button', { type: 'button', class: 'rs-chip' }) as HTMLButtonElement,
      arch: h('button', { type: 'button', class: 'rs-chip ghost' }) as HTMLButtonElement,
    };
    const head = h('div', { class: 'roster-head' }, h('h2', {}, '학생'), h('div', { class: 'rs-chips' }, chips.now, chips.all, chips.arch), search);
    const grid = h('div', { class: 'roster-wrap' });
    const purposes = [...roster.purposes];
    const known = new Set(purposes.map((p) => p.key));
    if (roster.students.some((r) => !r.purpose || !known.has(r.purpose))) purposes.push({ key: '', label: '목적 미정' });
    const stageNames = (roster.levels || []).map((l) => l.label);
    const rows = [...stageNames, ''];
    const draw = () => {
      const n = (st: RosterStatus) => roster.students.filter((r) => statusOf(r) === st).length;
      chips.now.textContent = `수업 중 ${n('active')}`;
      chips.all.textContent = `쉬는 학생까지 ${n('active') + n('paused')}`;
      chips.arch.textContent = `보관함 ${n('archived')}`;
      chips.arch.hidden = !n('archived') && view !== 'arch';
      for (const k of Object.keys(chips) as View[]) chips[k].classList.toggle('on', view === k);
      const q = search.value.trim().toLowerCase();
      const inView = (r: RosterStudent) => (view === 'arch' ? statusOf(r) === 'archived' : view === 'all' ? statusOf(r) !== 'archived' : isActive(r));
      const list = roster.students.filter((r) => (q ? `${r.name} ${r.country || ''} ${r.folder}`.toLowerCase().includes(q) : inView(r)));
      const cell = (r: RosterStudent) => [stageNames.includes(r.stage || '') ? r.stage! : '', r.purpose && known.has(r.purpose) ? r.purpose : ''];
      // 끄는 중에는 빈 줄·칸도 다 보여서 어디로든 옮길 수 있게
      // 행 = 목표(목적), 열 = 수준(단계 씨앗~나무). 수준 열은 늘 보이고 '단계 미정'은 쓰일 때만
      const rws = dragging ? purposes : purposes.filter((p) => list.some((r) => cell(r)[1] === p.key));
      const cols = dragging ? rows : rows.filter((st) => st !== '' || list.some((r) => cell(r)[0] === st));
      grid.innerHTML = '';
      if (!list.length) {
        grid.append(h('p', { class: 'empty' }, '찾는 학생이 없어요.'));
        return;
      }
      const t = h('div', { class: 'roster-grid' });
      t.style.gridTemplateColumns = `84px repeat(${cols.length}, minmax(150px, 1fr))`;
      t.append(h('div', { class: 'rg-corner' }));
      for (const st of cols) t.append(h('div', { class: 'rg-col' }, h('span', {}, st || '단계 미정'), h('b', {}, String(list.filter((r) => cell(r)[0] === st).length))));
      for (const c of rws) {
        t.append(h('div', { class: 'rg-row' }, h('span', {}, c.label), h('b', {}, String(list.filter((r) => cell(r)[1] === c.key).length))));
        for (const st of cols) {
          const box = h('div', { class: 'rg-cell', 'data-stage': st, 'data-purpose': c.key });
          box.addEventListener('dragover', (e) => {
            e.preventDefault();
            box.classList.add('drop');
          });
          box.addEventListener('dragleave', () => box.classList.remove('drop'));
          box.addEventListener('drop', (e) => {
            e.preventDefault();
            const f = e.dataTransfer?.getData('text/kwd-folder') || dragFolder;
            const r = roster.students.find((x) => x.folder === f);
            dragging = false;
            if (r) void move(r, { stage: st, purpose: c.key });
            else draw();
          });
          const here = list.filter((r) => cell(r)[0] === st && cell(r)[1] === c.key).sort((a, b) => (b.last_lesson || '').localeCompare(a.last_lesson || ''));
          for (const r of here) {
            const cd = this.rosterCard(r, byFolder.get(r.folder), statusOf(r), (e) => void move(r, e), purposes, rows);
            cd.draggable = true;
            cd.addEventListener('dragstart', (e) => {
              dragFolder = r.folder;
              e.dataTransfer?.setData('text/kwd-folder', r.folder);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
              window.setTimeout(() => {
                dragging = true;
                draw();
              }, 0);
            });
            cd.addEventListener('dragend', () => {
              if (!dragging) return;
              dragging = false;
              draw();
            });
            box.append(cd);
          }
          t.append(box);
        }
      }
      grid.append(t);
    };
    // 단계·목적 고치기: 카드를 다른 칸에 끌어 놓거나 카드의 ⋯ → 저장은 Student_Lessons/_roster_teacher.json (자동화보다 우선)
    const move = async (r: RosterStudent, e: RosterEdit) => {
      const edit: RosterEdit = {};
      if (e.stage !== undefined && (r.stage || '') !== e.stage) {
        edit.stage = e.stage;
        edit.stage_from = r.stage || '';
      }
      if (e.purpose !== undefined && (r.purpose || '') !== e.purpose) edit.purpose = e.purpose;
      if (e.trial !== undefined && !!r.trial !== e.trial) edit.trial = e.trial;
      if (e.status !== undefined && statusOf(r) !== e.status) edit.status = e.status;
      if (e.reason !== undefined && (r.reason || '') !== e.reason) edit.reason = e.reason;
      if (!Object.keys(edit).length) return draw();
      Object.assign(r, edit);
      draw();
      const ok = await saveRosterEdit(r.folder, edit);
      const st = { active: '', paused: ' · 쉬는 중', archived: ' · 보관함으로' }[statusOf(r)];
      toast(ok ? `${r.name}: ${r.stage || '단계 미정'} · ${purposes.find((p) => p.key === (r.purpose || ''))?.label || '목적 미정'}${r.trial ? ' · 체험' : ''}${st}` : '저장하지 못했어요 (폴더 쓰기 허용 필요)');
    };
    for (const k of Object.keys(chips) as View[]) chips[k].addEventListener('click', () => ((view = k), draw()));
    search.addEventListener('input', draw);
    sec.append(head, grid, h('p', { class: 'home-note roster-tip' }, '카드를 다른 칸으로 끌어 놓거나 카드의 ⋯ 를 누르면 단계·목적·상태를 바꿀 수 있어요. 이 기기에만 저장돼요(PC에는 아직 반영 안 됨).'));
    draw();
    return sec;
  }

  private rosterCard(r: RosterStudent, s: StudentEntry | undefined, status: RosterStatus, onSave: (e: RosterEdit) => void, purposes: Array<{ key: string; label: string }>, stages: string[]): HTMLElement {
    const active = status === 'active';
    const know = (r.know || []).filter(Boolean).slice(0, 2);
    const more = h('span', { class: 'rs-more', role: 'button', tabindex: '0', title: '단계·목적 바꾸기' }, '⋯');
    const card = h(
      'div',
      { class: 'rs-card' + (active || status === 'archived' ? '' : ' past') + (r.trial ? ' trial' : ''), role: 'button', tabindex: '0', title: [r.step, r.last_lesson ? `마지막 수업 ${r.last_lesson}` : ''].filter(Boolean).join(' · ') },
      h('span', { class: 'rs-top' }, h('span', { class: 'rs-name' }, r.name), r.country ? h('span', { class: 'rs-cc' }, r.country.toUpperCase()) : '', r.trial ? h('span', { class: 'rs-tag' }, '체험') : '', r.returning ? h('span', { class: 'rs-tag', title: '쉬던 학생인데 수업이 다시 잡혔어요' }, '복귀') : '', more),
      ...(status === 'archived'
        ? [h('span', { class: 'rs-know' }, [r.stage || '단계 미정', s?.lessons || r.lessons ? `수업 ${s?.lessons || r.lessons}회` : '', r.last_lesson ? `마지막 ${r.last_lesson}` : ''].filter(Boolean).join(' · ')), r.reason ? h('span', { class: 'rs-know sub' }, r.reason) : '']
        : know.map((k, i) => h('span', { class: i ? 'rs-know sub' : 'rs-know' }, k))),
    );
    card.classList.toggle('arch', status === 'archived');
    const sid = s?.id || (/\(([^)]+)\)/.exec(r.folder) || [])[1] || '';
    const open = () => void this.showStudent(r, sid, purposes);
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.rs-more, .rs-pick')) return;
      open();
    });
    card.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === card && open());
    const pick = () => {
      const old = card.querySelector('.rs-pick');
      if (old) return old.remove();
      document.querySelectorAll('.rs-pick').forEach((x) => x.remove());
      const box = h('div', { class: 'rs-pick' });
      let stage = r.stage && stages.includes(r.stage) ? r.stage : '';
      let purpose = r.purpose && purposes.some((p) => p.key === r.purpose) ? r.purpose : '';
      const row = (label: string, opts: Array<[string, string]>, cur: () => string, set: (v: string) => void) => {
        const line = h('div', { class: 'rs-pick-row' }, h('span', { class: 'rs-pick-l' }, label));
        for (const [v, t] of opts) {
          const b = h('button', { type: 'button', class: 'rs-opt' + (cur() === v ? ' on' : '') }, t);
          b.addEventListener('click', () => {
            set(v);
            line.querySelectorAll('.rs-opt').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
          });
          line.append(b);
        }
        return line;
      };
      let trial = !!r.trial;
      let st: RosterStatus = status;
      const reason = h('input', { type: 'text', class: 'rs-reason', placeholder: '보관 이유 한 줄 (선택)', value: r.reason || '' }) as HTMLInputElement;
      reason.hidden = st !== 'archived';
      reason.addEventListener('keydown', (e) => e.stopPropagation());
      reason.addEventListener('click', (e) => e.stopPropagation());
      const done = h('button', { type: 'button', class: 'rs-opt save' }, '저장');
      done.addEventListener('click', () => onSave({ stage, purpose, trial, status: st, reason: st === 'archived' ? reason.value.trim() : r.reason || '' }));
      box.append(
        row('단계', [...stages.filter(Boolean).map((x) => [x, x] as [string, string]), ['', '미정']], () => stage, (v) => (stage = v)),
        row('목적', [...purposes.filter((p) => p.key).map((p) => [p.key, p.label] as [string, string]), ['', '미정']], () => purpose, (v) => (purpose = v)),
        row('체험', [['n', '아니요'], ['y', '체험 학생']], () => (trial ? 'y' : 'n'), (v) => (trial = v === 'y')),
        row('상태', [['active', '수업 중'], ['paused', '쉬는 중'], ['archived', '보관']], () => st, (v) => {
          st = v as RosterStatus;
          reason.hidden = st !== 'archived';
        }),
        reason,
        done,
      );
      card.append(box);
    };
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      pick();
    });
    return card;
  }

  // 학생 전체 표에서 학생을 누르면: 같은 수업 카드를 표 위에 연다 (오늘 수업이 아니어도)
  private async showStudent(r: RosterStudent, sid: string, _purposes: Array<{ key: string; label: string }>) {
    this.root.querySelector('.stu-panel')?.remove();
    const infos = await loadStudentInfo().catch(() => [] as StudentInfo[]);
    const l: BriefLesson = { time: '', name: r.name, folder: r.folder, last_date: r.last_lesson, last_lesson: r.lessons };
    const row: Row = { l, info: infoFor(infos, r.folder, r.name), sid, checks: [] };
    const know = (r.know || []).filter(Boolean);
    const panel = h('section', { class: 'th-card stu-panel' });
    const close = h('button', { type: 'button', class: 'th-close' }, '닫기');
    close.addEventListener('click', () => panel.remove());
    this.root.querySelector('.th-all')?.prepend(panel);
    const det = this.root.querySelector('.th-all') as HTMLDetailsElement | null;
    if (det) det.open = true;
    await this.fillCard(panel, row);
    panel.prepend(h('div', { class: 'th-panel-head' }, h('h2', {}, r.name + ' · ' + [r.stage || '단계 미정', r.country ? r.country.toUpperCase() : ''].filter(Boolean).join(' · ')), close));
    if (know.length) panel.querySelector('.th-col')?.append(h('p', { class: 'th-line' }, h('b', {}, '표의 메모'), know.slice(0, 2).join(' · ')));
    panel.scrollIntoView?.({ block: 'nearest' });
  }

  // ---- ⚙ 설정: 연결 · 폴더 · 방 코드 · 서버 · 체험 · 지난 수업 ----
  private renderSettings(box: HTMLElement, connected: boolean, folderName: string) {
    const part = (title: string) => {
      const s = h('section', { class: 'th-set' }, h('h3', {}, title));
      box.append(s);
      return s;
    };
    const srv = getServerUrl();
    // 연결
    const c = part('연결');
    c.append(h('p', { class: 'th-line' }, gasReady() ? '구글 드라이브: ' + (connected ? '연결됨' : '연결 안 됨') : '구글 드라이브: 이 기기엔 열쇠가 없어요 (선생님 링크를 한 번 열면 저절로 연결돼요)'));
    const srvBtn = h('button', { type: 'button', class: 'linkish' }, srv ? '여러 기기 연결됨 · 바꾸기' : '이 기기에만 저장 중 · 여러 기기 연결');
    const srvForm = h('form', { class: 'open-code', hidden: '' });
    const srvInput = h('input', { type: 'url', placeholder: 'wss://… (비우면 이 기기에서만)', value: srv, 'aria-label': '서버 주소' }) as HTMLInputElement;
    srvForm.append(srvInput, h('button', { type: 'submit' }, '저장'));
    srvForm.addEventListener('submit', (e) => {
      e.preventDefault();
      setServerUrl(srvInput.value.trim());
      toast(srvInput.value.trim() ? '저장했어요' : '서버 없이 씁니다');
      void this.render();
    });
    srvBtn.addEventListener('click', () => {
      srvForm.hidden = !srvForm.hidden;
      if (!srvForm.hidden) srvInput.focus();
    });
    c.append(srvBtn, srvForm);
    // 방 코드로 열기 · 체험
    const o = part('판 열기');
    const open = h('form', { class: 'open-code' });
    const codeInput = h('input', { type: 'text', placeholder: '받은 판 링크나 방 코드', 'aria-label': '방 코드' }) as HTMLInputElement;
    open.append(codeInput, h('button', { type: 'submit' }, '열기'));
    open.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = codeInput.value.trim();
      if (!v) return;
      const m = /#\/b\/([a-z0-9]+)(\?.*)?/i.exec(v);
      if (m) location.hash = `#/b/${m[1]}${m[2] || '?r=t'}`;
      else location.hash = `#/b/${v}?r=t`;
    });
    o.append(open, h('a', { class: 'linkish home-demo', href: '#/demo' }, '체험 (모든 기능, 가상 학생)'));
    this.renderManual(o);
    // 컴퓨터 폴더 (열쇠가 없을 때만 필요)
    if (canUseFolder() && !gasReady()) this.renderAdvanced(part('컴퓨터 폴더 직접 연결'), folderName);
    // 지난 수업 (이름 · 날짜). 목록에서 빼기는 '정리'를 켠 뒤에만
    this.renderBoards(part('지난 수업'));
  }

  private renderAdvanced(box: HTMLElement, folderName: string) {
    const b = h('button', { type: 'button' }, folderName && !isDemo() ? `KWD 폴더: ${folderName} · 바꾸기` : '폴더 연결하기');
    const msg = h('p', { class: 'home-warn', hidden: '' });
    const show = (r: { ok: boolean; name?: string; message?: string }) => {
      if (r.ok) {
        toast(`연결했어요: ${r.name}`);
        void this.render();
        return;
      }
      if (!r.message) return;
      msg.hidden = false;
      msg.textContent = r.message;
    };
    b.addEventListener('click', async () => {
      if (folderName && !isDemo()) await forgetFolder();
      show(await pickWorkFolder());
    });
    box.addEventListener('dragover', (e) => e.preventDefault());
    box.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (e.dataTransfer) show(await useDroppedItems(e.dataTransfer.items));
    });
    box.append(h('p', { class: 'home-note' }, 'KWD 안의 work 폴더를 고르거나 끌어다 놓으세요. 선생님 링크가 있으면 필요 없어요.'), b, msg);
  }

  // 폴더 없이: 학생 번호로 새 판
  private renderManual(box: HTMLElement) {
    const form = h('form', { class: 'open-code' });
    const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: '학생 번호', 'aria-label': '학생 번호', autocomplete: 'off' }) as HTMLInputElement;
    form.append(input, h('button', { type: 'submit' }, '새 수업'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const student = input.value.trim();
      if (!student) return input.focus();
      location.hash = `#/b/${randomId(10)}?r=t&st=${encodeURIComponent(student)}`;
    });
    box.append(form);
  }

  private renderBoards(box: HTMLElement) {
    const boards = loadIndex();
    if (!boards.length) return void box.append(h('p', { class: 'empty' }, '이 기기에서 연 판이 아직 없어요.'));
    const edit = h('button', { type: 'button', class: 'linkish' }, '정리하기');
    const ul = h('div', { class: 'board-list' });
    let editing = false;
    const draw = () => {
      ul.innerHTML = '';
      for (const b of boards.slice(0, 40)) {
        const folder = folderForBoard(b.id);
        const nm = folder ? folder.replace(/\s*\(.*\)$/, '') : (b.student && this.names.get(b.student)) || '수업 판';
        const row = h('div', { class: 'th-past' }, h('a', { href: `#/b/${b.id}?r=t` }, h('span', { class: 'br-student' }, nm), h('span', { class: 'br-date' }, fmtDateTime(b.lastAt || b.createdAt))));
        if (editing) {
          const del = h('button', { type: 'button', class: 'br-del' }, '목록에서 빼기');
          del.addEventListener('click', () => {
            if (!del.classList.contains('confirm')) {
              del.classList.add('confirm');
              del.textContent = '정말 빼기 (판은 그대로)';
              return;
            }
            saveIndex(loadIndex().filter((x) => x.id !== b.id));
            void this.render();
          });
          row.append(del);
        }
        ul.append(row);
      }
    };
    edit.addEventListener('click', () => {
      editing = !editing;
      edit.textContent = editing ? '정리 끝' : '정리하기';
      draw();
    });
    box.append(edit, ul);
    draw();
  }

  destroy() {
    this.alive = false;
    this.stopPeek();
    this.root.remove();
  }
}
