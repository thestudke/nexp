#!/bin/bash
# 部署健康检查。可覆盖 APP_DIR（默认 $HOME/nexp）与 DSH 地址。
APP_DIR="${APP_DIR:-$HOME/nexp}"
DSH_URL="${DSH_URL:-http://127.0.0.1:3080}"
ok=0; fail=0
chk() { # chk <名称> <实际值> <期望值>
  if [ "$2" = "$3" ]; then echo "  ✓ $1: $2"; ok=$((ok+1));
  else echo "  ✗ $1: 实际[$2] 期望[$3]"; fail=$((fail+1)); fi
}
T=$(cat "${APP_DIR}/state/console-token" 2>/dev/null)
chk "控制台令牌" "${T:+已配置}" "已配置"
chk "运行模式" "$(python3 -c "import json;print(json.load(open('${APP_DIR}/state/mode.json'))['mode'])" 2>/dev/null)" "reserved2"
chk "测试残留清理" "$(ls "${APP_DIR}/state/" 2>/dev/null | grep -c 'self-test\|test-home')" "0"
chk "DSH 可达" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${DSH_URL}/" 2>/dev/null)" "200"
echo "通过 $ok 项，失败 $fail 项"
[ "$fail" -eq 0 ]
