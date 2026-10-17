// 체험 화면용 가짜 KWD 폴더 만들기 → public/demo/
// 학생·수업은 전부 지어낸 것. 실제 학생 자료는 쓰지 않는다.
//   node scripts/make-demo.mjs [소리 폴더]   (소리 폴더에 hw.ogg·listen.ogg 가 있으면 넣는다)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = 'public/demo';
const W = OUT + '/work';
const AUD = process.argv[2] || '';
fs.rmSync(OUT, { recursive: true, force: true });
const S = 'Student_Lessons/Mina K (9000001)/';
const T = 'Student_Lessons/Tom (pending-student-demo)/';
const files = [];
// 한글·# 이 든 이름은 정적 서버마다 다르게 다뤄서, 실제 파일은 f00.확장자 로 두고 목록에 원래 경로를 적는다
const put = (p, data) => {
  const ext = (/\.[a-z0-9]+$/i.exec(p) || [''])[0];
  const f = 'f' + String(files.length).padStart(2, '0') + ext;
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, f), data);
  files.push({ p, f });
};
const FONT = `font-family:'Noto Sans CJK KR','Noto Sans KR',sans-serif`;

const b = await chromium.launch();
const page = await b.newPage();
const pdf = async (html, opts) => {
  await page.setContent(html, { waitUntil: 'load' });
  return page.pdf({ printBackground: true, ...opts });
};
const png = async (html, w, h) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  return page.screenshot({ type: 'png' });
};
const jpg = async (html, w, h) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  return page.screenshot({ type: 'jpeg', quality: 78 });
};

// 1) 수업 슬라이드 PDF (16:9, 6장)
const slide = (bg, inner) => `<section style="width:1280px;height:720px;page-break-after:always;box-sizing:border-box;padding:70px 90px;background:${bg};${FONT};position:relative;overflow:hidden">${inner}</section>`;
const slides = [
  slide('#1f3b57', `<div style="color:#ffd27a;font-size:34px">#12 · 10월 17일</div><h1 style="color:#fff;font-size:96px;margin:30px 0 10px">추석에 뭐 했어요?</h1><p style="color:#cfe3f5;font-size:40px">-았/었어요 · -(으)ㄹ 거예요 · 맛 형용사</p><div style="position:absolute;right:80px;bottom:60px;font-size:150px">🌕</div>`),
  slide('#fffaf0', `<h2 style="font-size:60px;color:#1f3b57;margin:0 0 30px">워밍업</h2><ol style="font-size:46px;line-height:1.7;color:#333"><li>지난 주말에 뭐 했어요?</li><li>추석에 누구를 만났어요?</li><li>무슨 음식을 먹었어요?</li></ol>`),
  slide('#fff', `<h2 style="font-size:60px;color:#1f3b57;margin:0 0 20px">새 단어</h2><table style="font-size:44px;border-collapse:collapse;width:100%">${[['송편', 'songpyeon (rice cake)'], ['차례', 'ancestral rite'], ['고향', 'hometown'], ['성묘', 'visiting graves'], ['보름달', 'full moon'], ['친척', 'relatives']].map(([k, e]) => `<tr><td style="padding:10px 20px;border-bottom:2px solid #eee;font-weight:700">${k}</td><td style="padding:10px 20px;border-bottom:2px solid #eee;color:#777">${e}</td></tr>`).join('')}</table>`),
  slide('#eef6ee', `<h2 style="font-size:60px;color:#245c2b;margin:0 0 30px">문형: -았/었어요</h2><p style="font-size:44px;line-height:1.8">가다 → <b>갔어요</b><br>먹다 → <b>먹었어요</b><br>만들다 → <b>만들었어요</b><br>하다 → <b>했어요</b></p><p style="font-size:38px;color:#555">추석에 송편을 ________.</p>`),
  slide('#fff4f4', `<h2 style="font-size:60px;color:#8a2b2b;margin:0 0 30px">맛 형용사</h2><div style="display:flex;gap:30px;font-size:52px">${['달아요 🍯', '짜요 🧂', '매워요 🌶️', '셔요 🍋'].map((x) => `<div style="flex:1;background:#fff;border-radius:24px;padding:40px 10px;text-align:center;box-shadow:0 4px 0 #f0caca">${x}</div>`).join('')}</div><p style="font-size:40px;margin-top:50px">송편은 어때요? — ________</p>`),
  slide('#1f3b57', `<h2 style="font-size:64px;color:#fff;margin:0 0 30px">말해 봐요</h2><p style="color:#fff;font-size:46px;line-height:1.7">다음 추석에 뭐 <b style="color:#ffd27a">할 거예요?</b><br>누구하고 <b style="color:#ffd27a">갈 거예요?</b></p><p style="color:#cfe3f5;font-size:36px">→ 숙제: 추석 이야기 3문장 쓰고 녹음하기</p>`),
];
put(S + '수업준비/#12_슬라이드.pdf', await pdf(`<html><body style="margin:0">${slides.join('')}</body></html>`, { width: '1280px', height: '720px' }));

