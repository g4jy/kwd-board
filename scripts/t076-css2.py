import re
p='src/styles.css'; s=open(p,encoding='utf-8').read()
# 선택 상태 규칙(.on/.active 등)의 ink 바탕 -> accent
def fix(m):
    sel,body=m.group(1),m.group(2)
    if re.search(r'\.(on|active|sel|selected)\b',sel) and 'background: var(--ink);' in body and 'demo-tab' not in sel:
        body=body.replace('background: var(--ink);','background: var(--accent);')
    return sel+'{'+body+'}'
s=re.sub(r'(^[^\n{}]+)\{([^{}]*)\}',fix,s,flags=re.M)
s=s.replace('.primary {\n  background: var(--ink);','.primary {\n  background: var(--stamp);')
open(p,'w',encoding='utf-8').write(s)
