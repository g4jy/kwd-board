#!/usr/bin/env python3
"""KWD 수업 판용 학생 단어·문형 묶음 만들기 (읽기 전용).

중앙 DB(`C:/KWD/data/*.db`)에서 학생마다 첫 수업부터 지금까지의 단어·문형 전부와
'관련 있는 것'을 뽑아 `work/board_data/<학생 폴더 이름>.json` 으로 쓴다.
판은 KWD 폴더가 연결돼 있으면 이 파일을 읽어 '단어' 탭에 보여준다.

관련의 근거 (DB에 실제로 있는 것만):
  - 같은 챕터: curriculum_chapter_vocab_allocation_full (그 단어가 배정된 챕터의 다른 단어)
  - 같은 묶음: vocabulary.category (actions·food·places 같은 의미 묶음)
  - 헷갈리는 짝: grammar_patterns.comparison_pattern
  - 같은 챕터 문형 / 같은 수업 묶음 / 같은 문법 계열: curriculum_chapter_grammar_map,
    curriculum_lesson_group_members, curriculum_grammar_family_members
동의어·반의어 표와 우리말샘 벡터(임베딩)는 DB에 없다 — 만들어지면 여기에 더한다.

  python kwd_board_export.py [--db C:/KWD/data/x.db] [--work C:/KWD/work] [--student 이름]
표준 라이브러리만. DB는 mode=ro 로 연다.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import sys

SKIP_CATS = {None, '', 'lesson_markdown', 'connect', 'expression', 'phrase', 'noun', 'verb', 'uncategorized', 'adjective', 'adverb'}
CAP = 8


def q(c, sql, args=()):
    try:
        return c.execute(sql, args).fetchall()
    except sqlite3.Error as e:  # 표가 없거나 바뀐 DB
        print('  (건너뜀)', e, file=sys.stderr)
        return []


def chapter_index(c):
    """챕터 정보 + 단어/문형 배정."""
    ch = {}
    for code, target, lvl, cat, sub, meaning in q(c, "select chapter_code,target,fly_level,category,subcategory,meaning_en from curriculum_final_chapter_plan"):
        ch[code] = {'code': code, 'target': target, 'level': lvl, 'cat': cat, 'sub': sub, 'meaning': meaning}
    words = {}  # headword -> [(chapter, role)]
    chap_words = {}  # chapter -> [headword] core 먼저
    for code, hw, role, en in q(c, "select chapter_code, headword, allocation_role, english_gloss from curriculum_chapter_vocab_allocation_full order by allocation_role desc, slot_no"):
        words.setdefault(hw, []).append((code, role))
        lst = chap_words.setdefault(code, [])
        if len(lst) < 40:
            lst.append((hw, en or '', role))
    pat_ch = {}  # pattern_id -> [chapter]
    for code, ids in q(c, "select chapter_code, grammar_pattern_ids_json from curriculum_chapter_grammar_map"):
        try:
            for pid in json.loads(ids or '[]'):
                pat_ch.setdefault(int(pid), []).append(code)
        except (ValueError, TypeError):
            pass
    group_of, group_members = {}, {}
    for gid, code in q(c, "select group_id, chapter_code from curriculum_lesson_group_members order by group_id, member_order"):
        group_of[code] = gid
        group_members.setdefault(gid, []).append(code)
    fam_of, fam_members, fam_name = {}, {}, {}
    for fid, name in q(c, "select family_id, family_name from curriculum_grammar_family_map"):
        fam_name[fid] = name
    for fid, code in q(c, "select family_id, group_id from curriculum_grammar_family_members order by priority"):
        fam_of.setdefault(code, []).append(fid)
        fam_members.setdefault(fid, []).append(code)
    return ch, words, chap_words, pat_ch, group_of, group_members, fam_of, fam_members, fam_name


def export_student(c, st, idx, cat_words):
    sid, name, preply, folder = st
    ch, words, chap_words, pat_ch, group_of, group_members, fam_of, fam_members, fam_name = idx
    vrows = q(c, """select sv.kr_word, coalesce(v.korean, sv.kr_word), v.english, v.category, v.part_of_speech, v.topik_level,
                    sv.first_lesson, sv.last_seen_lesson, sv.times_seen, sv.status
                    from student_vocabulary sv left join vocabulary v on v.id = sv.vocab_id
                    where sv.student_id = ? order by coalesce(sv.first_lesson, 9999), sv.id""", (sid,))
    vocab, known = [], set()
    for kr, ko, en, cat, pos, topik, first, last, seen, status in vrows:
        w = (ko or kr or '').strip()
        if not w or w in known:
            continue
        known.add(w)
        vocab.append({'w': w, 'en': en or '', 'cat': cat if cat not in SKIP_CATS else '', 'pos': pos or '', 'topik': topik,
                      'first': first, 'last': last, 'seen': seen or 0, 'status': status or ''})
    grows = q(c, """select gp.id, gp.pattern, gp.pattern_en, gp.category, gp.subcategory, gp.meaning, gp.comparison_pattern,
                    gp.example_1_kr, gp.example_1_en, sg.status, sg.first_lesson, sg.practice_count
                    from student_grammar sg join grammar_patterns gp on gp.id = sg.pattern_id
                    where sg.student_id = ? order by coalesce(sg.first_lesson, 9999), sg.id""", (sid,))
    known_pats = {r[1] for r in grows}
    grammar = []
    for pid, pat, pen, cat, sub, meaning, comp, ex, exen, status, first, cnt in grows:
        g = {'p': pat, 'en': pen or '', 'cat': cat or '', 'sub': sub or '', 'meaning': meaning or '', 'ex': ex or '', 'ex_en': exen or '',
             'status': status or '', 'first': first, 'count': cnt or 0, 'rel': {}}
        if comp:
            g['rel']['헷갈리는 짝'] = [x.strip() for x in re.split(r'\s*[,;]\s*', comp) if x.strip()][:CAP]
        chs = pat_ch.get(pid, [])
        if chs:
            code = chs[0]
            info = ch.get(code, {})
            g['chapter'] = {'code': code, 'target': info.get('target', ''), 'level': info.get('level', '')}
            cw = [hw for hw, _en, role in chap_words.get(code, []) if role == 'core']
            if cw:
                g['rel']['이 챕터 단어'] = cw[:CAP]
            gid = group_of.get(code)
            if gid:
                sib = [ch[x]['target'] for x in group_members.get(gid, []) if x != code and x in ch]
                if sib:
                    g['rel']['같은 수업 묶음'] = sib[:CAP]
            fams = fam_of.get(code, [])
            if fams:
                f = fams[0]
                sib = [ch[x]['target'] for x in fam_members.get(f, []) if x != code and x in ch]
                sib = [s for s in sib if s not in known_pats][:CAP]
                if sib:
                    g['rel']['같은 계열 (' + fam_name.get(f, f) + ')'] = sib
        grammar.append(g)
    # 단어 관련
    for v in vocab:
        rel = {}
        alloc = words.get(v['w'], [])
        if alloc:
            code = sorted(alloc, key=lambda a: a[1] != 'core')[0][0]
            info = ch.get(code, {})
            v['chapter'] = {'code': code, 'target': info.get('target', ''), 'level': info.get('level', '')}
            others = [hw for hw, _en, _r in chap_words.get(code, []) if hw != v['w']]
            new = [x for x in others if x not in known][:CAP]
            old = [x for x in others if x in known][:CAP]
            if old:
                rel['같은 챕터 · 배운 것'] = old
            if new:
                rel['같은 챕터 · 새 단어'] = new
        if v['cat']:
            same = cat_words.get(v['cat'], [])
            old = [x for x in same if x in known and x != v['w']][:CAP]
            new = [x for x in same if x not in known][:CAP]
            if old:
                rel['같은 묶음 · 배운 것'] = old
            if new:
                rel['같은 묶음 · 새 단어'] = new
        v['rel'] = rel
    return {
        'student': {'id': sid, 'name': name, 'preply_id': preply, 'folder': folder},
        'generated_at': dt.datetime.now().isoformat(timespec='seconds'),
        'sources': {'relations': ['같은 챕터(커리큘럼 배정)', '같은 묶음(단어 분류)', '헷갈리는 짝(문형 비교)', '같은 수업 묶음·같은 계열(커리큘럼)'],
                    'missing': ['동의어·반의어 표', '우리말샘 벡터 유사도']},
        'vocab': vocab,
        'grammar': grammar,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db')
    ap.add_argument('--work', default='C:/KWD/work')
    ap.add_argument('--student', help='이름이나 폴더 이름 일부')
    a = ap.parse_args()
    db = a.db or (glob.glob('C:/KWD/data/*.db') or [None])[0]
    if not db or not os.path.exists(db):
        sys.exit('DB를 찾지 못했어요: --db 로 알려 주세요')
    c = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
    out = os.path.join(a.work, 'board_data')
    os.makedirs(out, exist_ok=True)
    lessons = os.path.join(a.work, 'Student_Lessons')
    folders = set(os.listdir(lessons)) if os.path.isdir(lessons) else set()
    idx = chapter_index(c)
    cat_words = {}
    for ko, cat in q(c, "select korean, category from vocabulary where korean is not null and length(korean) between 1 and 8 order by coalesce(topik_level, 9), id"):
        if cat in SKIP_CATS:
            continue
        lst = cat_words.setdefault(cat, [])
        if len(lst) < 120 and ko not in lst:
            lst.append(ko)
    sts = q(c, "select id, name, preply_id, folder_name from students where folder_name is not null and folder_name != ''")
    n = 0
    for st in sts:
        folder = st[3]
        if folders and folder not in folders:
            continue
        if a.student and a.student.lower() not in (folder + ' ' + (st[1] or '')).lower():
            continue
        data = export_student(c, st, idx, cat_words)
        if not data['vocab'] and not data['grammar']:
            continue
        with open(os.path.join(out, folder + '.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        n += 1
        print(f"{folder}: 단어 {len(data['vocab'])} · 문형 {len(data['grammar'])}")
    print(f'{n}명 → {out}')


if __name__ == '__main__':
    main()
