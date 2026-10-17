// 판 목록 화면: 학생 번호로 새 판을 열거나 지난 판을 연다. 화면에 필요한 것 하나 — 목록.
import { loadIndex, saveIndex, randomId, getServerUrl, setServerUrl } from './store';
import { h, fmtDateTime, toast } from './ui';

export class HomeScreen {
  readonly root: HTMLElement;

  constructor() {
    this.root = h('div', { class: 'home' });
    this.render();
  }

  private render() {
    this.root.innerHTML = '';
    const list = loadIndex();
    const title = h('h1', {}, 'KWD 수업 판');
    const form = h('form', { class: 'new-board' });
    const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: '학생 번호', 'aria-label': '학생 번호', autocomplete: 'off' }) as HTMLInputElement;
    const btn = h('button', { type: 'submit', class: 'primary' }, '새 수업');
    form.append(input, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const student = input.value.trim();
      if (!student) {
        input.focus();
        return;
      }
      const id = randomId(10);
      location.hash = `#/b/${id}?r=t&st=${encodeURIComponent(student)}`;
    });

    const ul = h('div', { class: 'board-list' });
    if (!list.length) ul.append(h('p', { class: 'empty' }, '아직 수업이 없어요. 학생 번호를 넣고 새 수업을 여세요.'));
    for (const b of list) {
      const row = h('a', { class: 'board-row', href: `#/b/${b.id}?r=t` });
      row.append(
        h('span', { class: 'br-student' }, b.student ? `학생 ${b.student}` : '판'),
        h('span', { class: 'br-date' }, fmtDateTime(b.lastAt || b.createdAt)),
              );
      const del = h('button', { type: 'button', class: 'br-del', title: '목록에서 빼기 (판은 지워지지 않음)' }, '×');
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 한 번 누르면 확인, 두 번째에 뺀다
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
        this.render();
      });
      row.append(del);
      ul.append(row);
    }

    const srv = getServerUrl();
    const foot = h('div', { class: 'home-foot' });
    const srvBtn = h('button', { type: 'button', class: 'linkish' }, srv ? '여러 기기 연결됨 · 바꾸기' : '이 기기에만 저장 중 · 여러 기기 연결');
    const srvForm = h('form', { class: 'open-code', hidden: '' });
    const srvInput = h('input', { type: 'url', placeholder: 'wss://… (비우면 이 기기에서만)', value: srv, 'aria-label': '서버 주소' }) as HTMLInputElement;
    srvForm.append(srvInput, h('button', { type: 'submit' }, '저장'));
    srvForm.addEventListener('submit', (e) => {
      e.preventDefault();
      setServerUrl(srvInput.value.trim());
      toast(srvInput.value.trim() ? '저장했어요' : '서버 없이 씁니다');
      this.render();
    });
    srvBtn.addEventListener('click', () => {
      srvForm.hidden = !srvForm.hidden;
      if (!srvForm.hidden) srvInput.focus();
    });
    const open = h('form', { class: 'open-code' });
    const codeInput = h('input', { type: 'text', placeholder: '받은 판 링크나 방 코드로 열기', 'aria-label': '방 코드' }) as HTMLInputElement;
    const openBtn = h('button', { type: 'submit' }, '열기');
    open.append(codeInput, openBtn);
    open.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = codeInput.value.trim();
      if (!v) return;
      const m = /#\/b\/([a-z0-9]+)(\?.*)?/i.exec(v);
      if (m) location.hash = `#/b/${m[1]}${m[2] || '?r=t'}`;
      else location.hash = `#/b/${v}?r=t`;
    });
    foot.append(open, srvBtn, srvForm);

    this.root.append(title, form, ul, foot);
    window.setTimeout(() => input.focus(), 0);
  }

  destroy() {
    this.root.remove();
  }
}