// 2) 수업 페이지: 인터랙티브 웹 학습지 (7단계 · 애니메이션 · 고르기 · 끌어다 놓기 · 문장 만들기)
//    학습지가 단계를 판에 알려 주면(kwd.step) 판은 그 단계의 필기만 보여 주고, 고른 것은 학생·선생님 화면이 같이 움직인다(kwd.state)
put(S + '수업준비/#12_수업페이지.html', fs.readFileSync('scripts/demo-lesson.html', 'utf8'));

// 4) 읽을거리 (마크다운) · 수업안 · 과제 초안
put(S + '수업준비/#12_수업안.md', `# #12 수업안 — 추석 이야기\n\n## 목표\n- -았/었어요로 추석에 한 일 3문장 말하기\n- 맛 형용사 4개 (달다·짜다·맵다·시다)\n\n## 흐름 (50분)\n1. 대화 8분 — 주말·추석 이야기\n2. 과제 피드백 10분 — 받침 ㅆ, 녹음 발음 2개\n3. 수업 27분 — 수업 페이지 1→6단계, 듣기 영상\n4. 마무리 5분 — 오늘 과제 안내\n\n## 복습\n- 지난 시간: 날씨, 맛있어요, -고 싶어요\n`);
put(S + '수업준비/#12_과제_초안.md', `# #12 과제\n\n1. 추석에 한 일 3문장 쓰기 (-았/었어요)\n2. 쓴 것을 읽고 녹음하기\n3. 좋아하는 한국 음식 사진 1장 + 맛 한 줄\n`);

// 5) 사진 자료 (수업에 보여 줄 그림)
put(
  S + '수업준비/#12_시장사진.png',
  await png(
    `<body style="margin:0;width:900px;height:600px;background:linear-gradient(#ffe2b8,#fff3df);${FONT};position:relative;overflow:hidden"><div style="position:absolute;top:40px;left:50px;font-size:48px;font-weight:800;color:#7a3e00">추석 시장</div>${['🍐', '🍎', '🌰', '🍡', '🥮', '🍶'].map((e, i) => `<div style="position:absolute;left:${70 + (i % 3) * 270}px;top:${160 + Math.floor(i / 3) * 210}px;width:220px;height:170px;background:#fff;border-radius:22px;box-shadow:0 6px 0 #e7c79a;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:80px">${e}<div style="font-size:26px;color:#7a3e00">${['배', '사과', '밤', '송편', '월병', '식혜'][i]} ${['5,000원', '3,000원', '2,000원', '8,000원', '4,000원', '2,500원'][i]}</div></div>`).join('')}</body>`,
    900,
    600,
  ),
);

