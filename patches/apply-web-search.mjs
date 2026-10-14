/**
 * 本地补丁：修复 web_search —— Bing 反爬挑战页导致搜索恒返回 0 条。
 *
 * 背景（2026-09-28 实测）：
 *   nexp 自带的 mcp-web-search-safe.js 只用 `cn.bing.com/search` 抓 HTML 并匹配
 *   `<li class="b_algo">`。实测 Bing 现在返回的是**反爬挑战页**：
 *     - HTML 长度 83KB，但 `b_algo` / `<h2>` / `b_caption` 出现次数全是 0
 *     - 页面里除工信部备案链接外**没有任何外部链接**
 *   于是 web_search 恒返回 `{"results":[]}`（两个真实查询各 0 条）。
 *
 *   后果链：黑话研究员的 buildResearchPrompt 明确要求「用 web_search 搜索确认」，
 *   搜索恒空 ⇒ 研究员拿不到任何依据 ⇒ 只能靠模型记忆猜 ⇒ confirmed:false 或编造。
 *   这解释了为什么 state/slang.json 里只有 1 条手工词条、自动学习几乎没产出。
 *
 * 修法：改成多后端 + 自动回退，任一后端失败就换下一个，全部失败才报错并说明原因。
 *   顺序（2026-09-28 实测过的可用性）：
 *     1. www.so.com   —— 结果与中文梗最相关，标题/URL/摘要齐全 ✅
 *     2. www.bing.com —— 带 setmkt=en-US 才不吃挑战页（cn.bing.com 必挑战）✅ 备选
 *   并把「哪几个后端试过、各自为什么失败」写进返回，便于排查而不是静默变空。
 *
 * 幂等：已打过标记就跳过。nexp 升级（git pull）后重跑本脚本即可。
 * 部署位置：服务器上的工作目录（本地留档在 server-deploy/）
 * 用法：node apply-web-search.mjs [--app-dir DIR] [--quiet]
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

const MARKER = '@@LOCAL-PATCH:web-search-multi';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const file = path.join(appDir, 'src', 'mcp-web-search-safe.js');
const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');

if (src.includes(MARKER)) {
  log('已打过补丁，跳过。');
  process.exit(0);
}

const OLD_IMPL = `async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(\`搜索服务 HTTP \${res.statusCode}\`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\\/\\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\\s\\S]*?)<\\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\\s\\S]*?)<\\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}`;

const NEW_IMPL = `// ${MARKER} —— 多后端搜索。
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
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(\`360 搜索 HTTP \${res.statusCode}\`);
  const html = res.body;
  if (isChallengePage(html)) throw new Error('360 返回了验证页');
  const results = [];
  const blocks = html.split(/<li[^>]+class="[^"]*res-list[^"]*"/i).slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\\/\\/[^"]+)"/i);
    const titleMatch = block.match(/<h3[^>]*>([\\s\\S]*?)<\\/h3>/i);
    if (!hrefMatch || !titleMatch) continue;
    const snipMatch = block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\\s\\S]*?)<\\/p>/i)
      || block.match(/<p[^>]*>([\\s\\S]*?)<\\/p>/i);
    // 360 把**真实地址**放在 data-mdurl 里；href 是 so.com/link?m=… 跳转页，
    // 模型拿到跳转页没法 web_fetch 复核来源，所以优先用 data-mdurl。
    const directMatch = block.match(/data-mdurl="(https?:\\/\\/[^"]+)"/i);
    const urlStr = decodeHtml(directMatch ? directMatch[1] : hrefMatch[1]);
    const title = decodeHtml(titleMatch[1]);
    const snippet = snipMatch ? decodeHtml(snipMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
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
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(\`Bing HTTP \${res.statusCode}\`);
  const html = res.body;
  if (isChallengePage(html)) throw new Error('Bing 返回了验证页');
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\\/\\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\\s\\S]*?)<\\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\\s\\S]*?)<\\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, provider: 'bing', results };
}

const SEARCH_BACKENDS = [
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
      failures.push(\`\${backend.name}: 解析到 0 条\`);
    } catch (error) {
      failures.push(\`\${backend.name}: \${error?.message ?? error}\`);
    }
  }
  return { query, results: [], note: '所有搜索后端都没拿到结果', tried: failures };
}`;

const OLD_DESC = "'只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。'";
const NEW_DESC = "'只读搜索网络用语/梗/黑话的含义，返回搜索结果（标题/URL/摘要），多后端自动回退。仅用于理解词义，不执行任何本地操作。'";

const OLD_CALL = '      const result = await bingSearch(clean);';
const NEW_CALL = '      const result = await searchWeb(clean);';

// 先全部校验，再一次性写入
const missing = [];
if (!src.includes(OLD_IMPL)) missing.push('bingSearch 实现');
if (!src.includes(OLD_DESC)) missing.push('工具描述');
if (!src.includes(OLD_CALL)) missing.push('bingSearch 调用点');
if (missing.length) {
  console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - '));
  process.exit(1);
}

const out = src.replace(OLD_IMPL, NEW_IMPL).replace(OLD_DESC, NEW_DESC).replace(OLD_CALL, NEW_CALL);
fs.writeFileSync(file, out, 'utf8');
log(`补丁已写入 ${file}`);
log('  1) bingSearch → so360Search + bingSearch + searchWeb（多后端回退）');
log('  2) 增加反爬挑战页识别 isChallengePage');
log('  3) Bing 强制 setmkt=en-US（cn.bing.com 与无 setmkt 都会吃挑战页）');
log('  下一步：MCP server 由 DSH spawn，需重启 DSH 再重启 bridge');
