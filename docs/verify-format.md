# 검증 기록 형식 (T044) — kwd-verify-set/v1
위치: `Student_Lessons\<학생>\검증\verify_<YYYY-MM-DD HH-mm>.json` (수업 한 번에 파일 하나, 확인할 때마다 통째로 다시 씀). 학생 이름 없음.
```json
{ "schema": "kwd-verify-set/v1", "saved_at": "ISO", "items": [
  { "schema": "kwd-verify/v1", "id": "날짜|과제|문항|제출시각", "student": "Preply/S번호",
    "date": "과제 날짜", "task": "과제 제목", "label": "문항", "kind": "write|speak|...",
    "student_text": "학생 답(200자)", "ai": "AI 채점 메모(200자)",
    "verdict": "ok(맞음) | fix(선생님이 고침) | redo(다시 해 와야 함)",
    "correction": "선생님이 고친 답", "note": "메모", "at": "ISO" } ] }
```
같은 내용이 판 기록(.kwd.zip 사건 log)에도 `kind: verify` 로 한 줄씩 남는다.
사용: fix·redo 문항 = 피드백 몫(20~30%) 재료. ok 문항은 '이미 알고 있음'. 판은 읽기만 하고 과제를 만들지 않는다.