// 6) 학생이 낸 과제: 손글씨 공책 사진 · 글 · 녹음
put(
  S + '과제/#11_숙제_손글씨.jpg',
  await jpg(
    `<body style="margin:0;width:1000px;height:760px;background:#6b5640;display:flex;align-items:center;justify-content:center"><div style="width:860px;height:640px;transform:rotate(-2.2deg);background:repeating-linear-gradient(#fdfbf3 0 46px,#c7d8ea 46px 48px);box-shadow:0 18px 40px rgba(0,0,0,.45);padding:40px 50px;box-sizing:border-box;font-family:'Noto Serif CJK KR',serif;font-size:34px;line-height:48px;color:#203a7a"><div style="color:#b33;font-size:26px">10/15 숙제 — 민아</div>저는 주말에 부산에 갔어요.<br>바다가 정말 예뻤어요.<br>친구하고 회를 먹었어요.<br>조금 비쌋지만 맛있었어요.<br><span style="color:#999;font-size:26px">(단어: 바다, 회, 비싸다)</span></div></body>`,
    1000,
    760,
  ),
);
// 손글씨 한 장 더 (다른 날)
const hand = (lines, mark) => `<body style="margin:0;width:900px;height:640px;background:#5d4a37;display:flex;align-items:center;justify-content:center"><div style="width:780px;height:540px;transform:rotate(1.4deg);background:repeating-linear-gradient(#fdfbf3 0 46px,#c7d8ea 46px 48px);box-shadow:0 18px 40px rgba(0,0,0,.45);padding:34px 44px;box-sizing:border-box;font-family:'Noto Serif CJK KR',serif;font-size:32px;line-height:48px;color:#203a7a"><div style="color:#b33;font-size:24px">${mark}</div>${lines.join('<br>')}</div></body>`;
put(S + '과제/hand_d2.jpg', await jpg(hand(['추석에 고향에 갔어요.', '할머니하고 송편을 만들었어요.', '송편이 달았어요.'], '숙제 — 문장 쓰기'), 900, 640));
put(S + '과제/hand_d5.jpg', await jpg(hand(['김치는 매워요.', '레몬은 셔요.', '간장은 짜요.', '꿀은 달아요.'], '숙제 — 맛 형용사'), 900, 640));
// 날마다 낸 과제와 피드백 (숙제 플랫폼이 내보내는 모양 — 판의 과제 탭이 읽는다)
const HW = {
  student: 'Mina K.',
  lastLesson: '@D-7@',
  days: [
    { date: '@D-1@', status: 'partial', minutes: 9, tasks: [
      { title: '말하기 — 추석 이야기 녹음', type: 'speak', items: [
        { label: '추석에 한 일을 말해 보세요', kind: 'speak', media: [{ kind: 'audio', src: '#11_숙제_녹음.ogg' }], ai: '받아쓰기: "저는 주말에 부산에 갔어요…" — 비쌌지만[비싿찌만] 발음 확인', status: 'wait' } ] } ] },
    { date: '@D-2@', status: 'done', minutes: 21, tasks: [
      { title: '맛 형용사 쓰기 (손글씨)', type: 'hand', items: [
        { label: '음식마다 맛을 쓰세요', kind: 'hand', media: [{ kind: 'img', src: 'hand_d5.jpg' }], text: '김치는 매워요. 레몬은 셔요. 간장은 짜요. 꿀은 달아요.', teacher: '완벽해요! 👏', status: 'ok', score: 1 } ] },
      { title: '단어 카드', type: 'cards', items: [
        { label: '복습 12장', text: '10장 맞음 · 비싸다/짜다 헷갈림', status: 'fix', score: 0.83, ai: '비싸다(expensive) ↔ 짜다(salty) 다시 보기' } ] } ] },
    { date: '@D-3@', status: 'skipped', tasks: [] },
    { date: '@D-4@', status: 'late', minutes: 18, note: '밤 11시에 함', tasks: [
      { title: '한 → 영', type: 'sp_ko_en', items: [
        { label: '친구를 만나러 가요.', text: 'I go to meet a friend.', status: 'ok', score: 1 },
        { label: '송편이 달았어요.', text: 'The rice cake is sweet.', ai: '과거형: was sweet', model: 'The songpyeon was sweet.', status: 'fix', score: 0.5 } ] } ] },
    { date: '@D-5@', status: 'done', minutes: 22, tasks: [
      { title: '문장 쓰기 — -았/었어요 (손글씨)', type: 'hand', items: [
        { label: '추석에 한 일 3문장', kind: 'hand', media: [{ kind: 'img', src: 'hand_d2.jpg' }], text: '추석에 고향에 갔어요. 할머니하고 송편을 만들었어요. 송편이 달았어요.', teacher: '좋아요. "고향에" 대신 "고향에 내려갔어요"도 써 봐요.', status: 'ok', score: 1 } ] } ] },
    { date: '@D-6@', status: 'done', minutes: 20, tasks: [
      { title: '문 → 답', type: 'sp_qa', items: [
        { label: '주말에 뭐 했어요?', kind: 'hand', media: [{ kind: 'img', src: '#11_숙제_손글씨.jpg' }], text: '저는 주말에 부산에 갔어요. 바다가 정말 예뻤어요. 친구하고 회를 먹었어요. 조금 비쌋지만 맛있었어요.', ai: '비쌋지만 → 비쌌지만 (받침 ㅆ)', status: 'fix', score: 0.75 } ] } ] },
    { date: '@D-8@', status: 'done', minutes: 19, tasks: [ { title: '단어 카드', type: 'cards', items: [ { label: '복습 10장', text: '10장 모두 맞음', status: 'ok', score: 1 } ] } ] },
    { date: '@D-9@', status: 'done', minutes: 20, tasks: [ { title: '영 → 한', type: 'sp_en_ko', items: [ { label: 'I want to eat tteokbokki.', text: '떡볶이를 먹고 싶어요.', status: 'ok', score: 1 } ] } ] },
  ],
};
put(S + '과제/hw_history.json', JSON.stringify(HW));
put(S + '과제/#11_숙제_글.txt', '저는 주말에 부산에 갔어요. 바다가 정말 예뻤어요. 친구하고 회를 먹었어요. 조금 비쌋지만 맛있었어요.\n');
if (AUD && fs.existsSync(path.join(AUD, 'hw.ogg'))) put(S + '과제/#11_숙제_녹음.ogg', fs.readFileSync(path.join(AUD, 'hw.ogg')));

