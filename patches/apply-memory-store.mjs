/**
 * 本地补丁（记忆框架 第 1 步·接线）：让 markdown 记忆库成为**记忆真相源**。
 *
 * 背景：
 *   第 1 步已把记忆迁成 `state/memory/<会话>/人物-XXX.md`（一条事实一条）。
 *   但注入层原来读的是 `social-v2.json` 里**被 50 字截断**的旧条目，
 *   于是「修好的事实」进不了提示词。本补丁把读取切到 md。
 *
 * 设计：
 *   - **md 优先，JSON 兜底**：md 里该会话有内容就用 md；md 缺失/读取失败则回退 JSON。
 *     这样"记忆库被误删"不会让机器人失忆。
 *   - 检索层保持纯函数：md 条目通过 `st.__mdEntries` 注入，flattenMemory 优先用它。
 *   - 每次唤醒读一次 md（7 个文件级别，开销可忽略）。
 *
 * 幂等：带 @@LOCAL-PATCH:memory-store 标记。
 * 用法：node apply-memory-store.mjs [--app-dir DIR] [--framework DIR] [--quiet]
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

const MARKER = '@@LOCAL-PATCH:memory-store';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const fwDir = path.resolve(values.framework || path.join(__dirname, '..', 'nexp-memory'));
const file = path.join(appDir, 'src', 'bridge.js');
const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(file)) { console.error('找不到 ' + file); process.exit(1); }
let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER)) { log('已打过标记，跳过。'); process.exit(0); }

// ── 1) 同步两个模块到仓库 src/ ──────────────────────────────────────────────
for (const name of ['retrieval.js', 'store.js']) {
  const s = path.join(fwDir, 'src', name);
  const d = path.join(appDir, 'src', name === 'retrieval.js' ? 'memory-retrieval.js' : 'memory-store.js');
  if (!fs.existsSync(s)) { console.error('找不到框架模块 ' + s); process.exit(1); }
  fs.copyFileSync(s, d);
  log('已同步 ' + d);
}

// ── 2) 检索层：支持从 st.__mdEntries 读条目（md 优先）───────────────────────
const RETR = path.join(appDir, 'src', 'memory-retrieval.js');
let retr = fs.readFileSync(RETR, 'utf8');
if (retr.includes('__mdEntries')) {
  log('检索层已支持 md 条目，跳过。');
} else {
  const A = "export function flattenMemory(st) {\n  const out = [];";
  const B = `export function flattenMemory(st) {
  // ${MARKER} —— md 记忆库优先：桥接会先把 markdown 条目挂到 st.__mdEntries。
  // 为空（md 缺失/读取失败）时回退到 JSON 里的三字段，保证"记忆库被删也不会失忆"。
  const md = Array.isArray(st?.__mdEntries) ? st.__mdEntries : null;
  if (md && md.length) {
    return md.map((e, i) => ({
      id: e.id || \`md:\${i}\`,
      category: e.category || 'memberImpression',
      text: String(e.text ?? ''),
      extra: String(e.extra ?? ''),
      names: Array.isArray(e.names) ? e.names : [],
      at: Number(e.at) || 0,
      raw: e
    })).filter((e) => e.text);
  }
  const out = [];`;
  if (!retr.includes(A)) { console.error('检索层锚点缺失，中止'); process.exit(1); }
  retr = retr.replace(A, B);
  fs.writeFileSync(RETR, retr, 'utf8');
  log('检索层已支持 st.__mdEntries（md 优先、JSON 兜底）');
}

// ── 3) bridge.js：读 md 并挂到 st ────────────────────────────────────────────
const IMPORT_ANCHOR = "import { selectMemory, renderMemory, atomicize } from './memory-retrieval.js';";
const IMPORT_LINE = `${IMPORT_ANCHOR}
// ${MARKER} —— markdown 记忆库（一条事实一个文件，人可读可改）。
import { createMemoryStore, loadEntriesForRetrieval } from './memory-store.js';`;

const CONST_ANCHOR = "const MEMORY_METRICS_FILE = path.join(STATE_DIR, 'memory-metrics.jsonl');";
const CONST_LINE = `${CONST_ANCHOR}
const MEMORY_DIR = path.join(STATE_DIR, 'memory'); // ${MARKER}`;

const FN_ANCHOR = '  function buildMemoryBlockV2(key, st) {';
const FN_TEXT = `  // ${MARKER} —— 每次唤醒读一次 md 记忆库，挂到 st 上供检索层使用。
  // 读失败/为空都不抛：检索层会回退到 JSON 里的旧记忆，绝不让机器人失忆。
  let __mdStore = null;
  function mdMemoryEntries(key) {
    try {
      if (!__mdStore) __mdStore = createMemoryStore({ root: MEMORY_DIR, fs, path });
      const entries = loadEntriesForRetrieval({ store: __mdStore, key });
      return Array.isArray(entries) && entries.length ? entries : null;
    } catch (error) {
      log('读取 md 记忆库失败，回退 JSON 记忆：', error?.message ?? error);
      return null;
    }
  }
  function attachMdMemory(key, st) {
    const md = mdMemoryEntries(key);
    return md ? { ...st, __mdEntries: md } : st;
  }

`;

const OLD_CALL = '    const memoryText = buildMemoryBlockV2(key, st); // @@LOCAL-PATCH:memory-retrieval';
const NEW_CALL = '    const memoryText = buildMemoryBlockV2(key, attachMdMemory(key, st)); // @@LOCAL-PATCH:memory-retrieval @@LOCAL-PATCH:memory-store';

const missing = [];
if (!src.includes(IMPORT_ANCHOR)) missing.push('retrieval import 锚点');
if (!src.includes(CONST_ANCHOR)) missing.push('MEMORY_METRICS_FILE 锚点');
if (!src.includes(FN_ANCHOR)) missing.push('buildMemoryBlockV2 锚点');
if (!src.includes(OLD_CALL)) missing.push('记忆块调用点');
if (missing.length) { console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - ')); process.exit(1); }

const out = src
  .replace(IMPORT_ANCHOR, IMPORT_LINE)
  .replace(CONST_ANCHOR, CONST_LINE)
  .replace(FN_ANCHOR, FN_TEXT + FN_ANCHOR)
  .replace(OLD_CALL, NEW_CALL);

fs.writeFileSync(file, out, 'utf8');
log('补丁已写入 ' + file);
log('  1) 同步 memory-store.js + 更新 memory-retrieval.js（md 优先）');
log('  2) 唤醒时读 state/memory/ 并挂到 st.__mdEntries');
log('  3) 记忆块改走 md → 检索 → 渲染');
log('  回退：删掉 state/memory/ 目录即退回 JSON 记忆');
log('  下一步：systemctl --user restart nexp.service');
