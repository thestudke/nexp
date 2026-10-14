/**
 * 本地补丁：nexp 二代发送的「条内逗号过多」软提醒。
 *
 * 背景（2026-09-28 用户要求）：
 *   用户观察机器人爱用中文逗号把两截话硬连成一条，要求「减少，的使用；一句话如果需要
 *   逗号，就分成两条发」。角色卡已写明该规则（第三节「少用逗号」），但提示词是软的，
 *   模型仍可能产出「好的，我这就去弄，你等我一下」这种一条长句。
 *
 *   桥接原有的 findSplitBoundaryWarning 只查**条与条之间**的断点（上一条以逗号结尾），
 *   完全不看**条内**的逗号，所以拦不到这种形态。
 *
 * 修法：新增 findCommaHeavyWarning(messages)，命中以下任一条就回一条 commaWarn 软提醒
 *   （模型发完在同一轮的工具响应里就能看到）：
 *     条内逗号 >= 2 且长度 >= 11 ｜ 条内逗号 >= 1 且长度 >= 13 ｜ 长度 >= 26
 *   阈值按真实样本标定：卡里所有示例与正常短句都不报警，「给你存表情的，省的你没东西用」
 *   这类两截硬连的会报。
 *   **只提醒，不拦截、不改写、不拆分** —— 机械拆分会在错误的地方切断句子（「他说，」
 *   这种引语逗号切了就成病句），拆分权仍归模型。
 *   字段名用独立的 commaWarn，不占用既有的 warn（那是 spaceWarn 的字段，会互相覆盖）。
 *
 * 幂等：已打过标记就跳过。nexp 升级（git pull）后重跑本脚本即可。
 * 部署位置：服务器上的工作目录（本文件是本地留档副本）
 * 用法：node apply-comma-warn.mjs [--app-dir DIR] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    quiet: { type: 'boolean', default: false }
  }
});

const MARKER = '@@LOCAL-PATCH:comma-warn';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const bridgePath = path.join(appDir, 'src', 'bridge.js');

function log(msg) {
  if (!values.quiet) console.log(msg);
}

if (!fs.existsSync(bridgePath)) {
  console.error(`找不到 ${bridgePath}`);
  process.exit(1);
}

let src = fs.readFileSync(bridgePath, 'utf8');

if (src.includes(MARKER)) {
  log('已打过补丁，跳过。');
  process.exit(0);
}

const HELPER = `  // ${MARKER} —— 条内逗号过多时软提醒（不拦截、不改写）。
  function findCommaHeavyWarning(messages) {
    if (!Array.isArray(messages)) return null;
    const bad = [];
    for (let i = 0; i < messages.length; i++) {
      const raw = String(messages[i] ?? '').trim();
      if (!raw) continue;
      const commas = (raw.match(/[，,]/g) || []).length;
      const len = Array.from(raw).length;
      // 阈值按真实样本标定（2026-09-28）：卡里所有示例与正常短句都不报警，
      // 「给你存表情的，省的你没东西用」这种两截硬连的会报。
      if ((commas >= 2 && len >= 11) || (commas >= 1 && len >= 13) || len >= 26) bad.push(i + 1);
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? \`第 \${list[0]} 条\` : \`第 \${list.join('、')} 条\`;
    return \`\${label}偏长或逗号偏多：一句话里要停顿就拆成两条发，别用逗号把两截连在一条里。\`;
  }

`;

// 1) 插入 helper（放在 findSplitBoundaryWarning 之后、currentRoleHintV2 之前）
const anchorFn = 'function currentRoleHintV2() {';
const idxFn = src.indexOf(anchorFn);
if (idxFn === -1) {
  console.error('锚点缺失：找不到 currentRoleHintV2()，中止（未改动文件）');
  process.exit(1);
}
src = src.slice(0, idxFn) + HELPER + src.slice(idxFn);

// 2) 接到两个发送出口（qq_send_message 分条发送 / 单条发送）
const OLD_CALL = '            const splitWarn = findSplitBoundaryWarning(messages);';
const NEW_CALL = `            const splitWarn = findSplitBoundaryWarning(messages);
            const commaWarn = findCommaHeavyWarning(messages);`;

const occurrences = src.split(OLD_CALL).length - 1;
if (occurrences !== 2) {
  console.error(`锚点数量异常：findSplitBoundaryWarning 调用点 = ${occurrences}（期望 2），中止（未改动文件）`);
  process.exit(1);
}
src = src.split(OLD_CALL).join(NEW_CALL);

// 3) 把 commaWarn 加进两处响应对象（用独立字段，避免覆盖 spaceWarn 的 warn）
const OLD_WARN = '...(splitWarn ? { splitWarn } : {}) });';
const NEW_WARN = '...(splitWarn ? { splitWarn } : {}), ...(commaWarn ? { commaWarn } : {}) });';
const warnCount = src.split(OLD_WARN).length - 1;
if (warnCount !== 2) {
  console.error(`锚点数量异常：splitWarn 响应点 = ${warnCount}（期望 2），中止（未改动文件）`);
  process.exit(1);
}
src = src.split(OLD_WARN).join(NEW_WARN);

fs.writeFileSync(bridgePath, src, 'utf8');
log(`补丁已写入 ${bridgePath}`);
log('  新增 findCommaHeavyWarning + 2 个调用点 + 2 个响应字段');
log('  下一步：systemctl --user restart nexp.service');
