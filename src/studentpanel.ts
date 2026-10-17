// '이 학생' 패널 (선생님 화면만): 오늘 · 수업안 · 자료 · 학생 · 지난 수업 · 단어
// KWD 폴더에서 읽은 것을 그대로 보여 주고, 한 번 눌러 판에 넣는다.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { h, fmtDate } from './ui';
import { vocabNote, type StudentMemory } from './memory';
import type { StudentPack, PackFile, BoardData } from './kwdfolder';
import { type HwHistory, type HwMedia, type HwDay, type HwItem } from './homework';

export interface PanelActions {
  insertLine(line: string): void; // 판의 지금 줄 아래에
  placeFile(f: PackFile): Promise<void>; // 자료를 판에 (html=창, pdf=페이지, 그림=사진)
  readLessonDoc(name: string): Promise<string>;
  otherBoards(): Array<{ id: string; createdAt: number }>;
  close(): void;
  previewUrl(f: PackFile): Promise<string>; // 과제 미리 보기 (사진·소리)
  hwConnected(): boolean;
  hwMedia(fileId: string): Promise<{ mime: string; dataUrl: string }>;
  placeData(dataUrl: string, mime: string, name: string): Promise<void>;
  placeText(text: string): void;
  loadHistory(): Promise<HwHistory | null>; // KWD 숙제 앱에서 날마다 과제·피드백
  mediaUrl(m: HwMedia): Promise<{ url: string; mime: string }>;
  startTimer(seconds: number, label: string): void;
  placeMedia(m: HwMedia, label: string): Promise<void>;
}

// 숙제 앱에서 불러온 것 (패널이 다시 그려져도 남게, 이 창에서만)
const hwCache = new Map<string, HwHistory | null>();

export type PanelTab = 'today' | 'plan' | 'hw' | 'student' | 'lessons' | 'vocab';

function mdToEl(text: string, cls = 'mp-md'): HTMLElement {
  const el = h('div', { class: cls });
  // 머리말(--- yaml ---) 빼기
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  el.innerHTML = DOMPurify.sanitize(marked.parse(body, { async: false, gfm: true, breaks: false }) as string, { ADD_ATTR: ['target'] });
  el.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
  });
  return el;
}

