/**
 * 本地补丁：新增角色卡「随和」，把 lcs-unrestricted 预设里对 QQ 群聊**真有用**的部分移植进去。
 *
 * 来源：用户提供的 `lcs-unrestricted-qqagent.zip`（qq-agent-plus 插件）。
 *   那个插件本身装不进当前栈（它要 Orchestrator 钩子、resources/app/plugins、config.skills['content-guard']，
 *   本机都没有）。但它内含的 preset-lite.json 是**纯文本预设**（22 块 / 6204 字符），
 *   这部分可以移植——注意：原插件是给 SillyTavern **长文角色扮演**写的，
 *   直接搬到 QQ 群聊会与「1~10 字短句」的核心约束打架，所以这里只移植**能真起作用**的部分。
 *
 * 移植决策（22 块 → 取/弃）：
 *   取（重写为 QQ 版）：
 *     - 通用写作规范（→ 创作模式的写作风格：左分枝结构、禁比喻描写语气、禁名词化、禁精确数值）
 *     - 核心文字风格（→ 有情绪的通俗文字是好文字）
 *     - 创作准则（→ 严格第三人称、角色认知边界、结束方式、多样性）
 *     - 段落安排（→ 对话独立成行、略去"他说"）
 *     - 角色表现准则（→ 禁数据分析/学术报告式口吻）
 *     - 质量模式（→ 长文写作流程，压成一句话）
 *     - lib/app-layer.js 的长度判据（→ 创作模式触发条件 + 每条 ≤400 字）
 *   弃（本机是空转或有害）：
 *     - {{setvar}} / {{trim}} / {{//注释}} 宏：nexp 没有 SillyTavern 的宏系统，纯占位
 *     - 输出模板「必须先输出 ` 好的，这是你需要的最终输出：`」：那是酒馆排版约定，进了 QQ 就是噪音
 *     - <think> 相关：桥接的文本输出根本不发群，思考走模型自己的 reasoning 通道
 *     - qq-chat-v2 预设里已经写了长文用字符串数组分条 + `qq_send_message`，卡片再写会打架（已改写为呼应）
 *
 * 卡名用「随和」以区别于默认卡 `小鲸鱼`；默认卡**原样保留**，随时可切回。
 * 部署位置：<仓库根>/roles/随和.md
 *
 * 幂等：目标卡已存在且未加 --force 就跳过。
 * 用法：node apply-creative-card.mjs [--app-dir DIR] [--source FILE] [--force] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    source: { type: 'string' },
    force: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const src = path.resolve(values.source || '/staging/xiaojingyu-creative.md');
const dest = path.join(appDir, 'roles', '随和.md');
const log = (m) => { if (!values.quiet) console.log(m); };
const MAX = 6000;

if (!fs.existsSync(src)) {
  console.error('找不到源卡片 ' + src);
  process.exit(1);
}
const text = fs.readFileSync(src, 'utf8');

if (text.length > MAX) {
  console.error(`源卡片 ${text.length} 字符，超过注入上限 ${MAX}，拒绝安装（超出部分会被静默截尾）`);
  process.exit(1);
}
if (!text.startsWith('# 角色卡')) {
  console.error('源文件不像角色卡（首行不是 "# 角色卡"），拒绝安装');
  process.exit(1);
}

if (fs.existsSync(dest) && !values.force) {
  log('目标卡已存在，跳过（要覆盖请加 --force）：' + dest);
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, text, 'utf8');
log(`已安装 ${dest}`);
log(`  ${text.length} 字符 / 上限 ${MAX}（余量 ${MAX - text.length}）`);
log(`  小节 ${(text.match(/^## /gm) || []).length} 个`);
log('  下一步：在控制台「人格与角色」选「随和」，或');
log(`    curl -X POST -H "x-console-token: $(cat ${appDir}/state/console-token)" \\`);
log(`         -H 'content-type: application/json' -d '{"role":"随和"}' http://127.0.0.1:3100/api/role`);
