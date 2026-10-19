// '이 학생' 패널 (선생님 화면만): 오늘 · 수업안 · 자료 · 학생 · 지난 수업 · 단어
// KWD 폴더에서 읽은 것을 그대로 보여 주고, 한 번 눌러 판에 넣는다.
import { blockMd, UNIT_BLOCK_LABEL } from './units';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { h, fmtDate } from './ui';
import { vocabNote, type StudentMemory } from './memory';
import type { StudentPack, PackFile, BoardData } from './kwdfolder';
import { type HwHistory, type HwMedia, type HwDay, type HwItem } from './homework';
import { talkKitMarkdown, PACE_KO, type TalkKit, type PacketRoadmap, type Learner } from './packet';

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
  split(): SplitSeg[]; // 오늘 시간 배분 (판에서 고친 값 → 묶음 → 브리핑 순)
  setSplit(segs: SplitSeg[]): void;
  startSegment(seg: SplitSeg): void;
  placeTalkKit(md: string): void; // 대화 재료를 판 위 카드로, 학생 화면도 거기로
  placeMedia(m: HwMedia, label: string): Promise<void>;
}

// 숙제 앱에서 불러온 것 (패널이 다시 그려져도 남게, 이 창에서만)
const hwCache = new Map<string, HwHistory | null>();

