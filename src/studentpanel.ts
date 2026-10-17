// '이 학생' 패널 (선생님 화면만): 오늘 · 수업안 · 자료 · 학생 · 지난 수업 · 단어
// KWD 폴더에서 읽은 것을 그대로 보여 주고, 한 번 눌러 판에 넣는다.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { h, fmtDate } from './ui';
import { vocabNote, type StudentMemory } from './memory';
import type { StudentPack, PackFile } from './kwdfolder';

export interface PanelActions {
  insertLine(line: string): void; // 판의 지금 줄 아래에
  placeFile(f: PackFile): Promise<void>; // 자료를 판에 (html=창, pdf=페이지, 그림=사진)
  readLessonDoc(name: string): Promise<string>;
  otherBoards(): Array<{ id: string; createdAt: number }>;
  close(): void;
}

export type PanelTab = 'today' | 'plan' | 'student' | 'lessons' | 'vocab';

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
    student: !!(pack.profile || pack.roadmap || pack.status),
    lessons: pack.lessons.length > 0,
    vocab: !!mem?.vocab.length,
  };
  const labels: Record<PanelTab, string> = { today: '오늘', plan: '수업안·자료', student: '학생 정보', lessons: '지난 수업', vocab: '단어' };
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
      const KIND: Record<string, string> = { html: '웹 학습지', pdf: 'PDF', img: '사진', md: '문서' };
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

function details(title: string, content: HTMLElement, open: boolean): HTMLElement {
  const d = h('details', { class: 'mp-det' });
  if (open) d.setAttribute('open', '');
  d.append(h('summary', {}, title), content);
  return d;
}
