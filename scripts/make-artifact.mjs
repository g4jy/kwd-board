// dist/ 를 한 파일(HTML 조각)로 합쳐 claude.ai 아티팩트로 올릴 수 있게 한다.
import fs from 'node:fs';
import path from 'node:path';
const dist = path.resolve('dist');
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const css = html.match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/);
const js = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/);
const cssText = fs.readFileSync(path.join(dist, css[1]), 'utf8');
const jsText = fs.readFileSync(path.join(dist, js[1]), 'utf8').replace(/<\/script>/g, '<\\/script>').replace(/\uFFFD/g, '\\uFFFD');
const out = `<title>KWD 수업 판</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${cssText}
:root{color-scheme:light}
html,body{height:100%}
body{padding-left:max(0px,env(safe-area-inset-left,0px));padding-right:max(0px,env(safe-area-inset-right,0px))}
</style>
<div id="app"></div>
<script type="module">${jsText}</script>
`;
fs.mkdirSync('dist-artifact', { recursive: true });
fs.writeFileSync('dist-artifact/kwd-board.html', out);
console.log('dist-artifact/kwd-board.html', (out.length / 1024).toFixed(0), 'KB');
