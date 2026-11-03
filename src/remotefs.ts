// 구글 드라이브 거울(00_KWD_거울/work)을 폴더 손잡이처럼 읽는 가짜 폴더 (T083d). 읽기 전용, 필요한 것만 그때그때 가져온다.
// kwdfolder.ts 의 읽기 코드는 손잡이만 보므로, 선생님이 폴더를 고르지 않아도 그대로 돈다.
import { gasCall } from './gas';

interface Ent {
  n: string;
  d: number;
  s?: number;
  m?: number;
}
const TTL = 120_000;
const lists = new Map<string, { at: number; p: Promise<Ent[]> }>();

function nf(): DOMException {
  return new DOMException('not found', 'NotFoundError');
}

function listOf(root: string, path: string[]): Promise<Ent[]> {
  const key = root + '/' + path.join('/');
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = gasCall<{ list: Ent[] }>('ls', { r: root, p: path }).then((r) => r.list);
  lists.set(key, { at: Date.now(), p });
  p.catch(() => lists.delete(key)); // 실패는 기억하지 않는다
  return p;
}
export function forgetRemoteCache() {
  lists.clear();
}

export class RemoteFile {
  readonly kind = 'file';
  constructor(readonly name: string, private root: string, private path: string[], private ent: Ent) {}
  async getFile(): Promise<File> {
    const r = await gasCall<{ b: string; t: string; m: number }>('get', { r: this.root, p: [...this.path, this.name] });
    const bin = atob(r.b);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new File([u], this.name, { type: r.t && r.t !== 'application/octet-stream' ? r.t : '', lastModified: r.m || this.ent.m || Date.now() });
  }
}

export class RemoteDir {
  readonly kind = 'directory';
  constructor(readonly name: string, private root: string = 'work', private path: string[] = []) {}
  async getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<RemoteDir> {
    if (o?.create) throw new DOMException('read only', 'NotAllowedError');
    const e = (await listOf(this.root, this.path)).find((x) => x.n === n && x.d);
    if (!e) throw nf();
    return new RemoteDir(n, this.root, [...this.path, n]);
  }
  async getFileHandle(n: string, o?: { create?: boolean }): Promise<RemoteFile> {
    if (o?.create) throw new DOMException('read only', 'NotAllowedError');
    const e = (await listOf(this.root, this.path)).find((x) => x.n === n && !x.d);
    if (!e) throw nf();
    return new RemoteFile(n, this.root, this.path, e);
  }
  async *entries(): AsyncIterableIterator<[string, RemoteDir | RemoteFile]> {
    for (const e of await listOf(this.root, this.path)) yield [e.n, e.d ? new RemoteDir(e.n, this.root, [...this.path, e.n]) : new RemoteFile(e.n, this.root, this.path, e)];
  }
}

export const remoteWork = () => new RemoteDir('work (구글 드라이브)');
