/**
 * 本地补丁：web_search 切到百炼（DashScope）qwen 搜索，替换已失效的 Bing HTML 抓取。
 *
 * 背景（2026-09-28 实测）：
 *   ① mcp-web-search-safe.js 原本只用 cn.bing.com 抓 HTML 解析 <li class="b_algo">。
 *      Bing 现在返回反爬挑战页：83KB HTML 里 b_algo/h2/b_caption 全为 0，
 *      除工信部备案链接外无任何外部链接 → web_search 恒返回 {"results":[]}。
 *   ② 后果链：黑话研究员 buildResearchPrompt 要求「用 web_search 搜索确认」，搜索恒空 ⇒
 *      拿不到依据 ⇒ 只能靠模型记忆 ⇒ confirmed:false 或编造。slang.json 只有 1 条手工词条。
 *   ③ 用户判断：Bing 这条路走不通，换 qwen 搜索。
 *
 * 实测出能拿到来源 URL 的调用形态（关键试错记录）：
 *   POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation
 *   { model, input:{messages:[...]},
 *     parameters:{ enable_search:true,
 *                  search_options:{ enable_source:true, enable_citation:true, citation_format:'[<number>]' },
 *                  result_format:'message', max_tokens } }
 *   → 响应 output.search_info.search_results[] = { index, title, url, site_name, icon }
 *
 *   以下形态拿不到来源，别用：
 *   - 兼容模式 /compatible-mode/v1/chat/completions + enable_search → 只回文本，无 search_info
 *   - 原生端点不带 result_format:'message' → output 只有 text/finish_reason
 *   - 模型名 'qwen-plus-search' → 兼容模式 model_not_supported
 *
 *   注意：src/safe-fetch.js 的 safeFetch 只支持 GET（签名 safeFetch(url, maxChars)），
 *   不能做 POST。百炼是固定可信端点，这里用内置 fetch + 超时 + 长度上限。
 *
 * 后端顺序：qwen（有 Key 时） → 360 → Bing。任一拿到结果即返回；全失败则带回各自失败原因。
 *
 * 幂等：已打过标记就跳过。nexp 升级（git pull）后重跑本脚本即可。
 * 用法：node apply-web-search-qwen.mjs [--app-dir DIR] [--quiet]
 *      （Key 从环境变量 DASHSCOPE_API_KEY 读取，由 start-bridge.sh 提供）
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

const MARKER = '@@LOCAL-PATCH:qwen-search';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const file = path.join(appDir, 'src', 'mcp-web-search-safe.js');
const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(file)) {
  console.error('找不到 ' + file);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');

if (src.includes(MARKER)) {
  log('已打过标记，跳过。');
  process.exit(0);
}

const DESCS = [
  "'只读搜索网络用语/梗/黑话的含义，返回搜索结果（标题/URL/摘要），多后端自动回退。仅用于理解词义，不执行任何本地操作。'",
  "'只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。'"
];
const descAnchor = DESCS.find((d) => src.includes(d)) || null;

const CALLS = [
  '      const result = await searchWeb(clean);',
  '      const result = await bingSearch(clean);'
];
const callAnchor = CALLS.find((c) => src.includes(c)) || null;

const IMPORT_ANCHOR = "import { safeFetch } from './safe-fetch.js';";
const SEARCH_FN_ANCHOR = 'async function searchWeb(query) {';
const BACKENDS_ANCHOR = 'const SEARCH_BACKENDS = [';
const NEW_DESC = "'只读搜索网络用语/梗/黑话的含义，返回搜索结果（标题/URL/摘要）。主用百炼 qwen 联网检索（含来源），失败自动回退 360/Bing。仅用于理解词义，不执行任何本地操作。'";

const missing = [];
if (!descAnchor) missing.push('工具描述');
if (!callAnchor) missing.push('web_search 调用点');
if (!src.includes(IMPORT_ANCHOR)) missing.push('safeFetch import');
if (!src.includes(SEARCH_FN_ANCHOR)) missing.push('searchWeb 函数（请先打 apply-web-search.mjs）');
if (!src.includes(BACKENDS_ANCHOR)) missing.push('SEARCH_BACKENDS 定义');
if (missing.length) {
  console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - '));
  process.exit(1);
}

const QWEN_IMPL = `// ${MARKER} —— 百炼（DashScope）qwen 搜索。
// 只有这一种调用形态能拿到来源 URL：原生 generation 端点 + result_format:'message'
// + search_options.enable_source —— 兼容模式与缺 result_format 的形态都只回文本。
const DASHSCOPE_HOST = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com';
const DASHSCOPE_MODEL = process.env.DASHSCOPE_SEARCH_MODEL || 'qwen-plus';

function dashscopeKey() {
  return String(process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_SEARCH_KEY || '').trim();
}

// safe-fetch.js 的 safeFetch 只支持 GET，不能 POST。百炼是固定可信端点，
// 这里用内置 fetch，并自己加超时与响应长度上限，避免拖垮 MCP 进程。
async function postJson(url, headers, bodyObj, timeoutMs = 60000, maxChars = 512000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: ac.signal
    });
    const text = await resp.text();
    const trimmed = text.length > maxChars ? text.slice(0, maxChars) : text;
    let json = null;
    try { json = JSON.parse(trimmed); } catch {}
    return { statusCode: resp.status, json, body: trimmed };
  } finally {
    clearTimeout(timer);
  }
}

async function qwenSearch(query) {
  const apiKey = dashscopeKey();
  if (!apiKey) throw new Error('未配置 DASHSCOPE_API_KEY');
  const endpoint = DASHSCOPE_HOST.replace(/\\/+$/, '') + '/api/v1/services/aigc/text-generation/generation';
  const body = {
    model: DASHSCOPE_MODEL,
    input: {
      messages: [
        { role: 'system', content: '你是联网检索助手。请基于检索到的网页事实简洁回答，保留关键事实与时间，不要编造。' },
        { role: 'user', content: query }
      ]
    },
    parameters: {
      enable_search: true,
      search_options: { enable_source: true, enable_citation: true, citation_format: '[<number>]' },
      result_format: 'message',
      max_tokens: 700
    }
  };
  const res = await postJson(endpoint, { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg = res.json?.message || res.json?.error?.message || res.body.slice(0, 120);
    throw new Error('百炼 HTTP ' + res.statusCode + '：' + String(msg).slice(0, 160));
  }
  const out = res.json?.output ?? {};
  const sources = Array.isArray(out.search_info?.search_results) ? out.search_info.search_results : [];
  const answer = extractAnswerText(out);
  const results = [];
  if (answer) {
    results.push({ title: '【qwen 检索结论】' + query, url: '', snippet: answer.slice(0, 1200) });
  }
  for (const s of sources) {
    if (!s || !s.url) continue;
    const idx = s.index != null ? '[' + s.index + '] ' : '';
    const site = s.site_name ? s.site_name + ' · ' : '';
    results.push({ title: idx + (s.title || s.url), url: String(s.url), snippet: site + (s.title || '') });
    if (results.length >= 12) break;
  }
  return { query, provider: 'qwen', results };
}

// 百炼 message 形态可能是 output.choices[0].message.content 或 output.text，两种都兜。
function extractAnswerText(out) {
  const c = out?.choices?.[0];
  const fromChoices = c?.message?.content ?? c?.message?.reasoning_content;
  if (typeof fromChoices === 'string' && fromChoices.trim()) return fromChoices.trim();
  if (typeof out?.text === 'string' && out.text.trim()) return out.text.trim();
  return '';
}

`;

let out = src;
out = out.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + '\n' + QWEN_IMPL);
out = out.replace(BACKENDS_ANCHOR, BACKENDS_ANCHOR + "\n  { name: 'qwen', run: qwenSearch },");
out = out.replace(descAnchor, NEW_DESC);
out = out.replace(callAnchor, '      const result = await searchWeb(clean);');

fs.writeFileSync(file, out, 'utf8');
log('补丁已写入 ' + file);
log('  1) 新增 qwenSearch：原生端点 + enable_source + result_format:message → search_results 带 url');
log('  2) 后端顺序 qwen → so360 → bing，任一有结果即返回');
log('  3) web_search 描述更新');
log('  下一步：把 DASHSCOPE_API_KEY 写进 start-bridge.sh，重启 DSH 再重启 bridge');
