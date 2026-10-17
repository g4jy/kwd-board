# -*- coding: utf-8 -*-
"""KWD 수업 판 — 밤 루틴 (기획안 v3 2.6, N-1~N-5)

판의 기록 묶음(lesson_<학생>_<일시>.kwd.zip)과 OBS 녹화 전사(transcript.json)를
화면 캡처 없이 한 시각표로 맞추고, AI 문서화 입력을 2만 토큰 안팎으로 만든다.

  python kwd_night.py hint    --bundle B.kwd.zip                     # 전사기 어휘 힌트 (initial_prompt 뒤에 붙일 글)
  python kwd_night.py sync    --bundle B.kwd.zip --transcript T.json  # 시각 맞추기 → timeline.jsonl
  python kwd_night.py compact --bundle B.kwd.zip --transcript T.json  # 압축 시각표 + 토큰 추정
  python kwd_night.py prompt  --bundle B.kwd.zip --transcript T.json [--memory M.json]  # AI 문서화 입력
  python kwd_night.py memory  --student-dir "C:/KWD/work/Student_Lessons/이름 (번호)" --out memory.json
  python kwd_night.py all     --bundle B.kwd.zip --transcript T.json [--memory M.json] --out DIR

표준 라이브러리만 쓴다(Python 3.9+). 키·네트워크 없음 — AI 호출은 기존 파이프라인이 한다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import statistics
import sys
import zipfile
from collections import Counter
from pathlib import Path

KST = dt.timezone(dt.timedelta(hours=9))
HANGUL_WORD = re.compile(r"[가-힣]{2,}")
VIDEO_NAME = re.compile(r"(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})")

# ---------------------------------------------------------------- 읽기

class Bundle:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        z = zipfile.ZipFile(self.path)
        self.files = {n: z.read(n) for n in z.namelist()}
        self.manifest = json.loads(self.files["manifest.json"])
        self.board_md = self.files.get("board.md", b"").decode("utf-8")
        self.events = [json.loads(l) for l in self.files.get("events.ndjson", b"").decode("utf-8").splitlines() if l.strip()]
        self.board = json.loads(self.files.get("board.json", b"{}") or b"{}")
        self.materials: dict[str, dict] = {}
        for n, b in self.files.items():
            m = re.match(r"materials/([^/]+)\.text\.json$", n)
            if m:
                self.materials[m.group(1)] = json.loads(b)

    @property
    def started(self) -> int:
        return int(self.manifest.get("startedAt") or (self.events[0]["t"] if self.events else 0))

    def page_label(self, page_id: str) -> str:
        for p in self.manifest.get("pages", []):
            if p["id"] == page_id:
                if p["kind"] == "material":
                    mat = next((m for m in self.manifest.get("materials", []) if m["id"] == p.get("material")), {})
                    return f"{p['no']}쪽 · 자료 {mat.get('name', '')} {p.get('materialPage')}/{mat.get('pages', '')}"
                return f"{p['no']}쪽"
        return "?쪽"

    def obj(self, obj_id: str) -> dict | None:
        """무한 판 위에 놓인 것 (슬라이드 쪽·웹 학습지·사진…)"""
        for p in self.board.get("pages", []):
            for o in p.get("objects", []):
                if o.get("id") == obj_id:
                    return o
        return None

    def obj_label(self, o: dict) -> str:
        kind = {"slide": "슬라이드", "html": "웹 학습지", "img": "사진", "video": "영상", "youtube": "유튜브", "audio": "소리", "box": "글상자"}.get(o.get("type"), o.get("type"))
        if o.get("type") == "slide":
            mat = next((m for m in self.manifest.get("materials", []) if m["id"] == o.get("mid")), {})
            return f"{kind} {mat.get('name', '')} {o.get('n')}/{mat.get('pages', '')}"
        return f"{kind} {o.get('name') or ''}".strip()

    def material_text(self, mid: str, n: int) -> str:
        mat = self.materials.get(mid)
        if not mat:
            return ""
        for p in mat.get("pages", []):
            if p["n"] == n:
                return p.get("text", "")
        return ""


def load_transcript(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def video_start_from(tr: dict, override: str | None = None) -> int | None:
    """OBS 파일명(2026-10-07 12-01-09.mkv, KST)에서 녹화 시작 시각(UTC ms)."""
    name = override or (tr.get("source") or {}).get("name") or tr.get("source_path") or ""
    m = VIDEO_NAME.search(name)
    if not m:
        return None
    y, mo, d, h, mi, s = map(int, m.groups())
    return int(dt.datetime(y, mo, d, h, mi, s, tzinfo=KST).timestamp() * 1000)


def segments(tr: dict) -> list[dict]:
    """tracks[].segments 를 화자 이름과 함께 시간순으로. (stream_start_time 보정 포함)"""
    out = []
    tracks = tr.get("tracks") or []
    if not tracks and tr.get("segments"):
        tracks = [{"label": "?", "segments": tr["segments"]}]
    for tk in tracks:
        base = float(tk.get("stream_start_time") or 0)
        who = (tk.get("label") or "?")
        who = "T" if who.lower().startswith("teach") else "S" if who.lower().startswith("stud") else who[:1]
        for sg in tk.get("segments") or []:
            text = (sg.get("text") or "").strip()
            if text:
                out.append({"start": float(sg["start"]) + base, "end": float(sg.get("end", sg["start"])) + base, "who": who, "text": text})
    out.sort(key=lambda s: s["start"])
    return out

# ---------------------------------------------------------------- N-2 어휘 힌트

def vocab_hint(b: Bundle, limit_chars: int = 220) -> dict:
    words = Counter()
    for w in HANGUL_WORD.findall(b.board_md):
        words[w] += 1
    for mat in b.materials.values():
        for p in mat.get("pages", []):
            for w in HANGUL_WORD.findall(p.get("text", "")):
                words[w] += 1
    ordered = [w for w, _ in words.most_common()]
    picked, size = [], 0
    for w in ordered:
        if size + len(w) + 2 > limit_chars:
            break
        picked.append(w)
        size += len(w) + 2
    return {
        "initial_prompt_suffix": "수업 판 어휘: " + ", ".join(picked) + ".",
        "hotwords": " ".join(picked),
        "count": len(picked),
        "all_terms": ordered,
    }

# ---------------------------------------------------------------- N-3 싱크

def _tokens(s: str) -> set[str]:
    return set(HANGUL_WORD.findall(s)) | {w.lower() for w in re.findall(r"[A-Za-z]{3,}", s)}


def sync(b: Bundle, tr: dict, video_start: str | None = None) -> dict:
    v0 = video_start_from(tr, video_start)
    segs = segments(tr)
    report = {"video_start_utc_ms": v0, "basis": "wall-clock", "echo_matches": 0, "echo_offset_ms": 0, "applied_offset_ms": 0, "pairs": []}
    if v0 is None:
        # 파일명이 없으면 판 시작 = 녹화 시작으로 둔다
        v0 = b.started
        report["basis"] = "board-start (파일명 없음)"
        report["video_start_utc_ms"] = v0
    # 글 메아리: 판에 쓴 문장과 말한 문장을 짝짓는다
    deltas = []
    text_events = [e for e in b.events if e.get("kind") == "text" and e.get("text") and e.get("src") != "memory"]
    for e in text_events:
        toks = _tokens(e["text"])
        if len(toks) < 2:
            continue
        need = 3 if len(toks) >= 4 else 2
        best = None
        for sg in segs:
            st = v0 + int(sg["start"] * 1000)
            if abs(st - e["t"]) > 180_000:
                continue
            ov = len(toks & _tokens(sg["text"]))
            if ov >= need and (best is None or ov > best[0] or (ov == best[0] and abs(st - e["t"]) < abs(best[1] - e["t"]))):
                best = (ov, st, sg)
        if best:
            # 말은 보통 타자와 함께, 글 사건은 타자를 멈춘 3초 뒤 기록된다 → 사건 시각 − 3초가 말 시작과 같다고 본다
            d = best[1] - (e["t"] - 3000)
            deltas.append(d)
            report["pairs"].append({"t": e["t"], "board": e["text"][:60], "said": best[2]["text"][:60], "delta_ms": d})
    report["echo_matches"] = len(deltas)
    if len(deltas) >= 3:
        med = int(statistics.median(deltas))
        report["echo_offset_ms"] = med
        if abs(med) <= 120_000:
            report["applied_offset_ms"] = med
            report["basis"] += " + 글 메아리"
    report["spread_ms"] = int(statistics.pstdev(deltas)) if len(deltas) >= 2 else None
    off = report["applied_offset_ms"]
    # 시각표: 판 시각을 녹화 시각축(초)으로
    timeline = []
    for e in b.events:
        if e.get("kind") in ("setting", "presence"):
            continue
        sec = (e["t"] + off - v0) / 1000
        timeline.append({"sec": round(sec, 1), "src": "board", **{k: e[k] for k in ("kind", "page", "block", "text", "id", "role", "src") if k in e}, "data": e.get("data")})
    for sg in segs:
        timeline.append({"sec": round(sg["start"], 1), "src": "speech", "who": sg["who"], "text": sg["text"]})
    timeline.sort(key=lambda r: (r["sec"], 0 if r["src"] == "speech" else 1))
    return {"report": report, "timeline": timeline}

# ---------------------------------------------------------------- N-3 압축

def est_tokens(s: str) -> int:
    """대략: 한글 1자 ≈ 1토큰, 그 밖 4자 ≈ 1토큰."""
    ko = len(re.findall(r"[가-힣]", s))
    return ko + max(0, (len(s) - ko)) // 4


def mmss(sec: float) -> str:
    sec = max(0, int(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


SHAPE = {"underline": "밑줄", "circle": "동그라미", "line": "선", "scribble": "손글씨", "free": "그림"}
COLOR = {"#222222": "검정", "#7a7a7a": "회색", "#d32f2f": "빨강", "#ef6c00": "주황", "#f9a825": "노랑", "#2e7d32": "초록", "#00897b": "청록",
         "#1565c0": "파랑", "#283593": "남색", "#6a1b9a": "보라", "#d81b60": "분홍", "#6d4c41": "갈색",
         "#ffd400": "노랑 형광", "#7ee36b": "초록 형광", "#ff8fc7": "분홍 형광", "#7cc8ff": "파랑 형광", "#ffab40": "주황 형광"}


def compact(b: Bundle, synced: dict) -> str:
    lines = []
    last_block_text: dict[str, str] = {}
    shown_material: set[str] = set()
    cur_page = None
    for r in synced["timeline"]:
        t = mmss(r["sec"])
        if r["src"] == "speech":
            lines.append(f"[{t}] {r['who']}: {r['text']}")
            continue
        k = r["kind"]
        if k == "page" and (r.get("data") or {}).get("op") == "show" and r.get("id"):
            # 무한 판: 목록에서 고른 것(슬라이드 쪽·학습지…)으로 이동
            o = b.obj(r["id"])
            if o and r["id"] != cur_page:
                cur_page = r["id"]
                lines.append(f"[{t}] — {b.obj_label(o)} —")
                if o.get("type") == "slide":
                    key = f"{o.get('mid')}/{o.get('n')}"
                    if key not in shown_material:
                        shown_material.add(key)
                        mt = b.material_text(o.get("mid"), o.get("n"))
                        lines.append(f"[{t}] 자료글: {mt[:400]}" if mt else f"[{t}] 자료글: (글자 없음 · 그림 p{o.get('n')}.jpg)")
        elif k == "page" and (r.get("data") or {}).get("op") in ("show", "add"):
            if r.get("page") != cur_page:
                cur_page = r.get("page")
                lines.append(f"[{t}] — {b.page_label(cur_page)} —")
                p = next((p for p in b.manifest.get("pages", []) if p["id"] == cur_page), None)
                if p and p["kind"] == "material":
                    key = f"{p['material']}/{p['materialPage']}"
                    if key not in shown_material:
                        shown_material.add(key)
                        mt = b.material_text(p["material"], p["materialPage"])
                        lines.append(f"[{t}] 자료글: {mt[:400]}" if mt else f"[{t}] 자료글: (글자 없음 · 그림 p{p['materialPage']}.jpg)")
        elif k == "text":
            blk = r.get("block") or "?"
            new = r.get("text") or ""
            old = last_block_text.get(blk, "")
            last_block_text[blk] = new
            if r.get("src") == "memory":
                lines.append(f"[{t}] 판(머리말): {new}")
            elif new.startswith(old) and old:
                add = new[len(old):].strip()
                if add:
                    lines.append(f"[{t}] 판+ {add}")
            elif new != old:
                lines.append(f"[{t}] 판: {new}")
        elif k == "ink":
            d = r.get("data") or {}
            what = SHAPE.get(d.get("shape", "free"), "그림")
            col = COLOR.get(str(d.get("color", "")).lower(), d.get("color", ""))
            if r.get("text"):
                lines.append(f"[{t}] 펜: '{r['text']}' {what} ({col})")
            elif d.get("shape") in ("scribble", "free"):
                lines.append(f"[{t}] 펜: {what} {d.get('bbox')} (그림 필요 시 ink 묶음)")
        elif k == "erase":
            pass
        elif k in ("blank", "result", "correction", "interaction", "image", "timer", "material", "table"):
            d = r.get("data") or {}
            brief = ", ".join(f"{a}={v}" for a, v in d.items() if v not in (None, "", [], {}))[:120]
            lines.append(f"[{t}] {k}: {brief}")
    # 같은 화자 연속 발화는 합친다
    merged = []
    for ln in lines:
        if merged and ln[8:10] in ("T:", "S:") and merged[-1][8:10] == ln[8:10] and len(merged[-1]) < 600:
            merged[-1] += " " + ln[11:]
        else:
            merged.append(ln)
    return "\n".join(merged) + "\n"

# ---------------------------------------------------------------- N-4 AI 입력

PROMPT_HEAD = """너는 한국어 1:1 수업 기록을 정리하는 조수다. 아래는 화면 캡처 없이 만든 수업 기록이다.
- [mm:ss] T: 선생님 말, S: 학생 말 (전사) / 판: 판에 쓴 글 / 판+ 기존 줄에 덧붙인 글 / 펜: 판에 그은 표시 / — n쪽 — 페이지 이동 / 자료글: 슬라이드·PDF의 글자층
- 판의 글은 원문 그대로라 철자를 고치지 말 것. 전사는 오류가 있을 수 있으니 판의 글을 우선한다.
만들 것(JSON 한 덩어리): lesson_summary, vocabulary[{kr,en,source_time,origin:board|speech|both}], grammar_patterns[{pattern_kr,examples,source_time}],
corrections[{wrong,right,type,source_time}], homework[{task,source_time}], next_focus[]. 판에만 있는 것과 말로만 한 것 모두 넣는다.
"""


def build_prompt(b: Bundle, compact_text: str, memory: dict | None) -> str:
    parts = [PROMPT_HEAD]
    m = b.manifest
    parts.append(f"학생 {m.get('student')} · 판 {m.get('board')} · 시작 {m.get('startedAtIso')} · 끝 {m.get('endedAtIso')}\n")
    if memory:
        voc = ", ".join(v["kr"] for v in memory.get("vocab", [])[:60])
        errs = "; ".join(f"{e.get('type')} {e.get('pattern', '')}" for e in memory.get("errors", [])[:10])
        parts.append(f"## 학생 메모리 요약\n이미 배운 단어(일부): {voc}\n반복 오류: {errs}\n")
    parts.append("## 시각표\n" + compact_text)
    parts.append("## 판 최종 글 (board.md)\n" + b.board_md)
    return "\n".join(parts)

# ---------------------------------------------------------------- N-5 학생 메모리

def _date(s: str) -> str:
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s or "")
    return f"{int(m.group(2))}/{int(m.group(3))}" if m else ""


REVIEW_DAYS = [1, 3, 7, 14, 30]


def build_memory(student_dir: str | Path, student: str | None = None, cards: list[dict] | None = None) -> dict:
    """학생 폴더의 .lesson_data_<N>.json 들 → memory.json (판이 읽는 모양)."""
    d = Path(student_dir)
    files = sorted(d.glob(".lesson_data_*.json"), key=lambda p: int(re.search(r"_(\d+)\.json$", p.name).group(1)))
    vocab: dict[str, dict] = {}
    grammar: dict[str, dict] = {}
    errors: dict[str, dict] = {}
    homework: list[dict] = []
    lessons: list[dict] = []
    sid = student or ""
    level = None
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        sid = sid or str(meta.get("preply_id") or "")
        date = meta.get("date", "")
        lid = meta.get("lesson_id") or f.stem
        ov = data.get("lesson_overview")
        summary = ov if isinstance(ov, str) else (ov or {}).get("summary_en", "") if isinstance(ov, dict) else ""
        lessons.append({"id": f"L{meta.get('lesson_number', '')}", "date": _date(date), "summary": (summary or "")[:120]})
        for v in data.get("vocabulary", []) or []:
            if not isinstance(v, dict):
                continue
            kr = (v.get("kr") or "").strip()
            if not kr:
                continue
            e = vocab.setdefault(kr, {"kr": kr, "en": v.get("en", ""), "first": _date(date), "count": 0, "lessons": []})
            e["count"] += 1
            e["last"] = _date(date)
            e["lastIso"] = date
            e["lessons"].append(lid)
            e["li"] = len(lessons) - 1  # 마지막으로 나온 수업 순번
            stt = v.get("student_status") or ""
            if stt in ("practiced", "produced", "used_correctly", "mastered"):
                e["used"] = e.get("used", 0) + (3 if stt == "mastered" else 1)
            if stt in ("regressed", "uncertain"):
                e["shaky"] = True
        for g in data.get("grammar_patterns", []) or []:
            if not isinstance(g, dict):
                continue
            pk = (g.get("pattern_kr") or "").strip()
            if not pk:
                continue
            e = grammar.setdefault(pk, {"pattern": pk, "name": g.get("name_en", ""), "first": _date(date), "count": 0, "examples": []})
            e["count"] += 1
            e["last"] = _date(date)
            for ex in g.get("examples", []) or []:
                if isinstance(ex, dict):
                    ex = ex.get("kr") or ex.get("example_kr") or ""
                if ex and isinstance(ex, str) and ex not in e["examples"] and len(e["examples"]) < 3:
                    e["examples"].append(ex)
        for c in data.get("corrections", []) or []:
            if not isinstance(c, dict):
                continue
            # 실제 스키마: student_said_kr, correction_kr, correction_kind, severity, time
            kind = c.get("correction_kind") or c.get("error_type") or c.get("type") or "교정"
            right = (c.get("reviewer_normalized_correction_kr") or c.get("correction_kr") or c.get("corrected_kr") or c.get("right") or "").strip()
            wrong = (c.get("student_said_kr") or c.get("learner_kr") or c.get("wrong") or "").strip()
            pat = c.get("pattern") or c.get("target") or ""
            key = f"{kind}|{pat or right[:30]}"
            e = errors.setdefault(key, {"type": kind, "pattern": pat, "count": 0})
            e["count"] += 1
            e["wrong"] = wrong[:80] or e.get("wrong", "")
            e["right"] = right[:80] or e.get("right", "")
            e["last"] = _date(date)
        ns = data.get("next_steps") if isinstance(data.get("next_steps"), dict) else {}
        for hw in ns.get("homework_items") or []:
            text = hw if isinstance(hw, str) else (hw.get("task_en") or hw.get("task") or "") if isinstance(hw, dict) else ""
            if text:
                homework.append({"given": _date(date), "status": "open", "text": text[:160]})
    for c in cards or []:
        kr = c.get("kr")
        if kr:
            e = vocab.setdefault(kr, {"kr": kr, "en": c.get("en", ""), "first": c.get("date", ""), "count": 0, "lessons": []})
            e["count"] += 1
    today = dt.date.today()
    n_less = len(lessons)
    for e in vocab.values():
        age = n_less - 1 - e.get("li", 0)  # 0 = 가장 최근 수업
        if e.get("used", 0) >= 3:
            e["status"] = "known"
        elif age >= 10:
            e["status"] = "old"  # 오래전 단어: 메모리에는 남지만 힌트·복습에서는 뺀다
        else:
            e["status"] = "learning"
            try:
                last = dt.date.fromisoformat(e.get("lastIso", "")[:10])
                gap = 1 if e.get("shaky") else REVIEW_DAYS[min(len(REVIEW_DAYS) - 1, e["count"] - 1)]
                due = last + dt.timedelta(days=gap)
                e["due"] = due.isoformat()
                # 복습은 최근 3번 수업 단어 + 흔들린 단어만 (실데이터: 기준 없이 두면 900개가 전부 '복습')
                if due <= today and (age < 3 or (e.get("shaky") and age < 6)):
                    e["status"] = "review"
            except ValueError:
                pass
        e["age"] = age
        for k in ("lastIso", "lessons", "shaky", "used", "li"):
            e.pop(k, None)
    rank = {"review": 0, "learning": 1, "known": 2, "old": 3}
    vlist = sorted(vocab.values(), key=lambda v: (rank.get(v["status"], 4), v.get("age", 99), -(v.get("count") or 0)))
    vlist = vlist[:500]  # 판이 들고 다닐 만큼만 (최근·복습 우선)
    elist = sorted(errors.values(), key=lambda e: -e["count"])
    mem = {
        "schema": "kwd-memory/v1",
        "student": sid,
        "updatedAt": dt.datetime.now(KST).isoformat(timespec="seconds"),
        "profile": {"level": level, "lessons": len(files)},
        "vocab": vlist,
        "grammar": list(grammar.values()),
        "errors": elist,
        "homework": homework[-5:],
        "lessons": lessons[-12:][::-1],
    }
    mem["next"] = {
        "focus": [g["pattern"] for g in list(grammar.values())[-2:]],
        "review": [v["kr"] for v in vlist if v["status"] == "review"][:10],
        "checkErrors": [f"{e['type']} {e['pattern']}".strip() for e in elist[:3]],
        "homework": [h["text"] for h in homework[-2:] if h["text"]],
    }
    return mem

# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["hint", "sync", "compact", "prompt", "memory", "all"])
    ap.add_argument("--bundle")
    ap.add_argument("--transcript")
    ap.add_argument("--video-start", help="녹화 파일 이름(파일명에 시작 시각이 없을 때)")
    ap.add_argument("--memory")
    ap.add_argument("--student-dir")
    ap.add_argument("--student")
    ap.add_argument("--out", default=".")
    a = ap.parse_args(argv)
    out = Path(a.out)
    if a.cmd == "memory":
        mem = build_memory(a.student_dir, a.student)
        target = out if out.suffix == ".json" else out / "memory.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(mem, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"memory.json: 단어 {len(mem['vocab'])} · 문형 {len(mem['grammar'])} · 오류 {len(mem['errors'])} · 복습 {len(mem['next']['review'])} → {target}")
        return 0
    b = Bundle(a.bundle)
    if a.cmd == "hint":
        print(json.dumps(vocab_hint(b), ensure_ascii=False, indent=1))
        return 0
    tr = load_transcript(a.transcript)
    s = sync(b, tr, a.video_start)
    mem = json.loads(Path(a.memory).read_text(encoding="utf-8")) if a.memory else None
    if a.cmd == "sync":
        print(json.dumps(s["report"], ensure_ascii=False, indent=1))
        return 0
    c = compact(b, s)
    if a.cmd == "compact":
        sys.stdout.write(c)
        print(f"\n# 압축 시각표 약 {est_tokens(c)} 토큰")
        return 0
    p = build_prompt(b, c, mem)
    if a.cmd == "prompt":
        sys.stdout.write(p)
        return 0
    out.mkdir(parents=True, exist_ok=True)
    (out / "timeline.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in s["timeline"]) + "\n", encoding="utf-8")
    (out / "timeline_compact.md").write_text(c, encoding="utf-8")
    (out / "lesson_prompt.md").write_text(p, encoding="utf-8")
    (out / "sync_report.json").write_text(json.dumps(s["report"], ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "vocab_hint.json").write_text(json.dumps(vocab_hint(b), ensure_ascii=False, indent=1), encoding="utf-8")
    tok = {"timeline_compact": est_tokens(c), "board_md": est_tokens(b.board_md), "prompt_total": est_tokens(p)}
    (out / "tokens.json").write_text(json.dumps(tok, ensure_ascii=False, indent=1), encoding="utf-8")
    r = s["report"]
    print(f"싱크: {r['basis']} · 메아리 {r['echo_matches']}쌍 · 보정 {r['applied_offset_ms']}ms (흩어짐 {r.get('spread_ms')}ms)")
    print(f"토큰(추정): 시각표 {tok['timeline_compact']} · board.md {tok['board_md']} · AI 입력 합계 {tok['prompt_total']}")
    print(f"→ {out}/timeline.jsonl, timeline_compact.md, lesson_prompt.md, sync_report.json, vocab_hint.json, tokens.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
