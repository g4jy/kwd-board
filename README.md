# KWD 수업 판 — v3

온라인 한국어 1:1 수업 한 시간을 **공책처럼 쪽으로 넘기며** 담는 판. 글·손글씨(필압)·사진·PDF 슬라이드·HTML 자료가 한 판에 있고, 랩탑·태블릿·폰이 같은 판을 본다. 수업이 끝나면 화면 캡처 없이 **기록 묶음(.kwd.zip)** 이 남고, 밤 루틴이 녹화 전사와 시각을 맞춰 AI 문서화 입력을 2만 토큰 안쪽으로 만든다.

기획안: Claude Docs "KWD 수업 판 기획안 v3 (최종)" · 작업 기록: `LOOPLOG.md` (조사 → 루프 1~7)

## 바로 써 보기

```bash
npm install
npm run dev            # http://localhost:5173
```

1. 학생 번호를 넣고 **새 판**.
2. **글** 을 고르고 그냥 친다. `# 제목`, `1. 리스트`, `___` (빈칸).
3. 펜 세 칸 + **형광** — 한 번 누르면 그 펜, 한 번 더 누르면 색·굵기 설정(12색 + 직접 고르기, 굵기 1~24, 멈추면 직선).
4. **지우개** — 크기 작게/보통/크게, "이 페이지 잉크 모두 지우기". S펜 옆 버튼을 누르고 그으면 그 획만 지우개.
5. **가져오기** — 사진 · PDF·슬라이드(쪽마다 한 페이지, 필기는 그 쪽에 붙어 넘기면 같이 사라짐) · HTML 자료(눌러 보는 퀴즈) · 빈 페이지.
6. 오른쪽 숫자 = 페이지. 아래 오른쪽 `− 100% +` (가운데 숫자를 누르면 폭 맞춤). 스크롤은 마지막 페이지 아래에서 멈춘다.
7. 왼쪽 위 **← 목록** 으로 나간다. 판은 자동 저장.
8. **⋯** — 학생에게 허락(글·펜·되돌리기), 한 장씩 보기, 타이머, 오늘 요약, 기록 저장(폴더 정하면 60초마다 자동), 학생 링크·방 코드, 서버·선생님 열쇠, 쪽 지우기.

태블릿: 펜 = 필기, 손가락 하나 = 이동, 두 손가락 = 확대. 폰 학생은 처음부터 "큰 글씨".

## 학생 메모리 (선생님 기기만)

판 위 **이 학생** 버튼 → 지난 단어·문형·과제. 첫 쪽이 비어 있으면 "오늘 짚을 것"(오늘·복습·과제 확인)을 맨 위에 넣고, 글 속 지난 단어에는 점선 힌트가 생긴다(올려 보면 "9/24 처음 · 6번 나옴 · 오늘 복습"). 메모리는 Yjs 문서에 넣지 않아 학생 기기로 가지 않는다.

```bash
python night/kwd_night.py memory --student-dir "C:/KWD/work/Student_Lessons/이름 (번호)" --out memory.json
curl -X PUT -H "authorization: Bearer $TEACHER_TOKEN" --data-binary @memory.json https://<서버>/students/<번호>/memory.json
```

## 밤 루틴

```bash
python night/kwd_night.py all --bundle lesson_<학생>_<일시>.kwd.zip --transcript transcript.json [--memory memory.json] --out out/
```

`hint`(전사기 어휘 힌트) · `sync`(OBS 파일명 시각 + 판에 친 글과 말의 "메아리"로 시계 차이 보정) · `compact`(압축 시각표) · `prompt`(AI 입력) · `memory`. 표준 라이브러리만, 키·네트워크 없음.

## 기기 여러 대

기본은 이 기기 안에만 저장(IndexedDB). 같이 보려면 서버 하나:

| 방법 | 어떻게 |
| --- | --- |
| 로컬 Node | `TEACHER_TOKEN=… npm run server` → `ws://<랩탑 IP>:1234` |
| Cloudflare (무료, 항상 켜짐) | 아래 |

```bash
cd server/cloudflare && npm install
npx wrangler login
npx wrangler secret put TEACHER_TOKEN     # 선생님 열쇠 — 채팅에 붙여 넣지 말고 여기서 직접 입력
npm run deploy                            # wss://kwd-board-sync.<계정>.workers.dev
```

판의 ⋯ → 서버·선생님 열쇠 에 주소와 열쇠를 넣는다(열쇠는 이 기기에만 저장). 학생 링크(`r=s`)·보조기기 링크(`r=a`)에는 열쇠가 들어가지 않는다. 자료 그림은 문서 밖 서버 저장소에 둬서 Cloudflare 1MB 메시지 한도에 걸리지 않는다.

## 검증

```bash
npm run build && npx vite preview --port 4173 &
TEACHER_TOKEN=testtoken npm run server &
npm test        # 16개 흐름. WS_URL=ws://localhost:8787 npm test 로 워커도
```

## 구조

```
src/
  board.ts     판 화면: 페이지·레일·확대·도구 줄·펜 설정·가져오기·메모리 패널·메뉴
  store.ts     Yjs 문서(pages, text:<id>, ink:<id>, events, materials, matdata) + IndexedDB + y-websocket
  editor.ts    Tiptap 3 (쪽마다 하나, 공용 UndoManager), 블록 id, 점선 힌트
  ink.ts       잉크 층 (perfect-freehand, 필압, 직선, 지우개, 레이저, 펜/손가락 구분)
  palette.ts   펜 색·형광·굵기 설정
  importer.ts  PDF(pdf.js 글자층)·HTML 자료
  record.ts    기록 묶음 .kwd.zip, 자동 저장 폴더
  memory.ts    학생 메모리 읽기·머리말
server/node, server/cloudflare   y-websocket + /time + /rooms/<id>/(export|blobs) + /students/<번호>/memory.json
night/kwd_night.py                밤 루틴
tests/                            Playwright
```

## 라이선스

의존성은 전부 MIT/Apache-2.0: Tiptap, ProseMirror, Yjs, y-websocket, y-indexeddb, perfect-freehand, es-hangul, pdf.js, JSZip, Vite.
