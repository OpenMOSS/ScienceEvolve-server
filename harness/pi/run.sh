#!/usr/bin/env bash
# 启动 pi（自包含配置目录 + SII 网关 Qwen3.8-27B）
# 用法: ./run.sh                 # 交互模式
#       ./run.sh -p "问题"        # 打印模式（单次问答）
# 思考档位: --thinking low|medium（本网关 high/xhigh 会 400）
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export PI_CODING_AGENT_DIR="$DIR/.pi-agent"
export PI_CODING_AGENT_SESSION_DIR="$DIR/.pi-agent/sessions"
export SII_GW_API_KEY="${SII_GW_API_KEY:-${SCIENCEEVOLVE_GATEWAY_API_KEY:-${SII_API_KEY:-}}}"
if [[ -z "$SII_GW_API_KEY" ]]; then
  echo "找不到 SII_GW_API_KEY（请通过本次进程环境注入）" >&2
  exit 78
fi
mkdir -p "$PI_CODING_AGENT_DIR" "$PI_CODING_AGENT_SESSION_DIR"
# pi resolves apiKey as an environment-variable name.  Keep the checked-in
# template credential-free and refresh the per-process config on each launch.
install -m 600 "$DIR/models.json.example" "$PI_CODING_AGENT_DIR/models.json"
exec "$DIR/node_modules/.bin/pi" --provider sii --model Qwen3.8-27B "$@"
