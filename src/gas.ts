// 클래스룸 구글 드라이브 연결 (T083d): 선생님 구글 계정의 Apps Script 웹앱 하나.
// 열쇠는 선생님 링크(?k=…)로 이 기기에 처음 한 번 저장한다. 열쇠가 없으면 이름·녹화·자료는 아무것도 오지 않는다.
// 이 파일에는 주소만 있고 열쇠·학생 이름은 없다 (공개 저장소).
export const GAS_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycby_GBvb4d8zqXCZ97eXJdMTyYAZ5bHLe8g-84FagIoejv5xa0Bgj80Ayq7Egy8A-0S91Q/exec';
const KEY = 'kwd.gasKey';
const URL_KEY = 'kwd.gasUrl';

const ls = {
  get(k: string): string {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* 저장소 막힘 */
    }
  },
};

export const gasKey = () => ls.get(KEY);
// T136ak(A07-F09): 녹화를 올릴 곳은 구글 Apps Script 웹앱 주소만. 링크의 &g= 나 저장된 값이 다른 곳이면 버린다
export const safeGasUrl = (u: string) => (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,120}\/exec$/.test(u) ? u : '');
export const gasUrl = () => safeGasUrl(ls.get(URL_KEY)) || GAS_URL_DEFAULT;
export const gasReady = () => !!gasKey() && !!gasUrl();
export function setGas(key: string, url = '') {
  ls.set(KEY, key);
  if (url && safeGasUrl(url)) ls.set(URL_KEY, url);
  else if (url) console.warn('[kwd] 녹화 올릴 주소가 구글 웹앱 주소가 아니라 쓰지 않아요');
}

// 주소의 ?k=열쇠(&g=웹앱 주소)를 저장하고 주소에서 지운다. 해시 안(#/t/…?k=)과 일반 쿼리(?k=) 둘 다.
export function takeGasKeyFromLocation(): boolean {
  let got = false;
  const take = (q: URLSearchParams) => {
    const k = q.get('k');
    if (k && /^[\w-]{16,80}$/.test(k)) {
      setGas(k, q.get('g') || '');
      got = true;
    }
    q.delete('k');
    q.delete('g');
  };
  const sp = new URLSearchParams(location.search);
  take(sp);
  const hash = location.hash;
  const i = hash.indexOf('?');
  let h2 = hash;
  if (i >= 0) {
    const hp = new URLSearchParams(hash.slice(i + 1));
    take(hp);
    const rest = hp.toString();
    h2 = hash.slice(0, i) + (rest ? '?' + rest : '');
  }
  if (got || h2 !== hash) {
    const s = sp.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + h2);
  }
  return got;
}

export class GasError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// text/plain 으로 보내면 사전 요청(preflight) 없이 간다. 응답은 구글이 CORS 를 열어 준다.
export async function gasCall<T = Record<string, unknown>>(a: string, body: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T & { ok: true }> {
  const key = gasKey();
  if (!key) throw new GasError('nokey');
  const ctl = new AbortController();
  const to = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(gasUrl(), { method: 'POST', body: JSON.stringify({ k: key, a, ...body }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal });
    const j = (await r.json()) as { ok?: boolean; error?: string };
    if (!j.ok) throw new GasError(j.error || 'fail');
    return j as T & { ok: true };
  } catch (e) {
    if (e instanceof GasError) throw e;
    throw new GasError('net');
  } finally {
    window.clearTimeout(to);
  }
}
