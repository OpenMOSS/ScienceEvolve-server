#!/usr/bin/env bash
# 启动 Claude Code（经 CCR 协议网关 -> SII 网关 Qwen3.8-27B）
# 用法: ./run.sh                 # 交互模式
#       ./run.sh -p "问题"        # 打印模式
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export CLAUDE_CONFIG_DIR="$DIR/.claude"
export NO_PROXY="127.0.0.1,localhost,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"
export SII_GW_API_KEY="${SII_GW_API_KEY:-${SCIENCEEVOLVE_GATEWAY_API_KEY:-${SII_API_KEY:-}}}"
if [[ -z "$SII_GW_API_KEY" ]]; then
  echo "找不到 SII_GW_API_KEY（请通过本次进程环境注入）" >&2
  exit 78
fi
# 确保 CCR 网关在运行
CCR_DIR="$(cd "$DIR/../.." && pwd)/protocol-route"
export CCR_INTERNAL_HOME_DIR="$CCR_DIR/.home"
export CCR_INTERNAL_APP_DATA_DIR="$CCR_DIR/.home"
export CCR_INTERNAL_USER_DATA_DIR="$CCR_DIR/.home/app-data"
if ! curl --noproxy '*' -s --max-time 3 -H 'x-api-key: scienceevolve-local-ccr' http://127.0.0.1:3456/v1/models | grep -q Qwen3.8-27B; then
  echo "[run.sh] CCR 网关未运行，正在启动..." >&2
  "$CCR_DIR/start.sh" >&2
fi
export PATH="$DIR/node_modules/.bin:$PATH"
export CCR_CLAUDE_CODE_BIN="$DIR/node_modules/.bin/claude"
exec "$CCR_DIR/node_modules/.bin/ccr" default-claude-code cli -- "$@"
