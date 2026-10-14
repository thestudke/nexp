/**
 * 本地补丁（记忆框架 第 2 步）：把「全量注入记忆」换成「检索后按相关性注入」。
 *
 * 背景（2026-10-13 实测）：
 *   buildWakePromptV2() 里 `formatMemoryV2(st)` 把该会话**全部**记忆塞进提示词。
 *   记忆量大时既贵又稀释注意力。本补丁接上 memory-framework/src/retrieval.js
 *   做相关性检索，只注入当下相关的条目。
 *
 * 诚实说明（重要）：
 *   实测当前记忆块只有 772 字符，所以**今天几乎不省 token**（省 1%）。
 *   大头是 DSH 会话历史（476K），不在这里。这一步的价值要等记忆做大后显现。
 *   它的真正作用是：① 建立可复用的打分/过滤框架；② 给记忆做成"原子条目"后能精确挑选。
 *
 * 设计：
 *   - 默认**开启**；`NEXP_MEMORY_RETRIEVAL=0` 可一键回退到全量注入（老行为）。
 *   - 检索抛异常时**自动退回全量**（绝不让机器人失去记忆）。
 *   - 每次注入写一行 `state/memory-metrics.jsonl`，字段含 total/kept/dropped/chars，
 *     便于事后量化「省了多少」，而不是靠感觉。
 *
 * 幂等：带 @@LOCAL-PATCH:memory-retrieval 标记。升级上游后重跑。
 * 用法：node apply-memory-retrieval.mjs [--app-dir DIR] [--framework DIR] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    framework: { type: 'string' },
    quiet: { type: 'boolean', default: false }
  }
});

const MARKER = '@@LOCAL-PATCH:memory-retrieval';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const fwDir = path.resolve(values.framework || path.join(__dirname, '..', 'nexp-memory'));
const file = path.join(appDir, 'src', 'bridge.js');
const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(file)) { console.error('找不到 ' + file); process.exit(1); }
let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER)) { log('已打过标记，跳过。'); process.exit(0); }

// ── 1) 把框架模块复制进仓库（开源时是独立目录，部署时随仓库走）──────────────
const srcMod = path.join(fwDir, 'src', 'retrieval.js');
const dstMod = path.join(appDir, 'src', 'memory-retrieval.js');
if (!fs.existsSync(srcMod)) { console.error('找不到框架模块 ' + srcMod); process.exit(1); }
fs.copyFileSync(srcMod, dstMod);
log('已复制框架模块 → ' + dstMod);

// ── 2) import ────────────────────────────────────────────────────────────────
const IMPORT_ANCHOR = "} from './sticker-lib.js';";
const IMPORT_LINE = `${IMPORT_ANCHOR}
// ${MARKER} —— 记忆检索层（memory-framework）。零依赖纯函数，见 src/memory-retrieval.js。
import { selectMemory, renderMemory } from './memory-retrieval.js';`;

// ── 3) 常量：开关 + 指标文件 ─────────────────────────────────────────────────
const CONST_ANCHOR = "const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');";
const CONST_LINE = `${CONST_ANCHOR}
const MEMORY_METRICS_FILE = path.join(STATE_DIR, 'memory-metrics.jsonl'); // ${MARKER}`;

// ── 4) 替换注入点 ────────────────────────────────────────────────────────────
const OLD_CALL = `    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? \`\${memoryText}\\n\\n\` : '';`;
const NEW_CALL = `    const memoryText = buildMemoryBlockV2(key, st); // ${MARKER}
    const memoryLine = memoryText ? \`\${memoryText}\\n\\n\` : '';`;

// ── 5) 新增 buildMemoryBlockV2（放在 formatMemoryV2 之后）────────────────────
const FN_ANCHOR = '  function appendMemoryV2(st, category, content, extra = {}) {';
const NEW_FN = `  // ${MARKER} —— 记忆注入：默认先按相关性检索，只注入当下相关的条目。
  // 一键回退：NEXP_MEMORY_RETRIEVAL=0 → 走老的 formatMemoryV2（全量）。
  // 铁律：检索出任何问题都退回全量 —— 宁可多花 token，也不能让机器人失忆。
  function memoryRetrievalEnabled() {
    const v = String(process.env.NEXP_MEMORY_RETRIEVAL ?? '1').trim();
    return v !== '0' && v.toLowerCase() !== 'false';
  }
  function selectMemorySafe(st) {
    try {
      return selectMemory(st, {
        maxItems: Number(process.env.NEXP_MEMORY_MAX_ITEMS) || undefined,
        maxChars: Number(process.env.NEXP_MEMORY_MAX_CHARS) || undefined
      });
    } catch (error) {
      log('记忆检索失败，退回全量注入：', error?.message ?? error);
      return null;
    }
  }
  function buildMemoryBlockV2(key, st) {
    if (!memoryRetrievalEnabled()) return formatMemoryV2(st);
    const picked = selectMemorySafe(st);
    if (!picked) return formatMemoryV2(st);
    const text = renderMemory(picked.kept);
    // 记录指标：用来量化「省了多少」，不要靠感觉。
    try {
      fs.appendFileSync(MEMORY_METRICS_FILE, JSON.stringify({
        t: Date.now(), key,
        total: picked.stats.total, kept: picked.stats.kept, dropped: picked.stats.dropped,
        totalChars: picked.stats.totalChars, keptChars: picked.stats.keptChars,
        savedChars: picked.stats.savedChars, savedRatio: Number((picked.stats.savedRatio || 0).toFixed(3)),
        speakers: picked.stats.speakers, contextTokens: picked.stats.contextTokens
      }) + '\\n');
    } catch { /* 指标写失败不影响注入 */ }
    return text;
  }

`;

const missing = [];
if (!src.includes(IMPORT_ANCHOR)) missing.push('sticker-lib import 锚点');
if (!src.includes(CONST_ANCHOR)) missing.push('BRIDGE_LOG 常量锚点');
if (!src.includes(OLD_CALL)) missing.push('formatMemoryV2 注入点');
if (!src.includes(FN_ANCHOR)) missing.push('appendMemoryV2 函数锚点');
if (missing.length) {
  console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - '));
  process.exit(1);
}

let out = src
  .replace(IMPORT_ANCHOR, IMPORT_LINE)
  .replace(CONST_ANCHOR, CONST_LINE)
  .replace(FN_ANCHOR, NEW_FN + FN_ANCHOR)
  .replace(OLD_CALL, NEW_CALL);

fs.writeFileSync(file, out, 'utf8');
log('补丁已写入 ' + file);
log('  1) import 检索模块 + 复制 src/memory-retrieval.js');
log('  2) 新增 buildMemoryBlockV2（检索→渲染，异常退回全量）');
log('  3) 唤醒提示词的记忆块改走检索层');
log('  4) 指标写入 state/memory-metrics.jsonl');
log('  回退：NEXP_MEMORY_RETRIEVAL=0');
log('  下一步：systemctl --user restart nexp.service');