// 7) 듣기 영상 (짧은 mp4, 한글 자막) + 듣기 소리
if (AUD && fs.existsSync(path.join(AUD, 'listen.ogg'))) {
  put(S + '수업준비/#12_듣기.ogg', fs.readFileSync(path.join(AUD, 'listen.ogg')));
  const frame = await png(`<body style="margin:0;width:960px;height:540px;background:#0f2235;${FONT};color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center"><div style="font-size:120px">🚇🍢</div><div style="font-size:54px;font-weight:800;margin-top:10px">듣기: 민수 씨의 내일</div><div style="font-size:30px;color:#ffd27a;margin-top:14px">어디에 가요? 뭐 먹어요?</div></body>`, 960, 540);
  const tmp = fs.mkdtempSync('/tmp/kwdvid');
  fs.writeFileSync(tmp + '/f.png', frame);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', tmp + '/f.png', '-i', path.join(AUD, 'listen.ogg'), '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac', '-b:a', '48k', '-shortest', '-movflags', '+faststart', tmp + '/v.mp4']);
  put(S + '수업준비/#12_듣기영상.mp4', fs.readFileSync(tmp + '/v.mp4'));
}

// 8) 학생 정보 · 지난 수업 · 수업 기록
put(S + 'Student_Profile_Mina K.md', `# Student Profile: Mina K. (체험용 가상 학생)\n\n- 나라: 캐나다 · 시간대: 토론토\n- 레벨: 초급 2 (TOPIK 1 준비)\n- 관심: 요리, 여행, K-드라마\n- 목표: 내년 봄 서울 여행에서 식당·시장 대화\n- 수업: 주 2회 50분, 지금까지 11번\n\n## 잘하는 것\n- 발음이 또렷함, 새 단어를 빨리 외움\n\n## 어려워하는 것\n- 받침 있는 과거형 (-었어요), 조사 은/는·이/가\n`);
put(S + 'student_roadmap_current.md', `# 로드맵 (체험용)\n\n| 단계 | 내용 | 상태 |\n|---|---|---|\n| 1 | 자기소개·숫자 | 끝 |\n| 2 | 음식·맛 | 진행 중 |\n| 3 | 과거형 이야기 | 진행 중 |\n| 4 | 미래 계획 -(으)ㄹ 거예요 | 다음 |\n| 5 | 식당에서 주문하기 | 다음 |\n`);
put(S + 'Current_Learning_Status.md', `# 지금 배우는 상태\n\n- 과거형: 규칙 동사는 익숙, ㅂ불규칙(맵다→매웠어요) 아직\n- 조사: 이/가 와 은/는 자주 헷갈림\n- 숙제: 3번 연속 냄, 녹음도 함\n`);
put(S + '#10_Mina K_@D-14@-19-00.md', `# #10 수업\n\n## 배운 것\n- 맛있어요, 매워요, 반찬\n- -고 싶어요\n\n## 교정\n- 친구를 만나요 가요 → 친구를 만나러 가요\n\n## 숙제\n- 맛 일기 3줄\n`);
put(S + '#11_Mina K_@D-7@-19-00.md', `# #11 수업\n\n## 배운 것\n- 날씨, 바다, 회, 비싸다\n- -았/었어요 (규칙)\n\n## 교정\n- 비쌋지만 → 비쌌지만\n- 부산에 갔어요 ✓\n\n## 다음\n- 추석 이야기, 맛 형용사, -(으)ㄹ 거예요 맛보기\n`);
const ld = (n, date, vocab, pats, corr) => JSON.stringify({ meta: { preply_id: '9000001', lesson_number: n, date, lesson_id: `M_${date}_L${n}` }, lesson_overview: { summary_en: `Lesson ${n}` }, vocabulary: vocab.map(([kr, en, st]) => ({ kr, en, student_status: st || 'introduced' })), grammar_patterns: pats.map(([p, e, ex]) => ({ pattern_kr: p, name_en: e, examples: [ex] })), corrections: corr.map(([a, c]) => ({ correction_kind: '형태', student_said_kr: a, correction_kr: c })), next_steps: { homework_items: ['추석 이야기 3문장'] } });
put(S + '.lesson_data_10.json', ld(10, '@D-14@', [['맛있어요', 'tasty', 'practiced'], ['매워요', 'spicy'], ['반찬', 'side dish', 'uncertain'], ['송편', 'rice cake']], [['-고 싶어요', 'want to', '먹고 싶어요']], [['친구를 만나요 가요', '친구를 만나러 가요']]));
put(S + '.lesson_data_11.json', ld(11, '@D-7@', [['날씨', 'weather', 'practiced'], ['바다', 'sea'], ['회', 'raw fish'], ['비싸다', 'expensive', 'uncertain'], ['예쁘다', 'pretty']], [['-았/었어요', 'past tense', '부산에 갔어요']], [['비쌋지만', '비쌌지만']]));

