#!/bin/bash
# 개발용: 동기화 서버(1234)와 미리보기(4173)를 다시 띄운다
cd "$(dirname "$0")/.."
for p in $(pgrep -f "node server/node/server.mjs"); do kill $p; done
for p in $(pgrep -f "vite preview --port 4173"); do kill $p; done
sleep 0.5
TEACHER_TOKEN=testtoken PORT=1234 nohup node server/node/server.mjs > /tmp/ws.log 2>&1 &
nohup npx vite preview --port 4173 --strictPort > /tmp/vite.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "preview %{http_code}\n" localhost:4173/
curl -s -o /dev/null -w "ws %{http_code}\n" localhost:1234/time
