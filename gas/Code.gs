/**
 * KWD 클래스룸 — Google Apps Script 백엔드 (T083d)
 * 선생님 구글 계정으로 실행. 열쇠(TOKEN)는 Secret.gs(저장소 밖)에 있다. 열쇠가 맞을 때만 답한다.
 * 요청: POST text/plain, 본문 JSON {k, a, ...} → {ok, ...}
 *  ping                       살아 있나
 *  ls  {r, p:[...]}           거울 폴더 목록 (r = 'work' | 'data')
 *  get {r, p:[...]}           거울 파일 읽기 (base64)
 *  rec_put  {id, parts:[{n,s,e,b}]}  녹화 조각 올리기: 작업중/<id>/<트랙>.p<시작>_<끝> (이미 있으면 건너뜀 → 다시 보내도 안전)
 *  rec_done {id, tracks:{트랙:조각수}, meta:'_rec.json 트랙 이름'}  끝 표시: _done.json (맨 마지막에 올린다)
 */
var MIRROR = '00_KWD_거울';
var LANDING = ['01_현재 업무', '한국어 수업', '작업중'];
var MAX_GET = 24 * 1024 * 1024;
// 판이 읽는 곳만 (src/kwdfolder.ts의 sub(work, …)·student_info.json). 새 폴더를 읽게 되면 여기에 한 줄 더한다.
var ALLOW = {
  work: ['Student_Lessons', 'board_data', 'curriculum_v2', 'intake', 'lesson_packets'],
  data: ['student_info.json']
};
var BAD_MAX = 10, BAD_WINDOW_MS = 3600 * 1000, LOCK_MS = 3600 * 1000;

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out_({ ok: true, name: 'kwd-classroom' }); }

