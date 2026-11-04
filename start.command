#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null || ! command -v python3 >/dev/null; then
  echo '请先安装 Node.js 22+ 和 Python 3.9+。'
  read -r '_?按回车退出'
  exit 1
fi
if [ ! -d node_modules/@neteasecloudmusicapienhanced/api ]; then
  echo '正在安装固定版本接口依赖…'
  npm ci --ignore-scripts --no-audit --no-fund
fi
echo '日历启动后，请打开 http://127.0.0.1:8767 。关闭此窗口将停止服务，数据仍会保留。'
exec python3 -m music_calendar serve
