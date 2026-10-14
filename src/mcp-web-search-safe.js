// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
// @@LOCAL-PATCH:qwen-search —— 百炼（DashScope）qwen 搜索。
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
  const endpoint = DASHSCOPE_HOST.replace(/\/+$/, '') + '/api/v1/services/aigc/text-generation/generation';
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


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// @@LOCAL-PATCH:web-search-multi —— 多后端搜索。
// 背景：cn.bing.com 现在返回反爬挑战页（b_algo/h2 为 0，且页面无任何外部链接），
// 原来的单一 Bing HTML 解析恒返回空数组，导致黑话研究链路整体失效。
// 这里改成按顺序试多个后端，任一成功即返回；全失败则把每个后端的失败原因一并带出。
function isChallengePage(html) {
  const head = String(html ?? '').slice(0, 4000);
  const hasChallenge = /challenge|verify you are human|验证|滑块|captcha/i.test(head);
  const hasResults = /b_algo|res-list|result__a|result-link/i.test(html);
  return hasChallenge && !hasResults;
}

// 360 搜索：中文梗的结果质量最好（百科/新闻/视频站都齐），且带摘要。
async function so360Search(query) {
  const url = new URL('https://www.so.com/s');
  url.searchParams.set('q', query);
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`360 搜索 HTTP ${res.statusCode}`);
  const html = res.body;
  if (isChallengePage(html)) throw new Error('360 返回了验证页');
  const results = [];
  const blocks = html.split(/<li[^>]+class="[^"]*res-list[^"]*"/i).slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!hrefMatch || !titleMatch) continue;
    const snipMatch = block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    // 360 把**真实地址**放在 data-mdurl 里；href 是 so.com/link?m=… 跳转页，
    // 模型拿到跳转页没法 web_fetch 复核来源，所以优先用 data-mdurl。
    const directMatch = block.match(/data-mdurl="(https?:\/\/[^"]+)"/i);
    // 360 的块里可能是 https 绝对地址、协议相对（//host/…）或站点相对（/s?q=…）。
    // 后两种不是搜索结果（是站点导航/相关搜索），要丢弃，否则模型会去 fetch 搜索页自己。
    let rawUrl = directMatch ? directMatch[1] : hrefMatch[1];
    rawUrl = decodeHtml(rawUrl);
    if (rawUrl.startsWith('//')) rawUrl = 'https:' + rawUrl;
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    if (/^https?:\/\/(www\.)?so\.com\//i.test(rawUrl)) continue;
    if (/^https?:\/\/browser\.360\.cn\//i.test(rawUrl)) continue;
    const title = decodeHtml(titleMatch[1]);
    const snippet = snipMatch ? decodeHtml(snipMatch[1]) : '';
    if (rawUrl && title) results.push({ title, url: rawUrl, snippet });
    if (results.length >= 10) break;
  }
  return { query, provider: 'so360', results };
}

// Bing：**必须带 setmkt**。cn.bing.com 或去掉 setmkt 都会吃挑战页（实测 b_algo=0）。
async function bingSearch(query) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('setmkt', 'en-US');
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing HTTP ${res.statusCode}`);
  const html = res.body;
  if (isChallengePage(html)) throw new Error('Bing 返回了验证页');
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, provider: 'bing', results };
}

const SEARCH_BACKENDS = [
  { name: 'qwen', run: qwenSearch },
  { name: 'so360', run: so360Search },
  { name: 'bing', run: bingSearch }
];

async function searchWeb(query) {
  const failures = [];
  for (const backend of SEARCH_BACKENDS) {
    try {
      const out = await backend.run(query);
      // 后端可用但确实没有结果：换下一个后端再试，避免把「解析器对不上」误报成「没结果」
      if (Array.isArray(out.results) && out.results.length > 0) return out;
      failures.push(`${backend.name}: 解析到 0 条`);
    } catch (error) {
      failures.push(`${backend.name}: ${error?.message ?? error}`);
    }
  }
  return { query, results: [], note: '所有搜索后端都没拿到结果', tried: failures };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.7' });

server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回搜索结果（标题/URL/摘要）。主用百炼 qwen 联网检索（含来源），失败自动回退 360/Bing。仅用于理解词义，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await searchWeb(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
