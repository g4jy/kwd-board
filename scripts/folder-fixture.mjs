// 시험용 KWD work 폴더 (가짜 학생 둘). 실제 학생 자료는 쓰지 않는다.
export function fixtureFiles(today) {
  const lesson = (n, date, vocab, extra = {}) => JSON.stringify({ meta: { preply_id: '1234567', lesson_number: n, date, lesson_id: `M_${date}_L${n}` }, lesson_overview: { summary_en: `Lesson ${n}: food and weather` }, vocabulary: vocab.map(([kr, en, st]) => ({ kr, en, student_status: st || 'introduced' })), grammar_patterns: [{ pattern_kr: '-고 싶어요', name_en: 'want to', examples: ['먹고 싶어요'] }], corrections: [{ correction_kind: '조사', student_said_kr: '친구를 만나요 가요', correction_kr: '친구를 만나러 가요' }], next_steps: { homework_items: ['날씨 일기 쓰기'] }, ...extra });
  const M = 'Student_Lessons/Mina K (1234567)/';
  const T = 'Student_Lessons/Tom (pending-student-77)/';
  return {
    [M + '#1_Mina K_2026-10-01-10-00.md']: '# 수업 1\n\n- 송편, 날씨\n',
    [M + '#2_Mina K_2026-10-10-10-00.md']: '# 수업 2\n\n## 배운 것\n- 맛있어요\n- 매워요\n',
    [M + 'Student_Profile_Mina K.md']: '# Student Profile: Mina\n\n- 레벨: 초급\n- 관심: 요리, 여행\n',
    [M + 'student_roadmap_current.md']: '# 로드맵\n\n1. 맛 형용사\n2. -(으)ㄹ 거예요\n',
    [M + 'Current_Learning_Status.md']: '# 상태\n\n과거형은 익숙함.\n',
    [M + '.lesson_data_1.json']: lesson(1, '2026-10-01', [['송편', 'rice cake'], ['날씨', 'weather'], ['맛있어요', 'tasty', 'practiced']]),
    [M + '.lesson_data_2.json']: lesson(2, today, [['매워요', 'spicy'], ['맛있어요', 'tasty', 'practiced'], ['반찬', 'side dish', 'uncertain']]),
    [M + '수업준비/#3_수업안.md']: '# #3 수업안\n\n## 1. 워밍업\n- 날씨 묻기\n\n## 2. 맛 형용사\n| 말 | 뜻 |\n|---|---|\n| 달아요 | sweet |\n',
    [M + '수업준비/#3_과제_초안.md']: '# 과제\n\n- 맛 일기 3줄\n',
    [M + '수업준비/#3_수업페이지.html']: '<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#202020;color:#eee;font-family:sans-serif"><h2>맛 형용사</h2><button>달아요</button><button>짜요</button></body></html>',
    [M + '수업준비/prep_3.html']: '<!doctype html><html><body><p>준비 한 장</p></body></html>',
    [T + 'Trial_Prep_' + today + '.md']: '# Trial Lesson Prep: Tom\n\n## 1. 학생 정보\n- 목표: 여행 한국어\n',
    [T + 'Student_Profile_Tom.md']: '# Student Profile: Tom\n\n- Lesson Count: 0\n',
    ['intake/' + today + '/brief_data.json']: JSON.stringify({
      schema: 'brief-data/v1',
      generated_at: today + 'T06:50:00',
      lessons: [
        { time: '23:58', name: 'Mina K.', folder: 'Mina K (1234567)', last_lesson: 2, next_lesson: 3, level_hint: '초급', rapport: [{ date: today, lesson: 2, text: '주말에 부산에 갔어요', kind: '일상' }], promises: { tutor: [{ text: '맛 형용사 자료 준비', status: 'open' }], homework: [], submissions: '제출 기록 없음' }, next_focus: '맛 형용사 4개', warmup_recent: [{ kr: '송편', en: 'rice cake' }, { kr: '날씨', en: 'weather' }], last_core: { taught: ['맛있어요', '매워요'], patterns: ['-고 싶어요'], corrections: ['만나요 가요 → 만나러 가요'] }, prep: { summary: ['오늘 목표: 맛 형용사로 두 문장 말하기', '복습 대상: 2개'] } },
        { time: '00:01', name: 'Tom', folder: 'Tom (pending-student-77)', last_lesson: 0, level_hint: '초급 (기록 없음)' },
      ],
    }),
  };
}

// OPFS 에 써 넣는 함수 (브라우저 안에서 실행)
export const writeOpfs = async (files) => {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry('kwdwork', { recursive: true });
  } catch {}
  const work = await root.getDirectoryHandle('kwdwork', { create: true });
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    let d = work;
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  window.__kwdFolder.setWorkHandleForTest(work);
  window.__kwdFolder.rerender();
  return Object.keys(files).length;
};
