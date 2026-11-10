// 판 서버 방 쓰기 토큰 받기 (T136ak A07-F09). 선생님 토큰은 환경변수 KWD_TEACHER_TOKEN 에서만(파일에서 읽지 않음).
// 끊은 교실 코드(403)면 실패, 옛 서버·로컬 서버(/wt 없음)·연결 실패면 빈 토큰 → 예전처럼 연결
async function roomWt(server, room) {
  const base = server.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '');
  const tk = process.env.KWD_TEACHER_TOKEN || '';
  let r;
  try {
    r = await fetch(`${base}/wt?room=${encodeURIComponent(room)}`, { headers: tk ? { authorization: 'Bearer ' + tk } : {}, signal: AbortSignal.timeout(8000) });
  } catch {
    return '';
  }
  if (r.status === 403) throw new Error('blocked');
  try {
    return (await r.json()).wt || '';
  } catch {
    return '';
  }
}
module.exports = { roomWt };
