#!/usr/bin/env bash
set -euo pipefail

# 一键启动本机 OpenCodex gateway；Mac 域名只服务 Mac 本机 Codex 会话。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 远程访问默认监听所有网卡；需要本机调试时可在执行前覆盖 HOST/PORT。
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3737}"
export CI="${CI:-true}"
export OPENCODEX_GATEWAY_SERVICE_MODE="${OPENCODEX_GATEWAY_SERVICE_MODE:-1}"
export CODEX_WEB_CONFIG_PATH="${CODEX_WEB_CONFIG_PATH:-$ROOT_DIR/config.yaml}"

mkdir -p "$ROOT_DIR/.data/logs"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未找到 pnpm，请先安装 Node.js/pnpm 后再启动 OpenCodex。"
  exit 1
fi

echo "OpenCodex Mac gateway 启动中..."
echo "项目目录: $ROOT_DIR"
echo "监听地址: http://127.0.0.1:$PORT"
echo "远程访问: http://<Mac-IP>:$PORT 或已配置的 Tailscale Serve 域名"

# 每次启动前构建 gateway，确保本地代码改动已生效。
pnpm run build:gateway
exec node gateway/dev/run-gateway.cjs
