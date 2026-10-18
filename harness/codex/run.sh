#!/usr/bin/env bash
# 启动 Codex CLI（自包含 CODEX_HOME + 当前 ScienceEvolve 网关配置）
# AIGW 密钥必须由调用方在本次进程环境中注入；启动脚本不读取或解析
# ScienceEvolve 的 .env，避免把服务凭据带入独立 harness 工作目录。
# 用法: ./run.sh                 # 交互模式
#       ./run.sh exec "任务"      # 非交互执行
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export CODEX_HOME="$DIR/.codex-home"

if [[ -z "${AIGW_API_KEY:-}" ]]; then
  AIGW_API_KEY="${SCIENCEEVOLVE_GATEWAY_API_KEY:-}"
fi
if [[ -z "${AIGW_API_KEY:-}" ]]; then
  echo "找不到 AIGW_API_KEY（请通过本次进程环境注入）" >&2
  exit 78
fi
export AIGW_API_KEY

exec "$DIR/node_modules/.bin/codex" "$@"
