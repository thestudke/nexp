/**
 * 本地补丁：把 DASHSCOPE_API_KEY 显式传给 MCP server `web-search-safe`。
 *
 * 背景（2026-09-28 实测）：
 *   MCP server 是 DSH（@deepseek-ai/dsh-mcp-client）spawn 的，而它的子进程环境是
 *   `buildChildEnv(config.env) = { ...scrubbedParentEnv(), ...config.env }` ——
 *   **父进程环境被清洗过**，所以即便 start-dsh.sh 导出了 DASHSCOPE_API_KEY，
 *   MCP server 里也拿不到（实测：DSH 进程有 Key，mcp-web-search-safe.js 进程没有），
 *   qwenSearch 会直接报「未配置 DASHSCOPE_API_KEY」并回退到 360。
 *
 * 必须做两件事，否则会在下次跑 scripts/setup-dsh.mjs 时被打回原形：
 *   ① 让 setup-dsh.mjs 生成 env 字段（它按固定模板重写 cordis.patch.yml 的 MCP 区块）
 *   ② 在当前的 profiles/web/cordis.patch.yml 里补上 env 块
 *
 * 幂等：两处都带标记，已打过就跳过。nexp 升级后重跑本脚本即可。
 * 用法：node apply-mcp-env.mjs [--app-dir DIR] [--dsh-home DIR] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'dsh-home': { type: 'string' },
    quiet: { type: 'boolean', default: false }
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const dshHome = path.resolve(values['dsh-home'] || path.join(__dirname, '..', 'dsh-home'));
const setupFile = path.join(appDir, 'scripts', 'setup-dsh.mjs');
const patchFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
const log = (m) => { if (!values.quiet) console.log(m); };
const ENV_KEY = 'DASHSCOPE_API_KEY';

function readKey() {
  const key = String(process.env[ENV_KEY] || '').trim();
  if (!key) {
    console.error(`环境里没有 ${ENV_KEY}（先从 start-dsh.sh / start-bridge.sh 里取一次再跑）`);
    process.exit(1);
  }
  return key;
}

// ── ① setup-dsh.mjs：让它在 web-search-safe 条目里生成 env ──────────────────
if (!fs.existsSync(setupFile)) {
  console.error('找不到 ' + setupFile);
  process.exit(1);
}
let setup = fs.readFileSync(setupFile, 'utf8');

if (setup.includes('@@LOCAL-PATCH:mcp-env')) {
  log('setup-dsh.mjs 已打过补丁，跳过。');
} else {
  const OLD_SERVER_LINE = "    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },";
  const NEW_SERVER_LINE = `    // @@LOCAL-PATCH:mcp-env —— MCP 子进程环境被 scrubbedParentEnv() 清洗，
    // 所以 qwen 搜索的 Key 必须由 config.env 显式传入，光在 shell 里 export 没用。
    'mcp-web-search-safe': {
      serverName: 'web-search-safe',
      script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'),
      env: process.env.DASHSCOPE_API_KEY ? { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY } : {}
    },`;

  const OLD_EMIT = `    if (s.toolCallTimeoutMs) out += \`        toolCallTimeoutMs: \${s.toolCallTimeoutMs}\\n\`;`;
  const NEW_EMIT = `    if (s.toolCallTimeoutMs) out += \`        toolCallTimeoutMs: \${s.toolCallTimeoutMs}\\n\`;
    // @@LOCAL-PATCH:mcp-env —— 逐条写出环境变量（块映射，dsh 的 yaml 解析器能读成 dict）
    const envEntries = Object.entries(s.env || {});
    if (envEntries.length) {
      out += \`        env:\\n\`;
      for (const [k, v] of envEntries) out += \`          \${k}: \${yamlSingleQuote(v)}\\n\`;
    }`;

  const missing = [];
  if (!setup.includes(OLD_SERVER_LINE)) missing.push('servers 里的 mcp-web-search-safe 行');
  if (!setup.includes(OLD_EMIT)) missing.push('emit 段落');
  if (missing.length) {
    console.error('setup-dsh.mjs 锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - '));
    process.exit(1);
  }
  setup = setup.replace(OLD_SERVER_LINE, NEW_SERVER_LINE).replace(OLD_EMIT, NEW_EMIT);
  fs.writeFileSync(setupFile, setup, 'utf8');
  log('① setup-dsh.mjs 已打补丁（新增 env 支持）');
}

// ── ② 当前的 cordis.patch.yml：给 mcp-web-search-safe 补 env 块 ─────────────
if (!fs.existsSync(patchFile)) {
  console.error('找不到 ' + patchFile);
  process.exit(1);
}
let patch = fs.readFileSync(patchFile, 'utf8');

if (patch.includes('@@LOCAL-PATCH:mcp-env')) {
  log('cordis.patch.yml 已有 env 块，跳过。');
} else {
  // 在 mcp-web-search-safe 的 args 之后插入 env（它总是该区块里最后一个字段，除非有 timeout）
  const marker = "          - 'src/mcp-web-search-safe.js'";
  if (!patch.includes(marker)) {
    console.error('cordis.patch.yml 锚点缺失（找不到 web-search-safe 的 args），中止（未改动文件）');
    process.exit(1);
  }
  const key = readKey();
  const envBlock = `        env:
          # @@LOCAL-PATCH:mcp-env —— 见 apply-mcp-env.mjs：MCP 子进程环境会被清洗，Key 必须显式传。
          ${ENV_KEY}: '${key}'`;
  patch = patch.replace(marker, marker + '\n' + envBlock);
  fs.writeFileSync(patchFile, patch, 'utf8');
  log('② cordis.patch.yml 已注入 env 块');
}

log('  下一步：systemctl --user restart nexp-dsh.service && sleep 25 && systemctl --user restart nexp.service');