// 9) 중앙 DB 묶음 (kwd_board_export.py 와 같은 꼴, 지어낸 것)
const V = (w, en, cat, first, last, seen, status, rel, chapter) => ({ w, en, cat, pos: '', topik: 1, first, last, seen, status, chapter, rel });
const ch1 = { code: 'M0012', target: '-았/었어요', level: 'L1' };
const ch2 = { code: 'M0020', target: '맛 형용사', level: 'L1' };
put(
  'board_data/Mina K (9000001).json',
  JSON.stringify({
    generated_at: '2026-10-17T06:50:00',
    sources: { relations: ['같은 챕터(커리큘럼 배정)', '같은 묶음(단어 분류)', '헷갈리는 짝(문형 비교)', '같은 수업 묶음·같은 계열(커리큘럼)'], missing: ['동의어·반의어 표', '우리말샘 벡터 유사도'] },
    vocab: [
      V('저', 'I (humble)', 'people', 1, 11, 22, 'mastered', { '같은 묶음 · 배운 것': ['친구', '가족'], '같은 묶음 · 새 단어': ['우리', '사람'] }),
      V('이름', 'name', '', 1, 4, 6, 'mastered', {}),
      V('친구', 'friend', 'people', 2, 11, 9, 'practiced', { '같은 묶음 · 배운 것': ['가족', '저'], '같은 묶음 · 새 단어': ['동생', '언니', '친척'] }),
      V('가족', 'family', 'people', 3, 9, 5, 'practiced', { '같은 묶음 · 새 단어': ['부모님', '할머니', '친척'] }),
      V('먹다', 'to eat', 'actions', 2, 11, 14, 'practiced', { '같은 챕터 · 배운 것': ['가다', '보다'], '같은 챕터 · 새 단어': ['만들다', '지내다'], '같은 묶음 · 새 단어': ['마시다', '요리하다'] }, ch1),
      V('가다', 'to go', 'actions', 2, 11, 12, 'practiced', { '같은 챕터 · 배운 것': ['먹다', '보다'], '같은 챕터 · 새 단어': ['다녀오다', '돌아가다'] }, ch1),
      V('보다', 'to see', 'actions', 4, 10, 6, 'introduced', { '같은 챕터 · 배운 것': ['먹다', '가다'] }, ch1),
      V('맛있어요', 'tasty', 'food', 8, 10, 7, 'practiced', { '같은 챕터 · 새 단어': ['달아요', '짜요', '셔요', '고소해요'], '같은 묶음 · 배운 것': ['반찬', '송편'] }, ch2),
      V('매워요', 'spicy', 'food', 10, 10, 2, 'introduced', { '같은 챕터 · 배운 것': ['맛있어요'], '같은 챕터 · 새 단어': ['달아요', '짜요', '셔요'] }, ch2),
      V('반찬', 'side dish', 'food', 10, 10, 1, 'uncertain', { '같은 묶음 · 배운 것': ['송편', '김치'], '같은 묶음 · 새 단어': ['국', '밥', '전'] }),
      V('김치', 'kimchi', 'food', 6, 10, 4, 'practiced', { '같은 묶음 · 새 단어': ['찌개', '전', '떡볶이'] }),
      V('송편', 'rice cake', 'food', 10, 10, 1, 'introduced', { '같은 묶음 · 새 단어': ['떡', '식혜', '전'], '같은 챕터 · 새 단어': ['차례', '성묘', '보름달'] }),
      V('날씨', 'weather', 'nature', 5, 11, 6, 'practiced', { '같은 묶음 · 새 단어': ['비', '눈', '바람', '맑다'] }),
      V('바다', 'sea', 'places', 11, 11, 1, 'introduced', { '같은 묶음 · 배운 것': ['부산'], '같은 묶음 · 새 단어': ['산', '강', '해변'] }),
      V('부산', 'Busan', 'places', 11, 11, 2, 'introduced', { '같은 묶음 · 새 단어': ['서울', '전주', '제주도'] }),
      V('회', 'raw fish', 'food', 11, 11, 1, 'introduced', { '같은 묶음 · 새 단어': ['초밥', '해산물'] }),
      V('비싸다', 'expensive', 'describe', 11, 11, 1, 'uncertain', { '같은 묶음 · 새 단어': ['싸다', '많다', '적다'] }),
      V('예쁘다', 'pretty', 'describe', 11, 11, 1, 'introduced', { '같은 묶음 · 새 단어': ['멋있다', '귀엽다'] }),
    ],
    grammar: [
      { p: '은/는', en: 'topic marker', cat: 'particle', sub: 'topic', meaning: 'Marks the topic.', ex: '저는 민아예요.', ex_en: 'I am Mina.', status: 'practiced', first: 1, count: 9, chapter: { code: 'M0002', target: '은/는', level: 'L1' }, rel: { '헷갈리는 짝': ['이/가'], '같은 수업 묶음': ['이/가', '을/를'] } },
      { p: '이/가', en: 'subject marker', cat: 'particle', sub: 'subject', meaning: 'Marks the subject.', ex: '날씨가 좋아요.', ex_en: 'The weather is good.', status: 'introduced', first: 3, count: 4, chapter: { code: 'M0001', target: '이/가', level: 'L1' }, rel: { '헷갈리는 짝': ['은/는'], '이 챕터 단어': ['날씨', '친구', '비'] } },
      { p: '-고 싶어요', en: 'want to', cat: 'ending', sub: 'desire', meaning: 'Expresses a wish.', ex: '떡볶이를 먹고 싶어요.', ex_en: 'I want to eat tteokbokki.', status: 'practiced', first: 9, count: 3, rel: { '같은 계열 (Desire and intention)': ['-(으)려고 해요', '-(으)ㄹ 거예요'] } },
      { p: '-았/었어요', en: 'past tense', cat: 'tense', sub: 'past', meaning: 'Past tense polite.', ex: '부산에 갔어요.', ex_en: 'I went to Busan.', status: 'introduced', first: 11, count: 2, chapter: ch1, rel: { '헷갈리는 짝': ['-아/어요'], '같은 수업 묶음': ['-(으)ㄹ 거예요'], '이 챕터 단어': ['만들다', '지내다', '다녀오다'] } },
    ],
  }),
);

