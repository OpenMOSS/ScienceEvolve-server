#!/usr/bin/env bash
# 启动 dsh（自包含 DSH_HOME；凭据只从本次进程环境注入）
# 用法: ./run.sh web            # 启动 Web GUI（本机端口转发后浏览器访问）
#       ./run.sh --profile headless "任务描述"
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="$DIR/.dsh-home"
export SII_GW_API_KEY="${SII_GW_API_KEY:-${SCIENCEEVOLVE_GATEWAY_API_KEY:-${SII_API_KEY:-}}}"
if [[ -z "$SII_GW_API_KEY" ]]; then
  echo "找不到 SII_GW_API_KEY（请通过本次进程环境注入）" >&2
  exit 78
fi
mkdir -p "$DSH_HOME"
[ -f "$DSH_HOME/settings.yaml" ] || cp "$DIR/settings.yaml" "$DSH_HOME/settings.yaml"
exec "$DIR/node_modules/.bin/dsh" "$@"
