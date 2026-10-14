#!/bin/bash
# 启动桥接（QQ ↔ DSH）。
#
# 可覆盖的环境变量：
#   APP_DIR   本仓库在部署机上的位置（默认 $HOME/nexp）
#   DATA_DIR  数据盘根目录（默认 $HOME/qq-data）
set -euo pipefail
APP_DIR="${APP_DIR:-$HOME/nexp}"
DATA_DIR="${DATA_DIR:-$HOME/qq-data}"

# ${APP_DIR}/bin 放 ffprobe 兼容包装器（旧版 ffprobe 无 -o 选项），必须排在系统 PATH 前
export PATH="${APP_DIR}/bin:${DATA_DIR}/qq-agent/app/.runtime/node-v22.23.2-linux-x64/bin:${APP_DIR}/npm-global/bin:$PATH"
export DSH_HOME="${APP_DIR}/dsh-home"

# 语音条路径映射：SnowLuma 在容器内解析 record.file，宿主语音库需映射到容器内路径
# 注意：必须用双引号 —— 单引号会阻止 ${DATA_DIR} 展开，变量会变成字面量
export NEXP_VOICE_PATH_MAP="${DATA_DIR}/qq-agent/snowluma/data:/app/data"

cd "${APP_DIR}"
exec node src/bridge.js
