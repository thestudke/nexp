/**
 * 本地补丁（记忆框架 第 4 环）：把关键词检索暴露成工具 qq_memory_search。
 *
 * 有了它，模型在被重置之后仍能「翻旧账」：
 *   问「上次谁说某某梗」「某某什么时候骂过我」→ 搜快照与长期记忆 → 带日期作答。
 *
 * 两端都要改：
 *   bridge.js            —— 新增 GET /api/socialV2/memory-search（带 agentToken/白名单校验）
 *   mcp-snowluma-safe.js —— 注册 qq_memory_search 工具 + 工具开关映射
 *
 * 权限设计：复用现有 'memory' 开关（记忆类工具同一把闸），不新增开关，避免管理端漏配。
 * 返回带 session/日期/命中片段，且**不含**任何凭据。
 *
 * 幂等：带 @@LOCAL-PATCH:memory-search 标记。
 * 用法：node apply-memory-search-tool.mjs [--app-dir DIR] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { 'app-dir': { type: 'string' }, quiet: { type: 'boolean', default: false } }
});

const MARKER = '@@LOCAL-PATCH:memory-search';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const bridgeFile = path.join(appDir, 'src', 'bridge.js');
const mcpFile = path.join(appDir, 'src', 'mcp-snowluma-safe.js');
const log = (m) => { if (!values.quiet) console.log(m); };

for (const f of [bridgeFile, mcpFile]) {
  if (!fs.existsSync(f)) { console.error('找不到 ' + f); process.exit(1); }
}
let bridge = fs.readFileSync(bridgeFile, 'utf8');
let mcp = fs.readFileSync(mcpFile, 'utf8');

if (bridge.includes(MARKER) && mcp.includes(MARKER)) { log('已打过标记，跳过。'); process.exit(0); }

// ── ① bridge.js：新增搜索端点 ───────────────────────────────────────────────
const B_ANCHOR = `        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {`;
const B_NEW = `        // ${MARKER} —— 关键词检索历史快照与长期记忆（跨上下文重置翻旧账）。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-search') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          // 复用记忆类工具的同一把闸，不新增开关（避免管理端漏配导致工具静默失效）
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search（记忆工具已关闭）' }, 403); return; }
          try {
            const results = searchMemory(query, limit);
            const snapshots = archiveStore().listSnapshots(key).length;
            sendJson({
              ok: true, key, query,
              count: results.length,
              totalSnapshots: snapshots,
              results: results.map((r) => ({
                when: r.archived || '',
                kind: r.category,
                session: r.session,
                text: r.text
              })),
              hint: results.length
                ? '这些是从历史快照与长期记忆里检索到的片段，按相关度排序；引用时带上时间。'
                : \`没有搜到相关内容（当前已归档 \${snapshots} 份快照）。可以换个关键词，或先看看有没有归档过。\`
            });
          } catch (error) {
            log('记忆检索失败：', error?.message ?? error);
            sendJson({ ok: false, error: \`记忆检索失败：\${error?.message ?? error}\` }, 500);
          }
          return;
        }
${B_ANCHOR}`;

// ── ② mcp-snowluma-safe.js：工具开关映射 ────────────────────────────────────
const M_ANCHOR = `  qq_memory_query: 'memory',`;
const M_NEW = `${M_ANCHOR}
  qq_memory_search: 'memory', // ${MARKER}`;

// ── ③ mcp：工具定义（插在 qq_memory_query 的工具块之后）──────────────────────
const M_TOOL_ANCHOR = `server.tool(
  'qq_memory_remove',`;
const M_TOOL_NEW = `server.tool(
  'qq_memory_search',
  '关键词检索这个会话的**历史记忆与快照**（只读）。适合回答「上次谁说过的」「之前聊到哪了」「他什么时候骂过我」这类需要翻旧账的问题——上下文重置过的内容也能搜到。返回命中片段与时间，按相关度排序。多个关键词用空格分隔（全部命中才算）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('关键词，可空格分隔多个（AND 语义）'),
    limit: z.number().optional().describe('最多返回几条，默认 20，最大 50')
  },
  async ({ key, token, query, limit }) => {
    try {
      const q = new URLSearchParams({ key, query });
      if (limit) q.set('limit', String(limit));
      const data = await agentApi(\`/api/socialV2/memory-search?\${q.toString()}\`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: \`记忆检索失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

${M_TOOL_ANCHOR}`;

const missing = [];
if (!bridge.includes(B_ANCHOR)) missing.push('bridge /api/socialV2/memory 端点');
if (!mcp.includes(M_ANCHOR)) missing.push('mcp 工具开关映射');
if (!mcp.includes(M_TOOL_ANCHOR)) missing.push('mcp qq_memory_remove 工具块');
if (missing.length) { console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - ')); process.exit(1); }

bridge = bridge.replace(B_ANCHOR, B_NEW);
mcp = mcp.replace(M_ANCHOR, M_NEW).replace(M_TOOL_ANCHOR, M_TOOL_NEW);

fs.writeFileSync(bridgeFile, bridge, 'utf8');
fs.writeFileSync(mcpFile, mcp, 'utf8');
log('补丁已写入:');
log('  ' + bridgeFile + '（新增 /api/socialV2/memory-search）');
log('  ' + mcpFile + '（注册 qq_memory_search）');
log('  下一步：systemctl --user restart nexp.service（MCP server 由 DSH spawn，需重启 DSH）');