export function renderStudentPanel(root: HTMLElement, pack: StudentPack, mem: StudentMemory | null, tab: PanelTab, setTab: (t: PanelTab) => void, act: PanelActions) {
  root.innerHTML = '';
  const b = pack.brief;
  const sub = [b ? `오늘 ${b.time}` : '', b?.next_lesson ? `#${b.next_lesson}` : pack.lessons[0] ? `지난 #${pack.lessons[0].n}` : '', b?.level_hint || ''].filter(Boolean).join(' · ');
  const close = h('button', { type: 'button', class: 'mp-close', title: '닫기' }, '×');
  close.addEventListener('click', () => act.close());
  root.append(h('div', { class: 'mp-head' }, h('strong', {}, pack.name), h('span', { class: 'mp-sub' }, sub), close));

  const has: Record<PanelTab, boolean> = {
    today: !!(b || pack.trialPrep || pack.lessons.length),
    plan: !!(pack.plan || pack.trialPrep || pack.files.length),
    hw: true,
    student: !!(pack.profile || pack.roadmap || pack.status),
    lessons: pack.lessons.length > 0,
    vocab: !!(mem?.vocab.length || pack.db?.vocab.length),
  };
  const labels: Record<PanelTab, string> = { today: '오늘', plan: '수업안·자료', hw: '과제', student: '학생 정보', lessons: '지난 수업', vocab: '단어' };
  if (!has[tab]) tab = (Object.keys(has) as PanelTab[]).find((k) => has[k]) || 'today';
  const tabs = h('div', { class: 'mp-tabs' });
  for (const id of Object.keys(labels) as PanelTab[]) {
    if (!has[id]) continue;
    const bt = h('button', { type: 'button', class: 'mp-tab' + (tab === id ? ' on' : ''), 'data-tab': id }, labels[id]);
    bt.addEventListener('click', () => setTab(id));
    tabs.append(bt);
  }
  const body = h('div', { class: 'mp-body' });
  root.append(tabs, body);

  const insBtn = (line: string, label = '판에 넣기') => {
    const x = h('button', { type: 'button', class: 'mp-ins', title: '판의 지금 줄 아래에 넣기' }, label);
    x.addEventListener('mousedown', (e) => e.preventDefault());
    x.addEventListener('click', () => act.insertLine(line));
    return x;
  };
  const section = (title: string, ...kids: Node[]) => h('section', { class: 'mp-sec' }, h('h4', {}, title), ...kids);
  const row = (main: string, subText = '', line?: string) => {
    const r = h('div', { class: 'mp-row' }, h('div', { class: 'mp-main' }, main));
    if (subText) r.append(h('div', { class: 'mp-rsub' }, subText));
    if (line) r.append(insBtn(line));
    return r;
  };

  if (tab === 'today') {
    // 오늘 수업 시간 나누기 (대화 · 과제 피드백 · 수업 · 마무리) — 누르면 그 시간만큼 타이머
    const plan = b?.prep?.plan || [];
    if (plan.length) {
      const total = plan.reduce((a, p) => a + (p.min || 0), 0) || 1;
      const bar = h('div', { class: 'plan-bar' });
      plan.forEach((p, i) => {
        const seg = h('button', { type: 'button', class: 'plan-seg c' + (i % 5), style: `flex:${p.min}`, title: `${p.part} ${p.min}분${p.what ? ' — ' + p.what : ''} · 누르면 타이머` }, h('b', {}, p.part), h('span', {}, `${p.min}분`));
        seg.addEventListener('click', () => act.startTimer(p.min * 60, p.part));
        bar.append(seg);
      });
      const rows = plan.filter((p) => p.what).map((p) => h('div', { class: 'plan-row' }, h('b', {}, p.part), ' ', p.what!));
      body.append(section(`오늘 ${total}분`, bar, ...rows));
    }
    if (b) {
      const goals = (b.prep?.summary || []).filter(Boolean);
      if (goals.length) body.append(section('오늘 수업', ...goals.map((g) => h('p', { class: 'mp-p' }, g.replace(/`|\*\*/g, '')))));
      const words = b.warmup_recent || [];
      if (words.length) {
        const chips = h('div', { class: 'mp-chips' });
        for (const w of words) {
          const c = h('button', { type: 'button', class: 'mp-chip', title: w.en || '' }, w.kr);
          c.addEventListener('mousedown', (e) => e.preventDefault());
          c.addEventListener('click', () => act.insertLine(`${w.kr}${w.en ? ' : ' + w.en : ''}`));
          chips.append(c);
        }
        const all = insBtn('복습: ' + words.map((w) => w.kr).join(', '), '모두 한 줄로 판에 넣기');
        body.append(section('복습 단어', chips, all));
      }
      const ask = (b.rapport || []).filter((r) => !r.sensitive).slice(0, 4);
      if (ask.length) body.append(section('물어볼 것 (지난 이야기)', ...ask.map((r) => row(r.text, [r.date ? r.date.slice(5).replace('-', '/') : '', r.lesson ? `#${r.lesson}` : '', r.follow_up || ''].filter(Boolean).join(' · ')))));
      const pr = b.promises;
      const promiseRows: HTMLElement[] = [];
      for (const t of pr?.tutor || []) promiseRows.push(row('선생님: ' + t.text, t.status === 'open' ? '아직 안 함' : t.status === 'done' ? '했음' : t.status || ''));
      for (const hw of pr?.homework || []) {
        const txt = typeof hw === 'string' ? hw : hw.text || '';
        if (txt) promiseRows.push(row('숙제: ' + txt, '', '숙제 확인: ' + txt));
      }
      if (pr?.submissions) promiseRows.push(row('숙제 제출', [pr.homework_status, pr.submissions, pr.assignment_link].filter(Boolean).join(' · ')));
      if (promiseRows.length) body.append(section('약속·숙제', ...promiseRows));
      const core = b.last_core;
      if (core) {
        const kids: Node[] = [];
        if (core.taught?.length) kids.push(row('배운 말', core.taught.join(', '), '지난 시간: ' + core.taught.slice(0, 8).join(', ')));
        if (core.patterns?.length) kids.push(row('문형', core.patterns.join(' · '), '문형: ' + core.patterns.join(' · ')));
        for (const c of core.corrections || []) kids.push(row('교정', c, c));
        if (core.overview) kids.push(h('p', { class: 'mp-p muted' }, core.overview.slice(0, 280) + (core.overview.length > 280 ? '…' : '')));
        if (kids.length) body.append(section(`지난 수업 #${b.last_lesson ?? ''} 핵심`, ...kids));
      }
      if (b.next_focus) body.append(section('다음 할 것', h('p', { class: 'mp-p' }, b.next_focus)));
      if (pack.trialPrep) body.append(section('체험 수업 준비', mdToEl(pack.trialPrep.text)));
    } else if (pack.trialPrep) {
      body.append(h('p', { class: 'mp-p muted' }, '체험 수업 준비 문서'), mdToEl(pack.trialPrep.text));
    } else {
      const last = pack.lessons[0];
      body.append(h('p', { class: 'mp-p muted' }, '오늘 브리핑에는 이 학생이 없어요.' + (last ? ` 지난 수업 #${last.n} (${last.date.slice(5).replace('-', '/')})` : '')));
      const ml = mem?.lessons[0];
      if (ml?.summary) body.append(section('지난 수업', h('p', { class: 'mp-p' }, ml.summary)));
      const rev = mem?.vocab.filter((v) => v.status === 'review').slice(0, 10) || [];
      if (rev.length) body.append(section('복습할 단어', h('p', { class: 'mp-p' }, rev.map((v) => v.kr).join(', ')), insBtn('복습: ' + rev.map((v) => v.kr).join(', '), '모두 한 줄로 판에 넣기')));
    }
  } else if (tab === 'plan') {
    if (pack.files.length) {
      const KIND: Record<string, string> = { html: '웹 학습지', pdf: 'PDF', img: '사진', md: '문서', audio: '소리', video: '영상', text: '글' };
      const mats = h('div', {});
      for (const f of pack.files) {
        const r = h('div', { class: 'mp-row' }, h('div', { class: 'mp-main' }, f.name.replace(/\.[^.]+$/, '')), h('div', { class: 'mp-rsub' }, `${KIND[f.kind]} · ${Math.max(1, Math.round(f.size / 1024))}KB`));
        const put = h('button', { type: 'button', class: 'mp-ins' }, '판에 넣기');
        put.addEventListener('click', async () => {
          put.setAttribute('disabled', '');
          put.textContent = '넣는 중…';
          try {
            await act.placeFile(f);
            put.textContent = '넣었어요';
          } catch {
            put.textContent = '못 넣었어요';
          }
          window.setTimeout(() => {
            put.removeAttribute('disabled');
            put.textContent = '판에 넣기';
          }, 1500);
        });
        r.append(put);
        mats.append(r);
      }
      body.append(section('자료', mats));
    }
    const doc = pack.plan || (pack.trialPrep ? { name: pack.trialPrep.name, text: pack.trialPrep.text } : null);
    if (doc) body.append(section(pack.plan ? `수업안 #${pack.plan.n}` : '체험 수업 준비', mdToEl(doc.text)));
    if (pack.homework) body.append(details('과제 초안', mdToEl(pack.homework.text), false));
  } else if (tab === 'student') {
    if (pack.profile) body.append(details('학생 정보', mdToEl(pack.profile), true));
    if (pack.roadmap) body.append(details('로드맵', mdToEl(pack.roadmap), !pack.profile));
    if (pack.status) body.append(details('지금 배우는 상태', mdToEl(pack.status), false));
    if (mem?.errors.length) body.append(details(`자주 틀린 것 ${mem.errors.length}`, h('div', {}, ...mem.errors.slice(0, 30).map((e) => row(`${e.wrong ? '✗ ' + e.wrong : e.type}`, [e.right ? '✓ ' + e.right : '', e.count && e.count > 1 ? `${e.count}번` : '', e.last || ''].filter(Boolean).join(' · ')))), false));
    if (mem?.grammar.length) body.append(details(`배운 문형 ${mem.grammar.length}`, h('div', {}, ...mem.grammar.slice(-40).reverse().map((g) => row(g.pattern, [g.name, g.first ? `${g.first} 처음` : '', (g.examples || [])[0]].filter(Boolean).join(' · '), `${g.pattern}${g.examples?.[0] ? ' — ' + g.examples[0] : ''}`))), false));
  } else if (tab === 'lessons') {
    const list = h('div', { class: 'mp-list' });
    const viewer = h('div', { class: 'mp-viewer', hidden: '' });
    for (const l of pack.lessons) {
      const r = h('button', { type: 'button', class: 'mp-row mp-link' }, h('div', { class: 'mp-main' }, `#${l.n} · ${l.date.slice(5).replace('-', '/')}`), h('div', { class: 'mp-rsub' }, l.name));
      r.addEventListener('click', async () => {
        viewer.innerHTML = '';
        const back = h('button', { type: 'button', class: 'mp-back' }, '← 목록');
        back.addEventListener('click', () => {
          viewer.hidden = true;
          list.hidden = false;
        });
        viewer.append(back, h('p', { class: 'mp-p muted' }, l.name), mdToEl(await act.readLessonDoc(l.name)));
        list.hidden = true;
        viewer.hidden = false;
      });
      list.append(r);
    }
    const boards = act.otherBoards();
    if (boards.length) list.append(h('h4', { class: 'mp-h4' }, '이 학생의 다른 판'), ...boards.map((bb) => h('a', { class: 'mp-row mp-link', href: `#/b/${bb.id}?r=t`, target: '_blank', rel: 'noopener' }, h('div', { class: 'mp-main' }, `판 ${fmtDate(bb.createdAt)}`), h('div', { class: 'mp-rsub' }, bb.id))));
    body.append(list, viewer);
  } else if (tab === 'hw') {
    renderHomework(body, pack, act, section);
  } else if (tab === 'vocab' && pack.db) {
    renderDbVocab(body, pack.db, mem, act, insBtn);
  } else if (tab === 'vocab' && mem) {
    const search = h('input', { type: 'search', class: 'mp-search', placeholder: '단어 찾기', lang: 'ko' }) as HTMLInputElement;
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const list = h('div', { class: 'mp-list' });
    const draw = () => {
      list.innerHTML = '';
      const q = search.value.trim();
      const vs = mem.vocab.filter((v) => !q || v.kr.includes(q) || (v.en || '').toLowerCase().includes(q.toLowerCase())).slice(0, 200);
      for (const v of vs) list.append(row(v.kr, vocabNote(v), `${v.kr}${v.en ? ' : ' + v.en : ''}`));
      if (!vs.length) list.append(h('p', { class: 'mp-empty' }, '찾는 단어가 없어요'));
    };
    search.addEventListener('input', draw);
    body.append(search, list);
    draw();
  }
}

// 중앙 DB에서 뽑은 전체 단어·문형 + 관련된 말
let dbView: { kind: 'w' | 'g'; sort: 'recent' | 'first' | 'seen'; q: string } = { kind: 'w', sort: 'recent', q: '' };
function renderDbVocab(body: HTMLElement, dbIn: BoardData, mem: StudentMemory | null, act: PanelActions, insBtn: (line: string, label?: string) => HTMLElement) {
  // DB에 아직 안 들어간 단어(수업 기록 .lesson_data 에만 있는 것)도 합친다
  const inDb = new Set(dbIn.vocab.map((v) => v.w));
  const extra = (mem?.vocab || []).filter((v) => v.kr && !inDb.has(v.kr)).map((v) => ({ w: v.kr, en: v.en || '', cat: '', pos: '', seen: v.count || 1, status: v.status || '', first: Number((v.lesson || '').replace(/\D/g, '')) || null, last: null, rel: {}, only: true }));
  const db: BoardData = { ...dbIn, vocab: [...dbIn.vocab, ...extra] };
  const review = new Set((mem?.vocab || []).filter((v) => v.status === 'review').map((v) => v.kr));
  const seg = h('div', { class: 'mp-seg' });
  const mk = (k: 'w' | 'g', label: string) => {
    const b = h('button', { type: 'button', class: 'mp-segb' + (dbView.kind === k ? ' on' : ''), 'data-kind': k }, label);
    b.addEventListener('click', () => {
      dbView = { ...dbView, kind: k };
      body.innerHTML = '';
      renderDbVocab(body, db, mem, act, insBtn);
    });
    return b;
  };
  seg.append(mk('w', `단어 ${db.vocab.length}`), mk('g', `문형 ${db.grammar.length}`));
  const search = h('input', { type: 'search', class: 'mp-search', placeholder: dbView.kind === 'w' ? '단어·뜻 찾기' : '문형 찾기', lang: 'ko', value: dbView.q }) as HTMLInputElement;
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const sort = h('select', { class: 'mp-sort', 'aria-label': '순서' }) as HTMLSelectElement;
  for (const [v, l] of [['recent', '최근 수업 순'], ['first', '처음 배운 순'], ['seen', '많이 나온 순']]) sort.append(h('option', { value: v }, l));
  sort.value = dbView.sort;
  const list = h('div', { class: 'mp-list' });
  const relBox = (rel: Record<string, string[]>) => {
    const box = h('div', { class: 'mp-rel' });
    for (const [k, ws] of Object.entries(rel)) {
      if (!ws.length) continue;
      const chips = h('div', { class: 'mp-chips' });
      for (const w of ws) {
        const c = h('button', { type: 'button', class: 'mp-chip' + (k.includes('새') ? ' new' : '') }, w);
        c.addEventListener('mousedown', (e) => e.preventDefault());
        c.addEventListener('click', () => act.insertLine(w));
        chips.append(c);
      }
      box.append(h('div', { class: 'mp-relk' }, k), chips);
    }
    if (!box.childElementCount) box.append(h('p', { class: 'mp-empty' }, 'DB에 이어진 말이 없어요'));
    return box;
  };
  const num = (n: number | null | undefined) => (n == null ? -1 : n);
  const draw = () => {
    list.innerHTML = '';
    const q = dbView.q.trim().toLowerCase();
    if (dbView.kind === 'w') {
      let vs = db.vocab.filter((v) => !q || v.w.includes(q) || v.en.toLowerCase().includes(q));
      vs = [...vs].sort((a, b) => (dbView.sort === 'first' ? num(a.first) - num(b.first) : dbView.sort === 'seen' ? b.seen - a.seen : num(b.last ?? b.first) - num(a.last ?? a.first)));
      for (const v of vs.slice(0, 300)) {
        const sub = [v.en, v.first != null ? `#${v.first} 처음` : '', v.seen > 1 ? `${v.seen}번` : '', v.chapter ? `챕터 ${v.chapter.target}` : '', review.has(v.w) ? '오늘 복습' : '', (v as { only?: boolean }).only ? '수업 기록에만 (DB 아직)' : ''].filter(Boolean).join(' · ');
        const r = h('div', { class: 'mp-row mp-dbrow' + (review.has(v.w) ? ' review' : '') }, h('button', { type: 'button', class: 'mp-main mp-open', 'aria-expanded': 'false' }, v.w), h('div', { class: 'mp-rsub' }, sub), insBtn(`${v.w}${v.en ? ' : ' + v.en : ''}`));
        const open = r.querySelector('.mp-open') as HTMLElement;
        open.addEventListener('click', () => {
          const ex = r.querySelector('.mp-rel');
          if (ex) {
            ex.remove();
            open.setAttribute('aria-expanded', 'false');
          } else {
            r.append(relBox(v.rel));
            open.setAttribute('aria-expanded', 'true');
          }
        });
        list.append(r);
      }
      if (vs.length > 300) list.append(h('p', { class: 'mp-empty' }, `${vs.length - 300}개 더 — 찾기로 좁혀 보세요`));
      if (!vs.length) list.append(h('p', { class: 'mp-empty' }, '찾는 단어가 없어요'));
    } else {
      let gs = db.grammar.filter((g) => !q || g.p.toLowerCase().includes(q) || g.en.toLowerCase().includes(q) || g.meaning.toLowerCase().includes(q));
      gs = [...gs].sort((a, b) => (dbView.sort === 'first' ? num(a.first) - num(b.first) : dbView.sort === 'seen' ? b.count - a.count : num(b.first) - num(a.first)));
      for (const g of gs) {
        const sub = [g.en, g.first != null ? `#${g.first} 처음` : '', g.count > 1 ? `${g.count}번 연습` : '', g.ex].filter(Boolean).join(' · ');
        const r = h('div', { class: 'mp-row mp-dbrow' }, h('button', { type: 'button', class: 'mp-main mp-open', 'aria-expanded': 'false' }, g.p), h('div', { class: 'mp-rsub' }, sub), insBtn(`${g.p}${g.ex ? ' — ' + g.ex : ''}`));
        const open = r.querySelector('.mp-open') as HTMLElement;
        open.addEventListener('click', () => {
          const ex = r.querySelector('.mp-rel');
          if (ex) {
            ex.remove();
            open.setAttribute('aria-expanded', 'false');
          } else {
            const box = relBox(g.rel);
            if (g.meaning) box.prepend(h('p', { class: 'mp-p muted' }, g.meaning));
            r.append(box);
            open.setAttribute('aria-expanded', 'true');
          }
        });
        list.append(r);
      }
      if (!gs.length) list.append(h('p', { class: 'mp-empty' }, '찾는 문형이 없어요'));
    }
  };
  search.addEventListener('input', () => {
    dbView = { ...dbView, q: search.value };
    draw();
  });
  sort.addEventListener('change', () => {
    dbView = { ...dbView, sort: sort.value as typeof dbView.sort };
    draw();
  });
  const note = h('p', { class: 'mp-note' }, `단어를 누르면 이어진 말이 나와요 (${(db.sources?.relations || ['같은 챕터', '같은 묶음']).join(' · ')}). 동의어·반의어·우리말샘 유사도는 아직 DB에 없어요. · ${db.generated_at.slice(5, 16).replace('T', ' ')} 기준`);
  body.append(seg, h('div', { class: 'mp-tools' }, search, sort), list, note);
  draw();
}

function details(title: string, content: HTMLElement, open: boolean): HTMLElement {
  const d = h('details', { class: 'mp-det' });
  if (open) d.setAttribute('open', '');
  d.append(h('summary', {}, title), content);
  return d;
}

// ---- 과제 탭: 지난 수업 뒤 날마다 낸 과제와 피드백 → 수업에서 짚을 것 ----
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS_KO: Record<string, string> = { done: '했음', on_time: '했음', late: '늦게 함', partial: '조금 함', skipped: '바빠서 쉼', none: '안 함', rest: '쉬는 날', today: '오늘' };
function renderHomework(body: HTMLElement, pack: StudentPack, act: PanelActions, section: (title: string, ...kids: Node[]) => HTMLElement) {
  const box = h('div', { class: 'hw' });
  body.append(box);
  const draw = (hist: HwHistory | null, note = '') => {
    box.innerHTML = '';
    if (!hist || !hist.days.length) {
      box.append(h('p', { class: 'mp-p muted' }, note || '아직 과제 기록이 없어요.'));
    } else drawHistory(box, hist, act, section);
    // 폴더에 그냥 들어 있는 과제 파일 (사진·녹음·글)
    if (pack.hwFiles.length) {
      const list = h('div', {});
      for (const f of pack.hwFiles.slice(0, 30)) {
        const r = h('div', { class: 'mp-row' }, h('div', { class: 'mp-main' }, f.name.replace(/\.[^.]+$/, '')), h('div', { class: 'mp-rsub' }, { img: '사진', audio: '녹음', video: '영상', text: '글', pdf: 'PDF', html: '웹', md: '문서' }[f.kind] || ''));
        const put = h('button', { type: 'button', class: 'mp-ins' }, '판에 넣기');
        put.addEventListener('click', async () => {
          put.textContent = '넣는 중…';
          await act.placeFile(f).catch(() => undefined);
          put.textContent = '넣었어요';
          window.setTimeout(() => (put.textContent = '판에 넣기'), 1500);
        });
        r.append(put);
        list.append(r);
      }
      box.append(details(`폴더에 있는 과제 파일 ${pack.hwFiles.length}`, list, false));
    }
    // KWD 숙제 앱
    const app = h('div', { class: 'hw-app' });
    if (!act.hwConnected()) app.append(h('p', { class: 'mp-note' }, 'KWD 숙제 앱과 연결하면 학생이 날마다 낸 답·손글씨·녹음·피드백이 여기 바로 떠요. ⋯ → 더 보기 → 숙제 연결 (주소와 선생님 키, 이 기기에만 저장).'));
    else {
      const load = h('button', { type: 'button', class: 'mp-ins' }, hist?.source === 'app' ? '숙제 앱에서 다시 불러오기' : '숙제 앱에서 불러오기');
      load.addEventListener('click', async () => {
        load.textContent = '불러오는 중…';
        try {
          const hh = await act.loadHistory();
          hwCache.set(pack.folder, hh);
          draw(hh || pack.hwHistory || null, hh ? '' : '숙제 앱에 이 학생이 없어요.');
        } catch (e) {
          load.textContent = '못 불러옴: ' + ((e as Error).message || e);
        }
      });
      app.append(load);
    }
    box.append(app);
  };
  const cached = hwCache.get(pack.folder);
  draw(cached || pack.hwHistory || null);
}

function drawHistory(box: HTMLElement, hist: HwHistory, act: PanelActions, section: (title: string, ...kids: Node[]) => HTMLElement) {
  const since = hist.lastLesson || '';
  const recent = hist.days.filter((d) => !since || d.date > since);
  const older = hist.days.filter((d) => since && d.date <= since);
  // 1) 한 줄 요약 + 날짜 띠
  const did = recent.filter((d) => /done|on_time|late|partial/.test(d.status)).length;
  const items = recent.flatMap((d) => d.tasks.flatMap((t) => t.items.map((it) => ({ d, t, it }))));
  const fix = items.filter((x) => x.it.status === 'fix');
  const wait = items.filter((x) => x.it.status === 'wait');
  const md = (s: string) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const strip = h('div', { class: 'hw-strip' });
  for (const d of recent.slice().reverse()) {
    const dt = new Date(d.date + 'T12:00:00');
    strip.append(h('span', { class: 'hw-day st-' + d.status, title: `${md(d.date)} ${STATUS_KO[d.status] || d.status}` }, h('b', {}, DOW[dt.getDay()]), h('i', {}, String(dt.getDate()))));
  }
  box.append(
    h('p', { class: 'hw-sum' }, since ? `지난 수업(${md(since)}) 뒤 ${recent.length}일 중 ${did}일 함` : `최근 ${recent.length}일 중 ${did}일 함`, fix.length ? h('span', { class: 'hw-badge fix' }, `고칠 것 ${fix.length}`) : '', wait.length ? h('span', { class: 'hw-badge wait' }, `확인 기다림 ${wait.length}`) : ''),
    strip,
  );
  // 2) 수업에서 짚을 것 (틀린 것·확인 기다리는 것)
  const pts = [...fix, ...wait].slice(0, 12);
  if (pts.length) {
    const list = h('div', {});
    for (const x of pts) list.append(itemRow(x.it, act, `${md(x.d.date)} · ${x.t.title}`));
    const all = h('button', { type: 'button', class: 'mp-ins' }, '모두 판에 넣기');
    all.addEventListener('click', () => act.placeText(['과제에서 짚을 것', ...pts.map((x) => `• ${x.it.label}: ${x.it.text || '(사진·녹음)'}${x.it.teacher || x.it.ai ? ' → ' + (x.it.teacher || x.it.ai) : ''}`)].join('\n')));
    box.append(section('수업에서 짚을 것', list, all));
  }
  // 3) 날마다 (최근 것이 위)
  const dayList = h('div', { class: 'hw-days' });
  recent.forEach((d, i) => dayList.append(dayBlock(d, act, i === 0)));
  box.append(section(since ? '지난 수업 뒤 과제' : '최근 과제', dayList));
  if (older.length) {
    const ol = h('div', { class: 'hw-days' });
    older.forEach((d) => ol.append(dayBlock(d, act, false)));
    box.append(details(`그 전 과제 ${older.length}일`, ol, false));
  }
}

function dayBlock(d: HwDay, act: PanelActions, open: boolean): HTMLElement {
  const dt = new Date(d.date + 'T12:00:00');
  const n = d.tasks.reduce((a, t) => a + t.items.length, 0);
  const det = h('details', { class: 'hw-dayb st-' + d.status });
  if (open) det.setAttribute('open', '');
  det.append(h('summary', {}, h('b', {}, `${dt.getMonth() + 1}/${dt.getDate()} (${DOW[dt.getDay()]})`), ` ${STATUS_KO[d.status] || d.status}`, n ? h('span', { class: 'mp-rsub' }, ` · ${d.tasks.length}과제${d.minutes ? ` · ${d.minutes}분` : ''}`) : ''));
  if (d.note) det.append(h('p', { class: 'mp-p muted' }, d.note));
  for (const t of d.tasks) {
    det.append(h('div', { class: 'hw-task' }, t.title));
    for (const it of t.items) det.append(itemRow(it, act));
  }
  if (!d.tasks.length) det.append(h('p', { class: 'mp-p muted' }, d.status === 'skipped' ? '학생이 "오늘 너무 바빠요"를 눌렀어요.' : '낸 것이 없어요.'));
  return det;
}

function itemRow(it: HwItem, act: PanelActions, where = ''): HTMLElement {
  const st = it.status === 'fix' ? h('span', { class: 'hw-badge fix' }, '고칠 것') : it.status === 'wait' ? h('span', { class: 'hw-badge wait' }, '확인 기다림') : it.status === 'ok' ? h('span', { class: 'hw-badge ok' }, '✓') : '';
  const r = h('div', { class: 'hw-item' }, h('div', { class: 'hw-q' }, it.label, ' ', st, where ? h('span', { class: 'mp-rsub' }, ' ' + where) : ''));
  if (it.text) r.append(h('div', { class: 'hw-a' }, it.text));
  const media = h('div', { class: 'hw-media' });
  for (const m of it.media || []) {
    const slot = h('div', { class: 'hw-m' });
    void act.mediaUrl(m).then(({ url }) => {
      if (!url) return;
      if (m.kind === 'img') {
        const im = h('img', { class: 'mp-thumb', alt: it.label }) as HTMLImageElement;
        im.src = url;
        slot.prepend(im);
      } else {
        const au = h('audio', { controls: '', preload: 'none', class: 'mp-audio' }) as HTMLAudioElement;
        au.src = url;
        slot.prepend(au);
      }
    });
    const put = h('button', { type: 'button', class: 'mp-ins' }, '판에 넣기');
    put.addEventListener('click', () => void act.placeMedia(m, it.label));
    slot.append(put);
    media.append(slot);
  }
  if (media.childElementCount) r.append(media);
  if (it.teacher) r.append(h('div', { class: 'hw-fb t' }, '선생님: ' + it.teacher));
  if (it.ai) r.append(h('div', { class: 'hw-fb ai' }, 'AI 초안: ' + it.ai));
  if (it.model) r.append(h('div', { class: 'hw-fb m' }, '모범: ' + it.model));
  if (it.text) {
    const put = h('button', { type: 'button', class: 'mp-ins sm' }, '판에 넣기');
    put.addEventListener('click', () => act.placeText(`${it.label}\n${it.text}${it.teacher || it.ai ? '\n→ ' + (it.teacher || it.ai) : ''}`));
    r.append(put);
  }
  return r;
}
