/**
 * 本地补丁（记忆框架 第 3 环）：上下文重置前归档、重置后可搜索、启动时恢复。
 *
 * 闭环：
 *   ① 归档   —— /api/session/reset（以及控制台重置）在**清理会话状态之前**把
 *               当前对话压缩成快照写进 Obsidian 库（state/memory/<会话>/快照-*.md）
 *   ② 搜索   —— 新增 qq_memory_search 工具，模型可跨任意多次重置翻旧账
 *   ③ 恢复   —— 新建会话时把最近快照的对话尾部灌回 recentMessages，
 *               让"重置后接着聊"不至于完全断片（条数与字符数都可配）
 *
 * 为什么归档不做 LLM 摘要：那样要多花一次调用、还可能失真。落**压缩的原始对话**，
 * 需要时由模型自己检索阅读 —— 宁可存全，不存错。
 *
 * 幂等：带 @@LOCAL-PATCH:memory-archive 标记。
 * 用法：node apply-memory-archive.mjs [--app-dir DIR] [--framework DIR] [--quiet]
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

const MARKER = '@@LOCAL-PATCH:memory-archive';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const fwDir = path.resolve(values.framework || path.join(__dirname, '..', 'nexp-memory'));
const file = path.join(appDir, 'src', 'bridge.js');
const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(file)) { console.error('找不到 ' + file); process.exit(1); }
let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARKER)) { log('已打过标记，跳过。'); process.exit(0); }

// ── 1) 同步 archive.js ───────────────────────────────────────────────────────
const s1 = path.join(fwDir, 'src', 'archive.js');
const d1 = path.join(appDir, 'src', 'memory-archive.js');
if (!fs.existsSync(s1)) { console.error('找不到 ' + s1); process.exit(1); }
fs.copyFileSync(s1, d1);
log('已同步 ' + d1);

// ── 2) import + 常量 ─────────────────────────────────────────────────────────
const IMPORT_ANCHOR = "import { createMemoryStore, loadEntriesForRetrieval } from './memory-store.js';";
const IMPORT_LINE = `${IMPORT_ANCHOR}
// ${MARKER} —— 归档/检索/恢复（Obsidian 风格纯文本库）。
import { createArchiveStore } from './memory-archive.js';`;

const CONST_ANCHOR = "const MEMORY_DIR = path.join(STATE_DIR, 'memory'); // @@LOCAL-PATCH:memory-store";
const CONST_LINE = `${CONST_ANCHOR}
const ARCHIVE_SNAPSHOT_LIMIT = Number(process.env.NEXP_ARCHIVE_LIMIT) || 60;      // ${MARKER}
const RESTORE_MESSAGES = Number(process.env.NEXP_RESTORE_MESSAGES) || 12;         // ${MARKER}
const RESTORE_MAX_CHARS = Number(process.env.NEXP_RESTORE_MAX_CHARS) || 1200;     // ${MARKER}`;

// ── 3) 归档/恢复/搜索 三个函数（放在 attachMdMemory 之前）────────────────────
const FN_ANCHOR = '  let __mdStore = null;';
const FN_TEXT = `  // ${MARKER} —— 归档库（快照 / 检索 / 恢复）。
  let __archiveStore = null;
  function archiveStore() {
    if (!__archiveStore) {
      const base = createMemoryStore({ root: MEMORY_DIR, fs, path });
      __archiveStore = createArchiveStore({ root: MEMORY_DIR, fs, path, dirFor: base.dirFor });
    }
    return __archiveStore;
  }

  /**
   * 归档当前会话。**必须在清理会话状态之前调用**，否则快照是空的。
   * 任何失败都只记日志，绝不阻断重置流程 —— 归档是尽力而为，重置不能因此失败。
   */
  function archiveSession(key, reason) {
    try {
      const st = getSocialV2State(key);
      if (!st) return null;
      const memoryBlock = formatMemoryV2(st);
      const r = archiveStore().writeSnapshot(key, {
        reason, st, memoryBlock, limit: ARCHIVE_SNAPSHOT_LIMIT
      });
      log(\`已归档会话快照 \${key}（\${reason}）→ \${path.basename(r.file)}（\${r.bytes} 字节）\`);
      appendActivity(\`\${key} [memory] 已归档快照（\${reason}）\`);
      return r;
    } catch (error) {
      log('归档会话失败（不影响重置）：', error?.message ?? error);
      return null;
    }
  }

  /** 新建会话时从最近快照恢复一小段对话，避免重置后完全断片。 */
  function restoreFromArchive(key, st) {
    try {
      if (!st) return st;
      const snaps = archiveStore().recentSnapshots(key, 1);
      if (!snaps.length) return st;
      const parsed = archiveStore().loadAll().filter((d) => d.path === snaps[0].file)[0];
      if (!parsed) return st;
      // 只取「对话区」的行，且按字符预算截断 —— 恢复要轻，不能把上下文又撑爆。
      const tail = [];
      let used = 0;
      for (let i = parsed.lines.length - 1; i >= 0; i--) {
        const line = parsed.lines[i];
        if (!line.includes('：')) continue;              // 只要「谁：说了什么」形态
        if (used + line.length > RESTORE_MAX_CHARS) break;
        tail.unshift(line);
        used += line.length;
        if (tail.length >= RESTORE_MESSAGES) break;
      }
      if (!tail.length) return st;
      // 「我」是快照里对自己发言的标记；恢复时保留这个标记并置 isSelf，
      // 不去猜机器人昵称（昵称是网关给的、可能变，而 isSelf 才是判断依据）。
      const restored = tail.map((line) => {
        const idx = line.indexOf('：');
        const who = line.slice(0, idx).trim();
        const text = line.slice(idx + 1).trim();
        return { sender: who, text, plain: text, tail: text, isSelf: who === '我', time: Date.now(), restored: true };
      });
      st.recentMessages = [...restored, ...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].slice(-100);
      st.restoredFromSnapshot = path.basename(snaps[0].file);
      log(\`已从 \${path.basename(snaps[0].file)} 恢复 \${restored.length} 条对话进 \${key}\`);
      appendActivity(\`\${key} [memory] 已从快照恢复 \${restored.length} 条对话\`);
      return st;
    } catch (error) {
      log('从快照恢复失败（忽略）：', error?.message ?? error);
      return st;
    }
  }

  /** 关键词检索历史记忆与快照 */
  function searchMemory(query, limit) {
    return archiveStore().search(query, { limit: Number(limit) > 0 ? Number(limit) : 20 });
  }

`;
const OLD_ANCHOR = '  let __mdStore = null;';

const missing = [];
if (!src.includes(IMPORT_ANCHOR)) missing.push('memory-store import 锚点');
if (!src.includes(CONST_ANCHOR)) missing.push('MEMORY_DIR 锚点');
if (!src.includes(OLD_ANCHOR)) missing.push('__mdStore 锚点');
if (missing.length) { console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - ')); process.exit(1); }

let out = src
  .replace(IMPORT_ANCHOR, IMPORT_LINE)
  .replace(CONST_ANCHOR, CONST_LINE)
  .replace(OLD_ANCHOR, FN_TEXT + OLD_ANCHOR);

// ── 4) 重置端点：清理前先归档 ────────────────────────────────────────────────
const RESET_ANCHOR = `          sessionEpoch++;
          const oldSessionId = state.sessions[key];`;
const RESET_LINE = `          sessionEpoch++;
          // ${MARKER} —— 先归档再清理：清理之后 socialV2 状态就空了，快照会变成空白。
          archiveSession(key, 'context-reset');
          const oldSessionId = state.sessions[key];`;
if (!out.includes(RESET_ANCHOR)) { console.error('重置端点锚点缺失，中止'); process.exit(1); }
out = out.replace(RESET_ANCHOR, RESET_LINE);

// ── 5) 恢复：仅在**新建**会话时灌回最近快照的对话尾部 ──────────────────────
// 插在状态落盘、模型就绪之后：此时新会话确实建成了，才值得恢复。
// 只在新建路径上执行 —— 老会话继续用它自己的上下文，不会被反复灌。
const RESTORE_ANCHOR = `      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);`;
const RESTORE_LINE = `      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      // ${MARKER} —— 新会话：从最近快照恢复一小段对话。失败只记日志，绝不影响建会话。
      try {
        const stFresh = getSocialV2State(key);
        if (stFresh) restoreFromArchive(key, stFresh);
      } catch (error) { log('恢复快照失败（忽略）：', error?.message ?? error); }`;
if (!out.includes(RESTORE_ANCHOR)) { console.error('恢复插入点缺失，中止（未改动文件）'); process.exit(1); }
out = out.replace(RESTORE_ANCHOR, RESTORE_LINE);

fs.writeFileSync(file, out, 'utf8');
log('补丁已写入 ' + file);
log('  1) 同步 memory-archive.js');
log('  2) /api/session/reset 清理前归档');
log('  3) 新增 archiveSession / restoreFromArchive / searchMemory');
log('  下一步：接 qq_memory_search 工具 + 启动恢复');