function doPost(e) {
  try {
    var q = JSON.parse(e.postData.contents);
    if (locked_()) return out_({ ok: false, error: 'locked' });
    if (typeof TOKEN === 'undefined' || !TOKEN || q.k !== TOKEN) { bad_(); return out_({ ok: false, error: 'auth' }); }
    var f = ACT[q.a];
    if (!f) return out_({ ok: false, error: 'action' });
    var r = f(q);
    r.ok = true;
    return out_(r);
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---- 틀린 열쇠 잠금 (ScriptProperties: 웹앱 전체에 하나) ----
function locked_() {
  var until = Number(PropertiesService.getScriptProperties().getProperty('lockUntil') || 0);
  return until > new Date().getTime();
}
function bad_() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { return; }
  try {
    var pr = PropertiesService.getScriptProperties(), now = new Date().getTime();
    var since = Number(pr.getProperty('badSince') || 0), n = Number(pr.getProperty('badN') || 0);
    if (now - since > BAD_WINDOW_MS) { since = now; n = 0; }
    n++;
    var put = { badSince: String(since), badN: String(n) };
    if (n >= BAD_MAX) { put.lockUntil = String(now + LOCK_MS); put.badN = '0'; put.badSince = '0'; }
    pr.setProperties(put);
  } finally { lock.releaseLock(); }
}
/** 잠금을 바로 풀 때: 편집기에서 실행 */
function unlock() {
  PropertiesService.getScriptProperties().setProperties({ lockUntil: '0', badN: '0', badSince: '0' });
}

// ---- 읽어도 되는 경로 ----
function rootOf_(r) { return r === 'data' ? 'data' : 'work'; }
function safeSeg_(x) {
  var s = String(x);
  return !!s && s.length <= 200 && s.charAt(0) !== '.' && !/[\/]/.test(s) && !/^private$/i.test(s);
}
// 폴더 경로 p(파일 이름 포함 가능)가 허용 목록 안인가. p가 비면(맨 위 목록) 허용하되 목록을 거른다.
function allowed_(r, p) {
  for (var i = 0; i < p.length; i++) if (!safeSeg_(p[i])) return false;
  if (!p.length) return true;
  return ALLOW[rootOf_(r)].indexOf(String(p[0])) >= 0;
}

function child_(folder, name) {
  var it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function path_(root, names, create) {
  var f = root;
  for (var i = 0; i < names.length; i++) {
    var c = child_(f, names[i]);
    if (!c) {
      if (!create) return null;
      c = f.createFolder(names[i]);
    }
    f = c;
  }
  return f;
}
function cached_(key, make) {
  var c = CacheService.getScriptCache();
  var id = c.get(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 지워졌으면 다시 */ } }
  var f = make();
  if (f) c.put(key, f.getId(), 21600);
  return f;
}
function landing_() { return cached_('landing', function () { return path_(DriveApp.getRootFolder(), LANDING, true); }); }
function mirror_(r) {
  var name = r === 'data' ? 'data' : 'work';
  return cached_('mirror:' + name, function () { return path_(DriveApp.getRootFolder(), [MIRROR, name], false); });
}
function dir_(r, p) {
  var base = mirror_(r);
  if (!base) throw new Error('mirror');
  var f = path_(base, p || [], false);
  if (!f) throw new Error('notfound');
  return f;
}

var ACT = {
  ping: function () { return { t: new Date().getTime() }; },

  ls: function (q) {
    var p = q.p || [];
    if (!allowed_(q.r, p)) throw new Error('denied');
    var d = dir_(q.r, p), out = [];
    var fs = d.getFolders();
    while (fs.hasNext()) { var x = fs.next(); out.push({ n: x.getName(), d: 1 }); }
    var it = d.getFiles();
    while (it.hasNext()) { var y = it.next(); out.push({ n: y.getName(), d: 0, s: y.getSize(), m: y.getLastUpdated().getTime() }); }
    if (!p.length) out = out.filter(function (x) { return ALLOW[rootOf_(q.r)].indexOf(x.n) >= 0; });
    else out = out.filter(function (x) { return safeSeg_(x.n); });
    return { list: out };
  },

  get: function (q) {
    var p = (q.p || []).slice();
    if (!p.length || !allowed_(q.r, p)) throw new Error('denied');
    var name = p.pop();
    var d = dir_(q.r, p);
    var it = d.getFilesByName(name);
    if (!it.hasNext()) throw new Error('notfound');
    var f = it.next();
    if (f.getSize() > MAX_GET) throw new Error('big');
    var b = f.getBlob();
    return { b: Utilities.base64Encode(b.getBytes()), s: f.getSize(), m: f.getLastUpdated().getTime(), t: b.getContentType() };
  },

  rec_put: function (q) {
    var id = String(q.id || '').replace(/[\\/:*?"<>|]/g, '_');
    if (!id) throw new Error('id');
    var d = path_(landing_(), [id], true);
    var n = 0, skipped = 0;
    (q.parts || []).forEach(function (p) {
      var nm = p.n + '.p' + ('0000000' + p.s).slice(-7) + '_' + ('0000000' + p.e).slice(-7);
      if (d.getFilesByName(nm).hasNext()) { skipped++; return; }
      d.createFile(Utilities.newBlob(Utilities.base64Decode(p.b), 'application/octet-stream', nm));
      n++;
    });
    return { saved: n, skipped: skipped };
  },

  rec_done: function (q) {
    var id = String(q.id || '').replace(/[\\/:*?"<>|]/g, '_');
    var d = path_(landing_(), [id], true);
    var old = d.getFilesByName('_done.json');
    while (old.hasNext()) old.next().setTrashed(true);
    d.createFile('_done.json', JSON.stringify({ schema: 'kwd-rec-parts/v1', id: id, tracks: q.tracks || {}, meta: q.meta || '', at: new Date().toISOString() }), 'application/json');
    return { done: true };
  }
};

/** 처음 한 번만: 편집기에서 이 함수를 실행해 권한을 허용한다 (드라이브 접근). */
function authorize() {
  var m = mirror_('work');
  var l = landing_();
  Logger.log('거울: ' + (m ? m.getName() : '없음') + ' · 작업중: ' + (l ? l.getName() : '없음') + ' · 열쇠 ' + (typeof TOKEN !== 'undefined' && TOKEN ? '있음' : '없음'));
}
