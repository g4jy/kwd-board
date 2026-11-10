// T136ak 시험 (A05-F18): gas/Code.gs 를 가짜 구글(DriveApp·PropertiesService 등)에 올려
// ① 허용 목록 밖(data/private·secrets·'.' 로 시작·'..')은 거절, 판이 읽는 곳은 그대로 ② 틀린 열쇠 10번이면 1시간 잠금, unlock() 으로 풂
// 진짜 구글·Secret.gs 는 쓰지 않는다 (열쇠는 시험 값).
import vm from 'node:vm';
import fs from 'node:fs';

const KEY = 'testkey-gas-0123456789';
let now = Date.UTC(2026, 10, 11, 0, 0, 0);
class FakeDate extends Date {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
}
let nid = 0;
class File {
  constructor(name, body) {
    this.name = name;
    this.body = Buffer.from(body);
  }
  getName() { return this.name; }
  getSize() { return this.body.length; }
  getLastUpdated() { return new Date(now); }
  getBlob() { return { getBytes: () => [...this.body], getContentType: () => 'text/plain' }; }
}
class Folder {
  constructor(name, kids = {}) {
    this.name = name;
    this.id = 'f' + nid++;
    this.kids = kids;
  }
  getName() { return this.name; }
  getId() { return this.id; }
  it(list) { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; }
  getFolders() { return this.it(Object.values(this.kids).filter((x) => x instanceof Folder)); }
  getFiles() { return this.it(Object.values(this.kids).filter((x) => x instanceof File)); }
  getFoldersByName(n) { return this.it(this.kids[n] instanceof Folder ? [this.kids[n]] : []); }
  getFilesByName(n) { return this.it(this.kids[n] instanceof File ? [this.kids[n]] : []); }
  createFolder(n) { return (this.kids[n] = new Folder(n)); }
  createFile(n, b) { return (this.kids[n] = new File(n, typeof b === 'string' ? b : 'x')); }
}
const F = (n, kids) => new Folder(n, Object.fromEntries(kids.map((k) => [k.name, k])));
const root = F('root', [
  F('00_KWD_거울', [
    F('work', [
      F('Student_Lessons', [F('S900', [new File('a.md', 'lesson')])]),
      F('board_data', [new File('S900.json', '{}')]),
      F('secrets', [new File('k.txt', 'SECRET')]),
      new File('.env', 'X=1'),
      F('.git', [new File('config', 'x')]),
    ]),
    F('data', [new File('student_info.json', '{"students":[]}'), new File('other.json', '{}'), F('private', [new File('p.json', 'PRIV')])]),
  ]),
]);
const byId = {};
(function walk(f) {
  byId[f.id] = f;
  for (const k of Object.values(f.kids)) if (k instanceof Folder) walk(k);
})(root);
const props = {};
const cache = {};
const ctx = {
  TOKEN: KEY,
  Date: FakeDate,
  JSON,
  String,
  Number,
  Error,
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperties: (o) => Object.assign(props, o) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => (cache[k] = v) }) },
  DriveApp: { getRootFolder: () => root, getFolderById: (id) => byId[id] },
  Utilities: { base64Encode: (b) => Buffer.from(b).toString('base64'), base64Decode: (s) => [...Buffer.from(s, 'base64')], newBlob: (b) => b },
  Logger: { log() {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), ctx);
const call = (o) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).s);
const ok = (o) => call({ k: KEY, ...o });

const r = {};
const top = ok({ a: 'ls', r: 'work', p: [] });
r.topList = (top.list || []).map((x) => x.n).sort();
r.lessons = ok({ a: 'ls', r: 'work', p: ['Student_Lessons'] }).ok;
r.lessonFile = ok({ a: 'get', r: 'work', p: ['Student_Lessons', 'S900', 'a.md'] }).ok;
r.boardData = ok({ a: 'get', r: 'work', p: ['board_data', 'S900.json'] }).ok;
r.info = ok({ a: 'get', r: 'data', p: ['student_info.json'] }).ok;
r.dataTop = (ok({ a: 'ls', r: 'data', p: [] }).list || []).map((x) => x.n).sort();
const deny = {
  private_get: ok({ a: 'get', r: 'data', p: ['private', 'p.json'] }),
  private_ls: ok({ a: 'ls', r: 'data', p: ['private'] }),
  data_other: ok({ a: 'get', r: 'data', p: ['other.json'] }),
  secrets: ok({ a: 'get', r: 'work', p: ['secrets', 'k.txt'] }),
  dotenv: ok({ a: 'get', r: 'work', p: ['.env'] }),
  git: ok({ a: 'ls', r: 'work', p: ['.git'] }),
  dotdot: ok({ a: 'get', r: 'work', p: ['Student_Lessons', '..', 'secrets', 'k.txt'] }),
  slash: ok({ a: 'get', r: 'work', p: ['Student_Lessons/../secrets', 'k.txt'] }),
  get_empty: ok({ a: 'get', r: 'work', p: [] }),
};
r.denied = Object.fromEntries(Object.entries(deny).map(([k, v]) => [k, v.ok === false && v.error === 'denied']));
// 틀린 열쇠: 9번까지는 auth, 10번째에 잠금 → 맞는 열쇠도 locked
const bad = [];
for (let i = 0; i < 10; i++) bad.push(call({ k: 'wrong' + i, a: 'ping' }).error);
r.bad10 = bad.every((e) => e === 'auth');
r.afterLock = call({ k: KEY, a: 'ping' }).error;
now += 59 * 60_000;
r.after59m = call({ k: KEY, a: 'ping' }).error;
now += 2 * 60_000;
r.after61m = call({ k: KEY, a: 'ping' }).ok;
// 9번 틀리고 1시간 지나면 다시 셈 (잠기지 않음)
for (let i = 0; i < 9; i++) call({ k: 'w', a: 'ping' });
now += 61 * 60_000;
call({ k: 'w', a: 'ping' });
r.windowReset = call({ k: KEY, a: 'ping' }).ok;
// unlock() 으로 바로 풂
for (let i = 0; i < 10; i++) call({ k: 'w', a: 'ping' });
r.lockedAgain = call({ k: KEY, a: 'ping' }).error;
ctx.unlock();
r.unlocked = call({ k: KEY, a: 'ping' }).ok;
const pass =
  JSON.stringify(r.topList) === JSON.stringify(['Student_Lessons', 'board_data']) &&
  JSON.stringify(r.dataTop) === JSON.stringify(['student_info.json']) &&
  r.lessons && r.lessonFile && r.boardData && r.info &&
  Object.values(r.denied).every(Boolean) &&
  r.bad10 && r.afterLock === 'locked' && r.after59m === 'locked' && r.after61m && r.windowReset && r.lockedAgain === 'locked' && r.unlocked;
console.log(JSON.stringify({ pass, ...r }));