// 10) 체험 수업 학생 (준비 문서만)
put(T + 'Trial_Prep_DEMO.md', `# Trial Lesson Prep: Tom (체험용 가상 학생)\n\n## 1. 사전 설문\n- 목표: 내년 여름 한국 여행\n- 한글: 읽을 수 있음, 뜻은 잘 모름\n- 좋아하는 것: 축구, 라면\n\n## 2. 오늘 할 것\n1. 자기소개 (저는 ___예요)\n2. 여행 표현 5개\n3. 다음 수업 계획 정하기\n`);
put(T + 'Student_Profile_Tom.md', `# Student Profile: Tom\n\n- Lesson Count: 0 (체험 수업)\n`);

// 11) 오늘 브리핑 (날짜는 체험을 열 때 오늘로 바뀜)
put(
  'intake/TODAY/brief_data.json',
  JSON.stringify({
    schema: 'brief-data/v1',
    generated_at: 'TODAYT06:50:00',
    lessons: [
      { time: 'NOW+5', name: 'Mina K.', folder: 'Mina K (9000001)', last_lesson: 11, next_lesson: 12, level_hint: '초급 2', rapport: [{ date: '@D-7@', lesson: 11, text: '주말에 부산에 가서 회를 먹었다고 함', follow_up: '부산 사진 있으면 보여 달라고 하기' }, { date: '@D-14@', lesson: 10, text: '추석에 캐나다 친구들과 송편 만들 계획' }], promises: { tutor: [{ text: '추석 수업 페이지 준비', status: 'done' }], homework: [{ text: '매일 과제 (쓰기·말하기·단어)' }], submissions: '6일 중 5일 냄 · 확인 기다림 1', homework_status: '제출함' }, next_focus: '-았/었어요로 추석 이야기 3문장, 맛 형용사 4개', warmup_recent: [{ kr: '바다', en: 'sea' }, { kr: '비싸다', en: 'expensive' }, { kr: '송편', en: 'rice cake' }, { kr: '매워요', en: 'spicy' }], last_core: { taught: ['날씨', '바다', '회', '비싸다'], patterns: ['-았/었어요'], corrections: ['비쌋지만 → 비쌌지만'], overview: '부산 여행 이야기로 과거형 연습. 규칙 동사는 잘 하지만 ㅆ 받침 철자를 헷갈림.' }, prep: { summary: ['오늘 목표: 추석에 한 일 3문장 말하기 (-았/었어요)', '맛 형용사 4개: 달아요·짜요·매워요·셔요', '복습: 바다, 비싸다, 송편'], plan: [{ part: '대화', min: 8, what: '주말·추석 이야기 — 부산 사진 있으면 보여 달라고 하기' }, { part: '과제 피드백', min: 10, what: '비쌋지만→비쌌지만 (받침 ㅆ) · 송편이 달았어요 영어 과거형 · 녹음 1개 듣기' }, { part: '수업', min: 27, what: '수업 페이지 1→6단계 (새 단어 → -았/었어요 → 맛) · 듣기 영상' }, { part: '마무리', min: 5, what: '이번 주 과제 안내 (7단계)' }] } },
      { time: 'NOW+65', name: 'Tom', folder: 'Tom (pending-student-demo)', last_lesson: 0, level_hint: '체험 수업' },
    ],
  }),
);
await b.close();

fs.writeFileSync(OUT + '/manifest.json', JSON.stringify({ made: new Date().toISOString(), files }, null, 1));
let total = 0;
for (const f of files) total += fs.statSync(path.join(W, f.f)).size;
console.log(files.length, 'files', Math.round(total / 1024) + 'KB');
