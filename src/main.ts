import './styles.css';
import { clearToast } from './ui';
import { HomeScreen } from './home';
import { BoardScreen } from './board';
import type { Role } from './store';
import { setWorkHandleForTest, listStudents, isDemo, setDemo, useDemoFolder } from './kwdfolder';
import { DemoScreen, type DemoView } from './demo';
import { h } from './ui';

// 시험용 손잡이 (자동 시험이 실제 폴더 대신 OPFS 폴더를 넣는다)
(window as unknown as { __kwdFolder?: unknown }).__kwdFolder = { setWorkHandleForTest, listStudents, rerender: () => route() };

let current: { destroy(): void } | null = null;

function parseRoute(): { kind: 'home' } | { kind: 'demo'; view?: DemoView } | { kind: 'board'; id: string; role: Role; student?: string; server?: string; token?: string } {
  const hash = location.hash.replace(/^#/, '');
  const d = /^\/demo(?:\/(phone|tablet|pen|split))?\/?$/.exec(hash);
  if (d) return { kind: 'demo', view: d[1] as DemoView | undefined };
  const m = /^\/b\/([a-z0-9]{4,})(?:\?(.*))?$/i.exec(hash);
  if (!m) return { kind: 'home' };
  const q = new URLSearchParams(m[2] || '');
  const r = (q.get('r') || 't').toLowerCase();
  const role: Role = r.startsWith('s') ? 'student' : r.startsWith('a') ? 'assist' : 'teacher';
  return { kind: 'board', id: m[1].toLowerCase(), role, student: q.get('st') || undefined, server: q.get('srv') || undefined, token: q.get('tk') || undefined };
}

function route() {
  const app = document.getElementById('app')!;
  current?.destroy();
  clearToast();
  current = null;
  const r = parseRoute();
  document.body.className = r.kind === 'board' ? `in-board role-${r.role}` : r.kind === 'demo' ? 'in-demo' : 'in-home';
  demoBadge(r.kind !== 'demo' && isDemo() && window.self === window.top);
  if (r.kind === 'demo') {
    const s = new DemoScreen(r.view);
    app.append(s.root);
    current = s;
  } else if (r.kind === 'home') {
    const s = new HomeScreen();
    app.append(s.root);
    current = s;
  } else {
    const s = new BoardScreen({ id: r.id, role: r.role, student: r.student, server: r.server, token: r.token });
    app.append(s.root);
    current = s;
    // 학생 번호는 처음 열 때만 주소에 둔다
    if (r.student || r.token) history.replaceState(null, '', `#/b/${r.id}?r=${r.role[0]}${r.server ? `&srv=${encodeURIComponent(r.server)}` : ''}`);
  }
}

// 체험 중이면 위에 작은 표시 (끝내면 진짜 폴더로 돌아간다)
function demoBadge(on: boolean) {
  let el = document.querySelector('.demo-badge') as HTMLElement | null;
  if (!on) {
    el?.remove();
    return;
  }
  if (el) return;
  el = h('div', { class: 'demo-badge' }, h('span', {}, '체험 중 (가짜 학생·폴더)'));
  const back = h('a', { href: '#/demo' }, '체험 고르기');
  const quit = h('button', { type: 'button' }, '끝내기');
  quit.addEventListener('click', () => {
    setDemo(false);
    location.hash = '#/';
    route();
  });
  el.append(back, quit);
  document.body.append(el);
}

window.addEventListener('hashchange', route);
if (isDemo()) void useDemoFolder().then(route);
else route();
