r"""predeploy.py — T136r: main에 올리기(= GitHub Pages 배포) 전 관문. .githooks/pre-push 가 부른다.

  python -I scripts/predeploy.py            → 세 가지 다 통과하면 0
  python -I scripts/predeploy.py --no-tests → 수업 시간·이름 검사만(시험은 따로 돌렸을 때)

1) 수업 시간: 과제플랫폼 class_guard.py 와 같은 기준(선생님 캘린더 수업 ±10분이면 멈춤, 캘린더 모름도 멈춤).
   경로 = 환경변수 KWD_CLASS_GUARD 또는 기본 경로. 없으면 멈춤. 학생 화면 고장 긴급이면 KWD_DEPLOY_IN_CLASS=1(board에 이유).
2) 이름: 이 PC의 학생 정보(KWD_STUDENT_INFO 또는 기본 경로)로 추적 파일 전수 검사. 이름은 출력하지 않고 파일:줄·학생번호만.
   학생 정보 파일이 없는 PC(다른 사람·CI)는 건너뜀을 알린다.
3) 시험: .run-tests.ps1 전체(빌드 → 미리보기 → 동기 서버 → Playwright). 실패 0이어야 통과.
"""
import io, json, os, re, subprocess, sys, importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GUARD = os.environ.get("KWD_CLASS_GUARD", r"C:\KWD\biz\과제플랫폼\코드\hw_platform_v3\tools\class_guard.py")
INFO = os.environ.get("KWD_STUDENT_INFO", r"C:\KWD\data\student_info.json")
# 이름이 아닌 것으로 확인된 겹침(T136r): 흔한 낱말과 같은 한글 이름, 빌드된 글꼴 글리프 이름
COMMON_KO = {"나라"}


def class_time():
    if not os.path.exists(GUARD):
        return False, "class_guard.py 없음 — 수업 여부 모름(멈춤). KWD_CLASS_GUARD 로 경로 지정"
    spec = importlib.util.spec_from_file_location("class_guard", GUARD)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    at = os.environ.get("KWD_GUARD_AT")  # 시험용 시각(ISO)
    ok, why = m.check(m._t(at) if at else None)
    if not ok and os.environ.get("KWD_DEPLOY_IN_CLASS") == "1":
        return True, "경고 — " + why + " · KWD_DEPLOY_IN_CLASS=1 이라 진행(board에 이유 남길 것)"
    return bool(ok), why


def name_tokens():
    d = json.load(io.open(INFO, encoding="utf-8"))["students"]
    toks = {}
    for sno, s in d.items():
        sid = s.get("st") or sno
        for f in ("name", "preply_name", "name_ko"):
            v = (s.get(f) or "").strip()
            if not v:
                continue
            if len(v) >= 3: toks.setdefault(v, sid)
            first = v.split()[0].strip(".,")
            if len(first) >= 3 or (re.search(r"[\uac00-\ud7a3]", first) and len(first) >= 2):
                if first not in COMMON_KO: toks.setdefault(first, sid)
        fol = s.get("folder") or ""
        for m in re.finditer(r"\((\d{6,8}|[a-z]+-[a-z]+-\d{2,4})\)", fol):
            toks.setdefault(m.group(1), sid)
    return toks


def names():
    if not os.path.exists(INFO):
        return True, "학생 정보 파일 없음 — 이름 검사 건너뜀(이 PC 아님)"
    toks = name_tokens()
    parts = sorted((re.escape(t) for t in toks), key=len, reverse=True)
    rx = re.compile(r"(?<![A-Za-z0-9_\uac00-\ud7a3])(?:" + "|".join(parts) + r")(?![A-Za-z0-9_])")
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True).stdout.decode().split("\0")
    hits = []
    for p in files:
        f = REPO / p
        if not p or not f.is_file() or f.stat().st_size > 5_000_000:
            continue
        try:
            t = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(t.splitlines(), 1):
            for m in rx.finditer(line):
                a, b = line[m.start() - 1:m.start()], line[m.end():m.end() + 1]
                if p.endswith(".js") and a in ".`[" and b in "=.`]":
                    continue  # 글꼴 글리프 이름
                hits.append(f"{p}:{i} {toks[m.group(0)]}")
    return (not hits), ("이름 0" if not hits else f"이름 {len(hits)}곳: " + ", ".join(hits[:20]))


def tests():
    log = Path(os.environ.get("TEMP", "/tmp")) / "kwd-test-predeploy.log"
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(REPO / ".run-tests.ps1"), "-Log", str(log)], cwd=REPO)
    t = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
    passed = re.findall(r"(\d+) passed", t); failed = re.findall(r"(\d+) failed", t)
    p, f = (int(passed[-1]) if passed else 0), (int(failed[-1]) if failed else 0)
    ok = p > 0 and f == 0 and "exit 0" in t
    return ok, f"시험 통과 {p} · 실패 {f} (로그 {log})"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    steps = [("수업 시간", class_time), ("이름", names)]
    if "--no-tests" not in sys.argv:
        steps.append(("시험", tests))
    for label, fn in steps:
        ok, why = fn()
        print(f"[predeploy] {label}: {'통과' if ok else '멈춤'} — {why}")
        if not ok:
            sys.exit(1)
    print("[predeploy] 모두 통과 — 올려도 됨")


if __name__ == "__main__":
    main()
