// 시작 화면: KWD 폴더가 연결돼 있으면 오늘 수업 시간표와 학생 목록, 아니면 폴더 연결 한 번.
// 학생을 누르면 그 학생의 오늘 판이 열리고, 브리핑·수업안·로드맵·지난 수업이 선생님 화면에만 붙는다.
import { loadIndex, saveIndex, randomId, getServerUrl, setServerUrl } from './store';
import { h, fmtDateTime, toast } from './ui';
import { canUseFolder, folderState, pickWorkFolder, useDroppedItems, PICKER_BLOCKED, reopenFolder, listStudents, briefFor, boardIdFor, ensureClassCode, rememberBoardFolder, folderForBoard, forgetFolder, ymd, packetFor, isDemo, loadRoster, saveRosterEdit, loadRosterTeacher, type StudentEntry, type BriefLesson, type Roster, type RosterStudent, type RosterEdit, type RosterStatus } from './kwdfolder';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export class HomeScreen {
  readonly root: HTMLElement;
  private alive = true;

  constructor() {
    this.root = h('div', { class: 'home' });
    void this.render();
  }

  private async openStudent(folder: string, id: string) {
    await ensureClassCode(folder);
    const bid = boardIdFor(folder);
    rememberBoardFolder(bid, folder);
    location.hash = `#/b/${bid}?r=t&st=${encodeURIComponent(id || folder)}`;
  }

  private async render() {
    this.root.innerHTML = '';
    const d = new Date();
    const head = h('div', { class: 'home-head' }, h('h1', {}, 'KWD 클래스룸'), h('span', { class: 'home-date' }, `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}`));
    this.root.append(head);
    const main = h('div', { class: 'home-main' });
    this.root.append(main);

    const fs = canUseFolder() ? await folderState() : { state: 'none' as const, name: '' };
    if (!this.alive) return;
    if (canUseFolder() && fs.state === 'granted') await this.renderConnected(main);
    else if (canUseFolder() && (fs.state === 'prompt' || fs.state === 'denied')) {
      const card = h('div', { class: 'home-card' });
      const b = h('button', { type: 'button', class: 'primary big' }, 'KWD 폴더 열기');
      b.addEventListener('click', async () => {
        if (await reopenFolder()) void this.render();
        else toast('폴더를 열지 못했어요. 다시 골라 주세요.');
      });
      card.append(h('p', { class: 'home-lead' }, `오늘 수업과 학생 자료를 보려면 한 번 눌러 주세요 (${fs.name}).`), b);
      main.append(card);
      this.renderManual(main, true);
    } else {
      if (canUseFolder()) {
        const card = h('div', { class: 'home-card' });
        const b = h('button', { type: 'button', class: 'primary big' }, 'KWD 폴더 연결하기');
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
          if (r.message === PICKER_BLOCKED) {
            const copy = h('button', { type: 'button', class: 'linkish' }, '이 주소 복사');
            copy.addEventListener('click', () => void navigator.clipboard?.writeText(location.href.split('#')[0]).then(() => toast('주소를 복사했어요. 크롬 주소창에 붙여 넣으세요.')));
            msg.append(' ', copy);
          }
        };
        b.addEventListener('click', async () => show(await pickWorkFolder()));
        // 폴더를 끌어다 놓아도 연결
        card.addEventListener('dragover', (e) => {
          e.preventDefault();
          card.classList.add('drop');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drop'));
        card.addEventListener('drop', async (e) => {
          e.preventDefault();
          card.classList.remove('drop');
          if (e.dataTransfer) show(await useDroppedItems(e.dataTransfer.items));
        });
        const demo = h('a', { class: 'linkish home-demo', href: '#/demo' }, '폴더 없이 먼저 체험해 보기 →');
        card.append(h('p', { class: 'home-lead' }, '한 번만 연결하면 오늘 수업 시간표와 학생별 브리핑·수업안·로드맵·지난 수업이 저절로 붙어요.'), b, msg, h('p', { class: 'home-note' }, 'KWD 안의 work 폴더를 고르거나 이 칸에 끌어다 놓으세요 (C:\\KWD\\work 또는 구글 드라이브 00_KWD_거울). 크롬·엣지에서 돼요. 파일은 이 브라우저 안에서만 읽어요.'), demo);
        main.append(card);
      }
      this.renderManual(main, canUseFolder());
    }
    this.renderBoards(main);
    this.renderFoot(fs.state !== 'none' ? fs.name : '');
  }

  private async renderConnected(main: HTMLElement) {
    const today = ymd();
    const [brief, students] = await Promise.all([briefFor(today).catch(() => null), listStudents().catch(() => [] as StudentEntry[])]);
    if (!this.alive) return;
    const byFolder = new Map(students.map((s) => [s.folder, s]));
    const edits = await loadRosterTeacher();
    // 오늘 수업
    const sec = h('section', { class: 'home-sec' });
    const lessons = brief?.lessons || [];
    sec.append(h('h2', {}, lessons.length ? `오늘 수업 ${lessons.length}개` : '오늘 수업'));
    if (!lessons.length) sec.append(h('p', { class: 'empty' }, brief ? '오늘 브리핑에 수업이 없어요.' : '오늘 아침 브리핑(brief_data.json)이 아직 없어요. 아래 목록에서 학생을 고르세요.'));
    const now = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    let nextMarked = false;
    for (const l of lessons) {
      const s = byFolder.get(l.folder);
      const done = this.isPast(l.time, now);
      const isNext = !done && !nextMarked;
      if (isNext) nextMarked = true;
      sec.append(this.lessonRow(l, s, done, isNext, edits[l.folder]?.trial));
    }
    main.append(sec);

    // 학생 전체: 학생 표(_roster.json)가 있으면 목적 × 단계 표, 없으면 찾기 목록
    const roster = await loadRoster();
    if (!this.alive) return;
    if (roster && roster.students.length) main.append(this.rosterGrid(roster, students));
    else main.append(this.studentList(students));
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
      if (!q && students.length > 12) list.append(h('p', { class: 'home-note' }, '최근 수업 순 12명 · 이름으로 찾으면 전부 · 학생 표(_roster.json)가 생기면 목적 × 단계 표로 보여요'));
    };
    search.addEventListener('input', draw);
    all.append(h('h2', {}, '학생'), search, list);
    draw();
    return all;
  }

  // 가로 = 수업 목적, 세로 = 단계(씨앗~나무). 칸마다 학생 카드: 이름 · 나라 · 꼭 알아야 할 것 1~2줄
  private rosterGrid(roster: Roster, students: StudentEntry[]): HTMLElement {
    const sec = h('section', { class: 'home-sec roster' });
    const byFolder = new Map(students.map((s) => [s.folder, s]));
    const cutoff = ymd(new Date(Date.now() - 60 * 86400000));
    // 상태: 선생님이 정한 것 > 자동화의 active > 최근 60일 수업
    const statusOf = (r: RosterStudent): RosterStatus => r.status || (r.active !== undefined ? (r.active ? 'active' : 'paused') : r.last_lesson && r.last_lesson >= cutoff ? 'active' : 'paused');
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
      const cols = dragging ? purposes : purposes.filter((p) => list.some((r) => cell(r)[1] === p.key));
      // 단계 6줄(씨앗~나무)은 늘 보인다 — 비어 있어도 거기로 옮길 수 있게. '단계 미정'만 있을 때 보인다
      const rws = dragging ? rows : rows.filter((st) => st !== '' || list.some((r) => cell(r)[0] === st));
      grid.innerHTML = '';
      if (!list.length) {
        grid.append(h('p', { class: 'empty' }, '찾는 학생이 없어요.'));
        return;
      }
      const t = h('div', { class: 'roster-grid' });
      t.style.gridTemplateColumns = `76px repeat(${cols.length}, minmax(188px, 1fr))`;
      t.append(h('div', { class: 'rg-corner' }));
      for (const c of cols) t.append(h('div', { class: 'rg-col' }, h('span', {}, c.label), h('b', {}, String(list.filter((r) => cell(r)[1] === c.key).length))));
      for (const st of rws) {
        t.append(h('div', { class: 'rg-row' }, h('span', {}, st || '단계 미정'), h('b', {}, String(list.filter((r) => cell(r)[0] === st).length))));
        for (const c of cols) {
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
      if (e.stage !== undefined && (r.stage || '') !== e.stage) edit.stage = e.stage;
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
    sec.append(head, grid, h('p', { class: 'home-note roster-tip' }, '카드를 다른 칸으로 끌어 놓거나 카드의 ⋯ 를 누르면 단계·목적·상태를 바꿀 수 있어요. 고친 값은 다음 자동 갱신 때도 그대로 남아요.'));
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
      h('span', { class: 'rs-top' }, h('span', { class: 'rs-name' }, r.name), r.country ? h('span', { class: 'rs-cc' }, r.country.toUpperCase()) : '', r.trial ? h('span', { class: 'rs-tag' }, '체험') : '', more),
      ...(status === 'archived'
        ? [h('span', { class: 'rs-know' }, [r.stage || '단계 미정', s?.lessons || r.lessons ? `수업 ${s?.lessons || r.lessons}회` : '', r.last_lesson ? `마지막 ${r.last_lesson}` : ''].filter(Boolean).join(' · ')), r.reason ? h('span', { class: 'rs-know sub' }, r.reason) : '']
        : know.map((k, i) => h('span', { class: i ? 'rs-know sub' : 'rs-know' }, k))),
    );
    card.classList.toggle('arch', status === 'archived');
    const open = () => this.openStudent(r.folder, s?.id || (/\(([^)]+)\)/.exec(r.folder) || [])[1] || '');
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

  private isPast(time: string, now: string): boolean {
    // 수업은 50분: 시작 + 50분이 지났으면 지난 수업
    const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
    if (!m) return false;
    const end = Number(m[1]) * 60 + Number(m[2]) + 50;
    const [nh, nm] = now.split(':').map(Number);
    return nh * 60 + nm > end;
  }

  private lessonRow(l: BriefLesson, s: StudentEntry | undefined, done: boolean, isNext: boolean, trialEdit?: boolean): HTMLElement {
    const trial = trialEdit ?? (s?.trial || (!l.last_lesson && /pending/.test(l.folder)));
    const meta = [l.next_lesson ? `오늘 #${l.next_lesson}` : '', l.level_hint ? l.level_hint.replace(/\s*\(.*\)/, '') : '', trial ? '체험' : ''].filter(Boolean).join(' · ');
    const goal = (l.prep?.summary || [])[0]?.replace(/^오늘 목표:\s*/, '').replace(/`|\*\*/g, '') || l.next_focus || '';
    const r = h('button', { type: 'button', class: 'lesson-row' + (done ? ' done' : '') + (isNext ? ' next' : '') }, h('span', { class: 'lr-time' }, l.time), h('span', { class: 'lr-body' }, h('span', { class: 'lr-name' }, l.name), h('span', { class: 'lr-meta' }, meta), goal ? h('span', { class: 'lr-goal' }, goal) : ''), h('span', { class: 'lr-go' }, isNext ? '시작' : '열기'));
    r.addEventListener('click', () => this.openStudent(l.folder, s?.id || (/\(([^)]+)\)/.exec(l.folder) || [])[1] || ''));
    // 오늘 묶음이 있으면 배분 한 줄 (대화 5 · 과제 10 · 본 30 · 마무리 5)
    void packetFor(l.folder).then((pk) => {
      const segs = pk?.time_split?.segments;
      if (segs?.length) r.querySelector('.lr-body')?.append(h('span', { class: 'lr-split' }, segs.map((g) => `${g.label_ko} ${g.minutes}`).join(' · ')));
    });
    return r;
  }

  // 폴더 없이: 학생 번호로 새 판
  private renderManual(main: HTMLElement, secondary = false) {
    const form = h('form', { class: 'new-board' + (secondary ? ' secondary' : '') });
    const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: '학생 번호', 'aria-label': '학생 번호', autocomplete: 'off' }) as HTMLInputElement;
    const btn = h('button', { type: 'submit', class: secondary ? '' : 'primary' }, '새 수업');
    form.append(input, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const student = input.value.trim();
      if (!student) {
        input.focus();
        return;
      }
      location.hash = `#/b/${randomId(10)}?r=t&st=${encodeURIComponent(student)}`;
    });
    main.append(form);
  }

  private renderBoards(main: HTMLElement) {
    const list = loadIndex();
    if (!list.length) return;
    const det = h('details', { class: 'home-boards' });
    det.append(h('summary', {}, `지난 판 ${list.length}`));
    const ul = h('div', { class: 'board-list' });
    for (const b of list.slice(0, 40)) {
      const folder = folderForBoard(b.id);
      const row = h('a', { class: 'board-row', href: `#/b/${b.id}?r=t` });
      row.append(h('span', { class: 'br-student' }, folder ? folder.replace(/\s*\(.*\)$/, '') : b.student ? `학생 ${b.student}` : '판'), h('span', { class: 'br-date' }, fmtDateTime(b.lastAt || b.createdAt)));
      const del = h('button', { type: 'button', class: 'br-del', title: '목록에서 빼기 (판은 지워지지 않음)' }, '×');
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.textContent = '빼기?';
          window.setTimeout(() => {
            del.classList.remove('confirm');
            del.textContent = '×';
          }, 2500);
          return;
        }
        saveIndex(loadIndex().filter((x) => x.id !== b.id));
        void this.render();
      });
      row.append(del);
      ul.append(row);
    }
    det.append(ul);
    main.append(det);
  }

  private renderFoot(folderName: string) {
    const srv = getServerUrl();
    const foot = h('div', { class: 'home-foot' });
    const open = h('form', { class: 'open-code' });
    const codeInput = h('input', { type: 'text', placeholder: '받은 판 링크나 방 코드로 열기', 'aria-label': '방 코드' }) as HTMLInputElement;
    open.append(codeInput, h('button', { type: 'submit' }, '열기'));
    open.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = codeInput.value.trim();
      if (!v) return;
      const m = /#\/b\/([a-z0-9]+)(\?.*)?/i.exec(v);
      if (m) location.hash = `#/b/${m[1]}${m[2] || '?r=t'}`;
      else location.hash = `#/b/${v}?r=t`;
    });
    const links = h('div', { class: 'home-links' });
    const srvBtn = h('button', { type: 'button', class: 'linkish' }, srv ? '여러 기기 연결됨 · 바꾸기' : '이 기기에만 저장 중 · 여러 기기 연결');
    links.append(srvBtn, h('a', { class: 'linkish', href: '#/demo' }, '체험 (모든 기능)'));
    if (folderName && !isDemo()) {
      const fb = h('button', { type: 'button', class: 'linkish' }, `KWD 폴더: ${folderName} · 바꾸기`);
      fb.addEventListener('click', async () => {
        await forgetFolder();
        const r = await pickWorkFolder();
        if (r.message) toast(r.message, 5000);
        void this.render();
      });
      links.append(fb);
    }
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
    foot.append(open, links, srvForm);
    this.root.append(foot);
  }

  destroy() {
    this.alive = false;
    this.root.remove();
  }
}
