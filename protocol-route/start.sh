#!/usr/bin/env bash
# 启动 CCR 协议网关（Anthropic /v1/messages -> OpenAI chat/completions）
# 幂等: 网关健康则直接返回; 否则 (重新) 启动 CCR 后台服务
# 网关地址: http://127.0.0.1:3456
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export HOME="$DIR/.home"
export CCR_INTERNAL_HOME_DIR="$DIR/.home"
export CCR_INTERNAL_APP_DATA_DIR="$DIR/.home"
export CCR_INTERNAL_USER_DATA_DIR="$DIR/.home/app-data"
export NO_PROXY="127.0.0.1,localhost,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"
export SII_GW_API_KEY="${SII_GW_API_KEY:-${SCIENCEEVOLVE_GATEWAY_API_KEY:-${SII_API_KEY:-}}}"
if [[ -z "$SII_GW_API_KEY" ]]; then
  echo "找不到 SII_GW_API_KEY（请通过本次进程环境注入）" >&2
  exit 78
fi
mkdir -p "$CCR_INTERNAL_HOME_DIR/.claude-code-router" "$CCR_INTERNAL_APP_DATA_DIR/claude-code-router" "$CCR_INTERNAL_USER_DATA_DIR"

if curl --noproxy '*' -s --max-time 3 -H 'x-api-key: scienceevolve-local-ccr' http://127.0.0.1:3456/v1/models 2>/dev/null | grep -q Qwen3.8-27B; then
  echo "CCR 网关已在运行: http://127.0.0.1:3456"
  exit 0
fi

"$DIR/node_modules/.bin/ccr" stop >/dev/null 2>&1 || true
sleep 1
"$DIR/node_modules/.bin/ccr" start --host 127.0.0.1 --gateway --no-open
i=0
while [ $i -lt 30 ]; do
  sleep 1
  i=$((i+1))
  if curl --noproxy '*' -s --max-time 3 -H 'x-api-key: scienceevolve-local-ccr' http://127.0.0.1:3456/v1/models 2>/dev/null | grep -q Qwen3.8-27B; then
    echo "CCR 网关已启动: http://127.0.0.1:3456"
    exit 0
  fi
done
echo "CCR 网关启动失败，请检查 $DIR/.home/.claude-code-router/ 下的状态与日志" >&2
exit 1
