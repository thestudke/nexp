#!/bin/bash
# nexp 看门狗：由 nexp-watchdog.timer 每 15 分钟调用一次。
#
# 判断依据是桥接自己维护的单实例锁 state/bridge.lock（里面是 PID）—— 而不是扫进程名，
# 因为 bridge.js 以相对路径启动，命令行里不含仓库绝对路径（见 restart.bat 的同类说明）。
#
# 环境变量：
#   APP_DIR         本仓库位置（默认 $HOME/nexp）
#   API_RESTART_CMD 需要重启时执行的命令（默认走 systemctl --user）
set -uo pipefail

APP_DIR="${APP_DIR:-$HOME/nexp}"
API_RESTART_CMD="${API_RESTART_CMD:-systemctl --user restart nexp.service}"
LOCK="${APP_DIR}/state/bridge.lock"

log() { echo "[watchdog] $*"; }

if [ ! -f "$LOCK" ]; then
  log "锁文件不存在（桥接可能从未启动或已被手动停止）——不自动拉起，避免在维护期间打搅。"
  exit 0
fi

pid="$(tr -d '[:space:]' < "$LOCK")"
if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
  log "锁文件内容不是 PID（[$pid]）——跳过，等人工确认。"
  exit 0
fi

if kill -0 "$pid" 2>/dev/null; then
  log "桥接存活（PID $pid），无需处理。"
  exit 0
fi

log "桥接已死（锁里的 PID $pid 不存在），执行：$API_RESTART_CMD"
# shellcheck disable=SC2086
$API_RESTART_CMD || { log "重启命令失败，退出码 $?"; exit 1; }
log "重启命令已下发。"
