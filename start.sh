#!/usr/bin/env bash
# JMbiji 启动脚本:本地服务(Node ≥ 22)+ 自动打开浏览器
cd "$(dirname "$0")" || exit 1
PORT="${1:-8787}"
URL="http://localhost:${PORT}"
echo "JMbiji: ${URL}"
( sleep 1; xdg-open "$URL" 2>/dev/null || open "$URL" 2>/dev/null ) &
exec node dev-server.mjs "${PORT}"
