import re,sys
p='src/styles.css'
s=open(p,encoding='utf-8').read()
# 1) 토큰
root_new=""":root {
  /* T076: 앱 디자인 언어(biz/웹사이트/디자인/앱_디자인언어.md §1~3) */
  --bg: #f6f7fb;
  --paper: #ffffff;
  --ink: #0f1a3b;
  --muted: #5b6684;
  --line: #dadfec;
  --box: #e8ecf8;
  --accent: #2145c4;
  --stamp: #cf3b2c;
  --ok: #1f7a4d;
  --no: #b3261e;
  --hl: #ffe866;
  --radius: 16px;
  --font: 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Pretendard Variable', Pretendard, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --shadow: 0 0 0 1px var(--line);
}
"""
s=re.sub(r':root \{.*?\n\}\n',root_new,s,count=1,flags=re.S)
# 2) 블러 그림자 -> 1px 선 (기기 틀 .dev-box 제외)
out=[]
for line in s.split('\n'):
    if '.dev-box' in line or '.dev-laptop' in line: out.append(line); continue
    if 'box-shadow' in line:
        line=re.sub(r'box-shadow:\s*0 \d+px \d+px (?:\d+px )?rgba\([^)]*\)(?:,\s*0 \d+px \d+px rgba\([^)]*\))*;', 'box-shadow: var(--shadow);', line)
        line=re.sub(r'box-shadow:\s*0 1px 4px rgba\(0, 0, 0, 0\.3\)', 'box-shadow: none', line)
    out.append(line)
s='\n'.join(out)
s=s.replace('box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), 0 1px 4px rgba(0, 0, 0, 0.3);','box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);')
# 3) 블러 제거 (불투명 바탕으로)
s=s.replace('backdrop-filter: blur(6px);\n','').replace('backdrop-filter: blur(4px);\n','')
# 4) 색 치환
m={'#1f2a44':'var(--ink)','#f1efe9':'var(--box)','#f6f4ef':'var(--bg)','#f7f5f0':'var(--bg)','#f4f2ec':'var(--bg)','#f3f1ea':'var(--bg)',
'#55524b':'var(--muted)','#4a463f':'var(--muted)','#d8d4cb':'var(--line)','#ece9e1':'var(--line)','#ebe8e1':'var(--line)','#e9e6df':'var(--line)',
'#e4e1da':'var(--line)','#e6e2d8':'var(--line)','#c62828':'var(--no)','#d32f2f':'var(--no)','#1e7a3c':'var(--ok)','#2e7d32':'var(--ok)',
'#2563eb':'var(--accent)','#1f6feb':'var(--accent)','#1f4fae':'var(--accent)','#8a857b':'var(--muted)','#7a7670':'var(--muted)'}
head,rest=s.split('\n}\n',1)
for k,v in m.items(): rest=re.sub(re.escape(k)+r'(?![0-9a-fA-F])',v,rest,flags=re.I)
s=head+'\n}\n'+rest
# 5) 선택 상태=accent, 영상 칸 바탕=ink, 주 버튼=stamp
s=re.sub(r'(\.vf-chip\.on|\.cam-b\.on|\.rs-chip\.on|\.rs-opt\.on|\.cam-b\.primary|\.st-facts span:first-child) \{ background: var\(--ink\); border-color: var\(--ink\);',r'\1 { background: var(--accent); border-color: var(--accent);',s)
s=s.replace('.lesson-btn, .mic-rec { border: 1.5px solid var(--ink); background: var(--ink);','.lesson-btn, .mic-rec { border: 1.5px solid var(--stamp); background: var(--stamp);')
s=s.replace('.join-go { border: 0; background: var(--ink);','.join-go { border: 0; background: var(--stamp);')
s=s.replace('.mic-rec { background: #fff; color: var(--ink); }','.mic-rec { background: #fff; color: var(--ink); border-color: var(--line); }')
s=s.replace('.lesson-btn.rec { background: #fff; color: var(--no); border-color: #e7a59d; }','.lesson-btn.rec { background: #fff; color: var(--no); border-color: var(--no); }')
# 6) 12px 미만 글자 -> 12px
s=re.sub(r'font-size:\s*(9|10|11|11\.5)px',r'font-size: 12px',s)
# 7) 포커스 링 + reduced-motion (맨 아래)
s+="""
/* T076: 포커스 링·움직임 줄이기 (앱 디자인 언어 §4·§5) */
button:focus-visible, [role="button"]:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.15s !important; animation-iteration-count: 1 !important; transition-duration: 0.15s !important; }
  button:active { transform: none !important; }
}
"""
open(p,'w',encoding='utf-8').write(s)