export interface SplitSeg {
  key: string;
  label: string;
  min: number;
  what?: string[];
}

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
    today: !!(b || pack.packet || pack.trialPrep || pack.lessons.length),
    plan: !!(pack.plan || pack.trialPrep || pack.files.length),
    hw: true,
    student: !!(pack.profile || pack.roadmap || pack.status || pack.packet?.roadmap),
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

  const insBtn = (line: string, label = '판에 놓기') => {
    const x = h('button', { type: 'button', class: 'mp-ins', title: '지금 보는 곳에 글상자로 놓기' }, label);
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
    renderToday(body, pack, mem, act, section, row);
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
    for (const u of pack.units || []) {
      const box = h('div', {});
      const isNow = u.unit_id === pack.packet?.roadmap?.unit_id;
      if (u.goal) box.append(h('div', { class: 'mp-rsub' }, u.goal));
      for (const b of u.blocks) {
        const md = blockMd(b);
        if (!md) continue;
        const showAns = blockMd(b, true);
        const det = details(UNIT_BLOCK_LABEL[b.type] || b.type, h('div', {}, mdToEl(showAns), (() => {
          const put = h('button', { type: 'button', class: 'mp-ins', title: '문제만 판에 글상자로 (정답은 선생님 화면에만)' }, '판에 놓기');
          put.addEventListener('mousedown', (e) => e.preventDefault());
          put.addEventListener('click', () => act.placeText(md));
          return put;
        })()), false);
        box.append(det);
      }
      body.append(section(`${isNow ? '지금 단원' : '다음 단원'} · ${u.title_ko}`, box));
    }
    const doc = pack.plan || (pack.trialPrep ? { name: pack.trialPrep.name, text: pack.trialPrep.text } : null);
    if (doc) body.append(section(pack.plan ? `수업안 #${pack.plan.n}` : '체험 수업 준비', mdToEl(doc.text)));
    if (pack.homework) body.append(details('과제 초안', mdToEl(pack.homework.text), false));
  } else if (tab === 'student') {
    renderStudent(body, pack, mem, act);
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
const STAGE_NAMES: Record<string, string> = { 1: '씨앗', 2: '새싹', 3: '잎새', 4: '꽃', 5: '열매', 6: '나무' };
const SRS_KO: Record<string, string> = { learning: '카드 익히는 중', stable: '카드 외움', lapsing: '카드 자꾸 잊음', due: '카드 복습 때' };
let dbView: { kind: 'w' | 'g'; sort: 'recent' | 'first' | 'seen' | 'stage'; q: string; stage: string; step: string; src: '' | 'lesson' | 'cards'; srs: '' | 'learning' | 'stable' | 'lapsing' } = { kind: 'w', sort: 'recent', q: '', stage: '', step: '', src: '', srs: '' };
const stepNum = (s?: string) => Number((/(\d+)$/.exec(s || '') || [])[1] || 0);
const STAGE_ORDER = ['씨앗', '새싹', '잎새', '꽃', '열매', '나무'];
// 단계 이름은 kwd-app 세트의 단계(씨앗 2 …)를 따른다. 세트가 없으면 레벨(1~6)로
const stageOf = (v: { step?: string; level?: number | null }) => (v.step ? v.step.split(' ')[0] : v.level ? STAGE_NAMES[v.level] || '' : '');
const stageRank = (v: { step?: string; level?: number | null }) => {
  const i = STAGE_ORDER.indexOf(stageOf(v));
  return (i < 0 ? 9 : i) * 100 + stepNum(v.step);
};
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
  for (const [v, l] of [['recent', '최근 수업 순'], ['first', '처음 배운 순'], ['seen', '많이 나온 순'], ['stage', '단계 순']]) sort.append(h('option', { value: v }, l));
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
      let vs = db.vocab.filter((v) => (!q || v.w.includes(q) || v.en.toLowerCase().includes(q)) && (!dbView.stage || stageOf(v) === dbView.stage) && (!dbView.step || v.step === dbView.step) && (!dbView.src || (dbView.src === 'lesson' ? v.src !== 'cards' : v.src === 'cards')) && (!dbView.srs || (v.srs === 'due' ? 'lapsing' : v.srs) === dbView.srs));
      vs = [...vs].sort((a, b) => (dbView.sort === 'first' ? num(a.first) - num(b.first) : dbView.sort === 'seen' ? b.seen - a.seen : dbView.sort === 'stage' ? stageRank(a) - stageRank(b) || a.w.localeCompare(b.w) : num(b.last ?? b.first) - num(a.last ?? a.first)));
      countEl.textContent = `${vs.length}개`;
      for (const v of vs.slice(0, 300)) {
        const sub = [v.en, v.step || '', v.src === 'cards' ? '카드로만' : v.first != null ? `#${v.first} 처음` : '', v.src !== 'cards' && v.seen > 1 ? `${v.seen}번` : '', v.srs ? SRS_KO[v.srs] : '', review.has(v.w) ? '오늘 복습' : '', (v as { only?: boolean }).only ? '수업 기록에만 (DB 아직)' : ''].filter(Boolean).join(' · ');
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
  // 단계 거르기: 씨앗 · 새싹 · 잎새 · 꽃 · 열매 · 나무 (고르면 그 안의 작은 단계 1, 2, 3…) + 어디서 (수업 · 카드)
  const countEl = h('span', { class: 'mp-count' });
  const filters = h('div', { class: 'vf' });
  const redraw = () => {
    body.innerHTML = '';
    renderDbVocab(body, db, mem, act, insBtn);
  };
  if (dbView.kind === 'w') {
    const stages = STAGE_ORDER.filter((st) => db.vocab.some((v) => stageOf(v) === st));
    if (stages.length) {
      const row = h('div', { class: 'vf-row', role: 'group', 'aria-label': '단계' });
      const chip = (label: string, on: boolean, n: number, go: () => void) => {
        const b = h('button', { type: 'button', class: 'vf-chip' + (on ? ' on' : ''), 'aria-pressed': String(on) }, label, h('small', {}, String(n)));
        b.addEventListener('click', go);
        row.append(b);
      };
      chip('전체', !dbView.stage, db.vocab.length, () => ((dbView = { ...dbView, stage: '', step: '' }), redraw()));
      for (const st of stages) chip(st, dbView.stage === st, db.vocab.filter((v) => stageOf(v) === st).length, () => ((dbView = { ...dbView, stage: dbView.stage === st ? '' : st, step: '' }), redraw()));
      filters.append(row);
      if (dbView.stage) {
        const steps = [...new Set(db.vocab.filter((v) => stageOf(v) === dbView.stage && v.step).map((v) => v.step!))].sort((a, b) => stepNum(a) - stepNum(b));
        if (steps.length > 1) {
          const r2 = h('div', { class: 'vf-row sub', role: 'group', 'aria-label': '작은 단계' });
          for (const st of steps) {
            const on = dbView.step === st;
            const b = h('button', { type: 'button', class: 'vf-chip sm' + (on ? ' on' : ''), 'aria-pressed': String(on) }, st.replace(/^\S+\s/, ''), h('small', {}, String(db.vocab.filter((v) => v.step === st).length)));
            b.addEventListener('click', () => ((dbView = { ...dbView, step: on ? '' : st }), redraw()));
            r2.append(b);
          }
          filters.append(r2);
        }
      }
    }
    if (db.vocab.some((v) => v.src === 'cards')) {
      const src = h('select', { class: 'mp-sort', 'aria-label': '어디서' }) as HTMLSelectElement;
      for (const [v, l] of [['', '수업 + 카드'], ['lesson', '수업에서 배운 것'], ['cards', '카드로만 공부']]) src.append(h('option', { value: v }, l));
      src.value = dbView.src;
      src.addEventListener('change', () => ((dbView = { ...dbView, src: src.value as typeof dbView.src }), draw()));
      filters.append(src);
    }
    // 카드 상태 (익히는 중 · 외움 · 자꾸 잊음) — 단어 앱·숙제 카드 결과에서
    if (db.vocab.some((v) => v.srs)) {
      const row = h('div', { class: 'vf-row srs', role: 'group', 'aria-label': '카드 상태' });
      const n = (k: string) => db.vocab.filter((v) => (v.srs === 'due' ? 'lapsing' : v.srs) === k).length;
      for (const [k, label] of [['learning', '익히는 중'], ['stable', '외움'], ['lapsing', '자꾸 잊음']] as const) {
        const on = dbView.srs === k;
        const b = h('button', { type: 'button', class: 'vf-chip sm ' + k + (on ? ' on' : ''), 'aria-pressed': String(on) }, label, h('small', {}, String(n(k))));
        b.addEventListener('click', () => ((dbView = { ...dbView, srs: on ? '' : k }), redraw()));
        row.append(b);
      }
      filters.append(row);
    }
  }
  const note = h('p', { class: 'mp-note' }, `단어를 누르면 이어진 말이 나와요 (${(db.sources?.relations || ['같은 챕터', '같은 묶음']).join(' · ')}). 동의어·반의어·우리말샘 유사도는 아직 DB에 없어요. · ${db.generated_at.slice(5, 16).replace('T', ' ')} 기준`);
  body.append(seg, filters, h('div', { class: 'mp-tools' }, search, sort, countEl), list, note);
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

// 오늘 탭: 왜 지금 · 시간 배분(판에서 고침, 누르면 타이머) · 대화 재료(학생 화면에 깔기) · 과제에서 짚을 것 · 물어볼 것
// 모두 수업 후 자동화·과제 플랫폼·단어 앱이 만든 것을 그대로 보여 준다 (판은 만들지 않는다)
type Sec = (title: string, ...kids: Node[]) => HTMLElement;
type Row = (main: string, subText?: string, line?: string) => HTMLElement;
let splitEdit = false;
function renderToday(body: HTMLElement, pack: StudentPack, mem: StudentMemory | null, act: PanelActions, section: Sec, row: Row) {
  const b = pack.brief;
  const pk = pack.packet;
  const rm = pk?.roadmap;
  if (rm?.why_now) body.append(h('p', { class: 'mp-why' }, rm.why_now));
  const now = rm?.path?.find((s) => s.status === 'now');
  if (now) body.append(h('p', { class: 'mp-p muted mp-nowline' }, `지금 단계: ${now.title}${now.total ? ` (${now.done || 0}/${now.total})` : ''}${rm?.pace?.label ? ' · ' + (rm.pace.label_ko || PACE_KO[rm.pace.label]) : ''}`));

  // 시간 배분
  const segs = act.split();
  if (segs.length) {
    const total = segs.reduce((a, g) => a + g.min, 0);
    const bar = h('div', { class: 'plan-bar' });
    segs.forEach((g, i) => {
      const seg = h('button', { type: 'button', class: 'plan-seg c' + (i % 5), style: `flex:${Math.max(1, g.min)}`, 'data-seg': g.key, title: `${g.label} ${g.min}분 · 누르면 타이머` }, h('b', {}, g.label), h('span', {}, `${g.min}분`));
      seg.addEventListener('click', () => act.startSegment(g));
      bar.append(seg);
    });
    const edit = h('button', { type: 'button', class: 'linkish plan-edit' }, splitEdit ? '다 고쳤어요' : '분 고치기');
    edit.addEventListener('click', () => {
      splitEdit = !splitEdit;
      body.innerHTML = '';
      renderToday(body, pack, mem, act, section, row);
    });
    const kids: Node[] = [bar];
    if (splitEdit) {
      const ed = h('div', { class: 'plan-editrow' });
      segs.forEach((g, i) => {
        const step = (d: number) => {
          const next = segs.map((x) => ({ ...x }));
          next[i].min = Math.max(0, next[i].min + d);
          // 다른 칸을 늘리고 줄이면 본 수업이 받아서 수업 길이는 그대로 (본 수업을 고치면 길이가 바뀜)
          const main = next.findIndex((x) => x.key === 'main' || /본|수업$/.test(x.label));
          if (main >= 0 && main !== i && next[i].min !== segs[i].min) next[main].min = Math.max(0, next[main].min - (next[i].min - segs[i].min));
          act.setSplit(next);
          body.innerHTML = '';
          renderToday(body, pack, mem, act, section, row);
        };
        const minus = h('button', { type: 'button', class: 'pe-b', 'aria-label': g.label + ' 1분 줄이기' }, '−');
        const plus = h('button', { type: 'button', class: 'pe-b', 'aria-label': g.label + ' 1분 늘리기' }, '+');
        minus.addEventListener('click', () => step(-1));
        plus.addEventListener('click', () => step(1));
        ed.append(h('div', { class: 'pe-cell', 'data-seg': g.key }, h('span', {}, g.label), minus, h('b', {}, String(g.min)), plus));
      });
      kids.push(ed);
    }
    for (const g of segs) if (g.what?.length) kids.push(h('div', { class: 'plan-row' }, h('b', {}, g.label), ' ', g.what.join(' · ')));
    const title = h('span', {}, `오늘 ${total}분`);
    const sec = section('', ...kids);
    sec.querySelector('h4')!.append(title, edit);
    body.append(sec);
  }

  // 대화 재료: 묶음의 talk_kit (없으면 브리핑의 복습 단어만)
  const kit: TalkKit | null = pk?.talk_kit || (b?.warmup_recent?.length ? { share_ok: true, words: b.warmup_recent.map((w) => ({ w: w.kr, en: w.en })), expressions: [] } : null);
  if (kit && (kit.words.length || kit.expressions.length)) {
    const kids: Node[] = [];
    if (kit.topic) kids.push(h('p', { class: 'mp-p' }, kit.topic));
    if (kit.words.length) {
      const chips = h('div', { class: 'mp-chips' });
      for (const w of kit.words) chips.append(h('span', { class: 'mp-chip static' + (w.srs === 'due' || w.srs === 'lapsing' ? ' due' : ''), title: [w.en, w.from, w.srs === 'due' ? '카드 복습 때' : w.srs === 'lapsing' ? '자꾸 잊음' : ''].filter(Boolean).join(' · ') }, w.w));
      kids.push(h('div', { class: 'mp-relk' }, '전에 배운 말'), chips);
    }
    for (const e of kit.expressions) {
      kids.push(h('div', { class: 'tk-exp' }, h('b', {}, e.pattern), e.meaning ? h('span', { class: 'muted' }, ' ' + e.meaning) : '', h('ul', {}, ...e.examples.slice(0, 4).map((x) => h('li', { title: x.en || '' }, x.ko)))));
    }
    if (kit.share_ok !== false) {
      const put = h('button', { type: 'button', class: 'mp-ins tk-put' }, '학생 화면에 깔기');
      put.addEventListener('click', () => act.placeTalkKit(talkKitMarkdown(kit)));
      kids.push(put);
    }
    body.append(section('대화 재료', ...kids));
  }

  // 과제에서 짚을 것 (과제 플랫폼 digest 에서 고른 것)
  const pick = pk?.homework?.feedback_pick || [];
  if (pick.length) body.append(section('과제에서 짚을 것', ...pick.map((p) => row(p.item, p.why || ''))));

  if (b) {
    const ask = (b.rapport || []).filter((r) => !r.sensitive).slice(0, 4);
    const asks = [...ask.map((r) => row(r.text, [r.date ? r.date.slice(5).replace('-', '/') : '', r.lesson ? `#${r.lesson}` : '', r.follow_up || ''].filter(Boolean).join(' · '))), ...(pk?.teacher_notes?.ask || []).map((t) => row(t))];
    if (asks.length) body.append(section('물어볼 것', ...asks));
    const pr = b.promises;
    const promiseRows: HTMLElement[] = [];
    for (const t of pr?.tutor || []) promiseRows.push(row('선생님: ' + t.text, t.status === 'open' ? '아직 안 함' : t.status === 'done' ? '했음' : t.status || ''));
    for (const hw of pr?.homework || []) {
      const txt = typeof hw === 'string' ? hw : hw.text || '';
      if (txt) promiseRows.push(row('숙제: ' + txt));
    }
    if (pr?.submissions) promiseRows.push(row('숙제 제출', [pr.homework_status, pr.submissions].filter(Boolean).join(' · ')));
    if (promiseRows.length) body.append(details('약속·숙제', h('div', {}, ...promiseRows), false));
    const core = b.last_core;
    if (core) {
      const kids: Node[] = [];
      if (core.taught?.length) kids.push(row('배운 말', core.taught.join(', ')));
      if (core.patterns?.length) kids.push(row('문형', core.patterns.join(' · ')));
      for (const c of core.corrections || []) kids.push(row('교정', c));
      if (core.overview) kids.push(h('p', { class: 'mp-p muted' }, core.overview.slice(0, 280) + (core.overview.length > 280 ? '…' : '')));
      if (kids.length) body.append(details(`지난 수업 #${b.last_lesson ?? ''}`, h('div', {}, ...kids), false));
    }
    const watch = pk?.teacher_notes?.watch_out || [];
    if (watch.length) body.append(section('조심할 것', ...watch.map((w) => row(w))));
    if (pack.trialPrep) body.append(section('체험 수업 준비', mdToEl(pack.trialPrep.text)));
  } else if (pack.trialPrep) {
    body.append(h('p', { class: 'mp-p muted' }, '체험 수업 준비 문서'), mdToEl(pack.trialPrep.text));
  } else if (!pk) {
    const last = pack.lessons[0];
    body.append(h('p', { class: 'mp-p muted' }, '오늘 브리핑에는 이 학생이 없어요.' + (last ? ` 지난 수업 #${last.n} (${last.date.slice(5).replace('-', '/')})` : '')));
    const ml = mem?.lessons[0];
    if (ml?.summary) body.append(section('지난 수업', h('p', { class: 'mp-p' }, ml.summary)));
  }
}

// 로드맵 한눈에: 처음 목표 → 단계별 목표(지금 단계 강조) · 속도 · 오늘 · 이번 주
function renderRoadmap(body: HTMLElement, rm: PacketRoadmap) {
  const box = h('section', { class: 'rm' });
  if (rm.goal_start) {
    const g = rm.goal_start;
    box.append(h('div', { class: 'rm-goal' }, h('span', { class: 'rm-k' }, '처음 목표'), h('b', {}, g.text), h('span', { class: 'rm-sub' }, [g.set_on ? g.set_on.slice(2).replace(/-/g, '.') + ' 시작' : '', g.horizon || '', g.why || ''].filter(Boolean).join(' · '))));
  }
  const pc = rm.pace;
  if (pc?.label) {
    const facts = [pc.lessons_expected ? `수업 ${pc.lessons_done ?? '?'}/${pc.lessons_expected}` : '', pc.units_expected ? `단원 ${pc.units_done ?? '?'}/${pc.units_expected}` : '', pc.hw_days_ratio != null ? `숙제 ${Math.round(pc.hw_days_ratio * 100)}%` : ''].filter(Boolean).join(' · ');
    box.append(h('div', { class: 'rm-pace ' + pc.label }, h('b', {}, pc.label_ko || PACE_KO[pc.label] || pc.label), h('span', {}, facts), pc.note_ko ? h('span', { class: 'rm-sub' }, pc.note_ko) : ''));
  }
  if (rm.path?.length) {
    const list = h('ol', { class: 'rm-path' });
    for (const st of rm.path) {
      const pct = st.total ? Math.round(((st.done || 0) / st.total) * 100) : st.status === 'done' ? 100 : 0;
      const date = st.status === 'done' ? (st.done_date ? st.done_date.slice(5).replace('-', '/') + ' 마침' : '마침') : st.target_date ? st.target_date.slice(5).replace('-', '/') + '까지' : '';
      const li = h('li', { class: 'rm-step ' + st.status, 'data-step': st.id }, h('span', { class: 'rm-dot' }), h('div', { class: 'rm-body' }, h('div', { class: 'rm-title' }, h('b', {}, st.title), h('span', { class: 'rm-date' }, date)), st.can_do ? h('div', { class: 'rm-sub' }, st.can_do) : '', st.total ? h('div', { class: 'rm-prog' }, h('span', { class: 'rm-track' }, h('i', { style: `width:${pct}%` })), h('span', {}, `${st.done || 0}/${st.total}`)) : ''));
      if (st.status === 'now' && rm.nearest) {
        const n = rm.nearest;
        li.append(h('div', { class: 'rm-near' }, '가장 가까운 목표' + [n.left_units != null ? ` · 단원 ${n.left_units}개 남음` : '', n.left_lessons != null ? ` · 수업 ${n.left_lessons}번` : ''].join('')));
      }
      list.append(li);
    }
    box.append(list);
  }
  const lists: Array<[string, string[] | undefined]> = [['오늘', rm.today], ['이번 주 (다음 수업까지)', rm.this_week]];
  for (const [k, xs] of lists) if (xs?.length) box.append(h('div', { class: 'rm-todo' }, h('span', { class: 'rm-k' }, k), h('ul', {}, ...xs.map((x) => h('li', {}, x)))));
  body.append(box);
}

// 학생 정보 탭 (10/18): 학생 카드 → 로드맵 → 지금 상태 → 자주 틀린 것 → 배운 문형 → 원본 문서(작게)
// 수업 후 자동화가 묶음(learner)에 줄여 둔 것을 먼저, 없으면 DB·수업 기록에서 같은 모양으로
const PAT_KO: Record<string, string> = { solid: '익숙', practicing: '연습 중', shaky: '흔들림', new: '처음' };
const TREND_KO: Record<string, string> = { better: '줄어듦', same: '그대로', worse: '늘어남', new: '새로' };
function learnerFallback(pack: StudentPack, mem: StudentMemory | null): Learner {
  const L: Learner = {};
  const b = pack.brief;
  const lessons = pack.lessons[0]?.n;
  if (b?.level_hint || lessons) L.card = { level_label: b?.level_hint || '', lessons_total: lessons };
  // 자주 틀린 것: 같은 종류끼리 묶어 횟수
  const by = new Map<string, { label: string; n: number; wrong?: string; right?: string; lastS?: string }>();
  for (const e of mem?.errors || []) {
    const k = e.type + (e.pattern ? ' ' + e.pattern : '');
    const cur = by.get(k) || { label: k, n: 0 };
    cur.n += e.count || 1;
    if (!cur.lastS || (e.last || '') >= cur.lastS) Object.assign(cur, { wrong: e.wrong, right: e.right, lastS: e.last || '' });
    by.set(k, cur);
  }
  if (by.size) L.errors = [...by.values()].sort((a, b) => b.n - a.n).map((e) => ({ label: e.label, n: e.n, wrong: e.wrong, right: e.right }));
  const M: Record<string, 'solid' | 'practicing' | 'shaky' | 'new'> = { mastered: 'solid', practiced: 'practicing', introduced: 'new', uncertain: 'shaky', review: 'shaky' };
  if (pack.db?.grammar.length) L.patterns = pack.db.grammar.map((g) => ({ p: g.p, en: g.en, stage: STAGE_NAMES[(/^L(\d)$/.exec(g.chapter?.level || '') || [])[1] || ''] || g.chapter?.level || '', status: M[g.status] || 'practicing', first: g.first ?? undefined, uses: g.count }));
  else if (mem?.grammar.length) L.patterns = mem.grammar.map((g) => ({ p: g.pattern, en: g.name, status: 'practicing', uses: g.count }));
  if (pack.db?.vocab.length) L.words = { lesson: pack.db.vocab.filter((v) => v.src !== 'cards').length, cards: pack.db.vocab.filter((v) => v.src && v.src !== 'lesson').length, lapsing: pack.db.vocab.filter((v) => v.srs === 'lapsing').length };
  return L;
}
function renderStudent(body: HTMLElement, pack: StudentPack, mem: StudentMemory | null, act: PanelActions) {
  const fb = learnerFallback(pack, mem);
  const L: Learner = { ...fb, ...(pack.packet?.learner || {}) };
  const sec = (title: string, ...kids: Node[]) => h('section', { class: 'mp-sec st-sec' }, h('h4', {}, title), ...kids);
  const more = (rows: HTMLElement[], n: number, wrap: HTMLElement) => {
    rows.slice(0, n).forEach((r) => wrap.append(r));
    if (rows.length > n) {
      const b = h('button', { type: 'button', class: 'linkish st-more' }, `${rows.length - n}개 더 보기`);
      b.addEventListener('click', () => {
        rows.slice(n).forEach((r) => wrap.insertBefore(r, b));
        b.remove();
      });
      wrap.append(b);
    }
    return wrap;
  };
  // 1) 학생 카드
  const c = L.card;
  if (c) {
    const facts = [c.stage, c.level_label, c.lessons_total ? `수업 ${c.lessons_total}번` : '', c.per_week ? `주 ${c.per_week}회` : '', c.since ? c.since.slice(2).replace(/-/g, '.') + '부터' : '', c.native ? `모국어 ${c.native}` : ''].filter((x): x is string => !!x);
    const card = h('div', { class: 'st-card' }, h('div', { class: 'st-facts' }, ...facts.map((f) => h('span', {}, f))));
    if (c.goals?.length) card.append(h('div', { class: 'st-line' }, h('b', {}, '목표'), ' ', c.goals.join(' · ')));
    if (c.interests?.length) card.append(h('div', { class: 'st-line' }, h('b', {}, '좋아하는 것'), ' ', c.interests.join(' · ')));
    if (c.works_well?.length) card.append(h('div', { class: 'st-line' }, h('b', {}, '잘 맞는 방법'), ' ', c.works_well.join(' · ')));
    if (c.avoid?.length) card.append(h('div', { class: 'st-line warn' }, h('b', {}, '피할 것'), ' ', c.avoid.join(' · ')));
    body.append(card);
  }
  // 2) 로드맵 한눈에
  const rm = pack.packet?.roadmap;
  if (rm?.path?.length || rm?.goal_start) renderRoadmap(body, rm);
  // 3) 지금 상태: 익숙한 것 · 흔들리는 것 · 다음
  const nw = L.now;
  if (nw && (nw.solid?.length || nw.shaky?.length || nw.next?.length)) {
    const grid = h('div', { class: 'st-now' });
    const col = (k: string, title: string, xs?: string[]) => xs?.length && grid.append(h('div', { class: 'st-col ' + k }, h('b', {}, title), h('ul', {}, ...xs.map((x) => h('li', {}, x)))));
    col('solid', '익숙해요', nw.solid);
    col('shaky', '흔들려요', nw.shaky);
    col('next', '다음에', nw.next);
    body.append(sec('지금 상태', grid));
  }
  // 4) 자주 틀린 것
  if (L.errors?.length) {
    const rows = L.errors.map((e) =>
      h('div', { class: 'st-err' }, h('div', { class: 'st-err-top' }, h('b', {}, e.label), h('span', { class: 'st-n' }, `${e.n}번`), e.trend ? h('span', { class: 'st-trend ' + e.trend }, TREND_KO[e.trend]) : '', e.last ? h('span', { class: 'st-last' }, `#${e.last}`) : ''), e.wrong || e.right ? h('div', { class: 'st-eg' }, e.wrong ? h('s', {}, e.wrong) : '', e.wrong && e.right ? ' → ' : '', e.right || '') : ''),
    );
    body.append(sec(`자주 틀린 것`, more(rows, 5, h('div', { class: 'st-list' }))));
  }
  // 5) 배운 문형: 상태별 수 + 목록(흔들림·연습 중 먼저)
  if (L.patterns?.length) {
    const order = { shaky: 0, practicing: 1, new: 2, solid: 3 } as Record<string, number>;
    const counts = h('div', { class: 'st-pcount' });
    for (const k of ['shaky', 'practicing', 'new', 'solid']) {
      const n = L.patterns.filter((p) => p.status === k).length;
      if (n) counts.append(h('span', { class: 'st-pc ' + k }, `${PAT_KO[k]} ${n}`));
    }
    const rows = [...L.patterns]
      .sort((a, b) => order[a.status] - order[b.status] || (b.last || b.first || 0) - (a.last || a.first || 0))
      .map((p) => h('div', { class: 'st-pat' }, h('span', { class: 'st-dot ' + p.status, title: PAT_KO[p.status] }), h('b', {}, p.p), h('span', { class: 'st-sub' }, [p.en, p.stage, p.first ? `#${p.first} 처음` : '', p.uses ? `${p.uses}번` : ''].filter(Boolean).join(' · '))));
    body.append(sec(`배운 문형 ${L.patterns.length}`, counts, more(rows, 8, h('div', { class: 'st-list' }))));
  }
  // 6) 단어 한 줄 (자세히는 단어 탭)
  const w = L.words;
  if (w && (w.lesson || w.cards)) body.append(h('p', { class: 'mp-p muted st-words' }, [w.lesson ? `수업에서 배운 말 ${w.lesson}` : '', w.cards ? `카드로 공부 ${w.cards}` : '', w.lapsing ? `자꾸 잊는 말 ${w.lapsing}` : ''].filter(Boolean).join(' · ') + ' — 단어 탭에서 단계별로'));
  // 7) 원본 문서 (작게): 긴 근거 문서는 여기서만
  const docs: Array<[string, string | undefined]> = [['학생 프로필', pack.profile], ['로드맵 문서', pack.roadmap], ['학습 상태 문서', pack.status]];
  const have = docs.filter(([, t]) => t);
  if (have.length) {
    const links = h('div', { class: 'st-docs' }, h('span', {}, '원본 문서'));
    for (const [name, text] of have) {
      const b = h('button', { type: 'button', class: 'linkish' }, name);
      b.addEventListener('click', () => {
        body.innerHTML = '';
        const back = h('button', { type: 'button', class: 'mp-back' }, '← 학생 정보');
        back.addEventListener('click', () => {
          body.innerHTML = '';
          renderStudent(body, pack, mem, act);
        });
        body.append(back, mdToEl(text!));
      });
      links.append(b);
    }
    body.append(links);
  }
  if (!body.childElementCount) body.append(h('p', { class: 'mp-empty' }, '아직 학생 정보가 없어요'));
}
