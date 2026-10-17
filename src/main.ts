import './styles.css';
import { HomeScreen } from './home';
import { BoardScreen } from './board';
import type { Role } from './store';
import { setWorkHandleForTest, listStudents } from './kwdfolder';

// 시험용 손잡이 (자동 시험이 실제 폴더 대신 OPFS 폴더를 넣는다)
(window as unknown as { __kwdFolder?: unknown }).__kwdFolder = { setWorkHandleForTest, listStudents, rerender: () => route() };

let current: { destroy(): void } | null = null;

function parseRoute(): { kind: 'home' } | { kind: 'board'; id: string; role: Role; student?: string; server?: string; token?: string } {
  const hash = location.hash.replace(/^#/, '');
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
  current = null;
  const r = parseRoute();
  document.body.className = r.kind === 'board' ? `in-board role-${r.role}` : 'in-home';
  if (r.kind === 'home') {
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

window.addEventListener('hashchange', route);
route();
