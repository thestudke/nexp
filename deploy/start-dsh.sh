#!/bin/bash
# 启动 DSH（agent 运行时）。
#
# 可覆盖的环境变量：
#   APP_DIR   本仓库在部署机上的位置（默认 $HOME/nexp）
#   DATA_DIR  数据盘根目录（默认 $HOME/qq-data）
set -euo pipefail
APP_DIR="${APP_DIR:-$HOME/nexp}"
DATA_DIR="${DATA_DIR:-$HOME/qq-data}"

export PATH="${DATA_DIR}/qq-agent/app/.runtime/node-v22.23.2-linux-x64/bin:${APP_DIR}/npm-global/bin:$PATH"
export DSH_HOME="${APP_DIR}/dsh-home"
export DEEPSEEK_API_KEY='<REDACTED_DEEPSEEK_API_KEY>'
# 百炼（DashScope）qwen 搜索：MCP server `web-search-safe` 由 DSH spawn，
# 它的环境继承自 DSH 进程，所以这个 Key 必须在这里导出（bridge 那份只覆盖 bridge 自己）。
export DASHSCOPE_API_KEY='<REDACTED_DASHSCOPE_API_KEY>'
cd "${APP_DIR}"
exec dsh web --port 3080
