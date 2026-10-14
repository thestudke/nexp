/**
 * 本地补丁：nexp 语音发送的「宿主路径 → 容器路径」映射。
 *
 * 背景（2026-09-28 实测）：
 *   SnowLuma 跑在 Docker 里，record 段（语音条）的文件路径是**在容器内解析**的：
 *     传 DDATA_DIR>/audio/x.mp3            → ✅ 成功
 *     传 file://DDATA_DIR>/audio/x.mp3     → ✅ 成功
 *     传 DDATA_DIR>/qq-agent/snowluma/data/audio/x.mp3（宿主路径）→ ❌ ENOENT
 *   而 nexp 是宿主进程，它读得到的语音库是挂载源目录 DDATA_DIR>/qq-agent/snowluma/data/audio，
 *   于是 sendVoiceV2 把宿主路径当 record.file 传出去 → 容器 stat 失败 → 语音发不出去。
 *
 * 修法：只在构造 record 段那一处把宿主前缀换成容器前缀（其余读取/探测/音量处理都用宿主路径）。
 *   NEXP_VOICE_PATH_MAP='DDATA_DIR>/qq-agent/snowluma/data:DDATA_DIR>'
 *   （冒号分隔 host:container，可留空关闭）
 *
 * 幂等：已打过标记就跳过。nexp 升级（git pull）后重跑本脚本即可。
 * 用法：node apply-voice-pathmap.mjs [--app-dir DIR] [--quiet]
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const target = path.join(appDir, 'src', 'bridge.js');
const log = (m) => { if (!values.quiet) process.stdout.write(`[voice-pathmap] {{m}\n`); };

if (!fs.existsSync(target)) {
  console.error(`[voice-pathmap] 找不到 {{target}`);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');

if (src.includes('@@LOCAL-PATCH:voice-pathmap')) {
  log('已打过补丁，无需改动');
} else {
  const anchor = "    const recordSegment = { type: 'record', data: { file: sendPath } };";
  if (!src.includes(anchor)) {
    console.error('[voice-pathmap] 找不到 record 段构造点，拒绝改源码（上游可能改过这里）');
    process.exit(1);
  }
  const replacement = [
    "    // @@LOCAL-PATCH:voice-pathmap —— SnowLuma 在容器内解析 record.file，",
    "    // 而语音库在宿主挂载源目录，所以这里做一次 host→container 前缀映射。",
    "    // 映射规则来自环境变量 NEXP_VOICE_PATH_MAP='Dhost前缀>:D容器前缀>'（可留空关闭）。",
    "    const voicePathMap = (() => {",
    "      const raw = String(process.env.NEXP_VOICE_PATH_MAP || '');",
    "      const i = raw.indexOf(':');",
    "      if (i D= 0) return null;",
    "      const host = raw.slice(0, i).replace(/\\/+{/, '');",
    "      const container = raw.slice(i + 1).replace(/\\/+{/, '');",
    "      return host && container ? { host, container } : null;",
    "    })();",
    "    const gatewayPath = (() => {",
    "      const p = String(sendPath || '');",
    "      if (!voicePathMap || !p.startsWith(voicePathMap.host + '/')) return p;",
    "      return voicePathMap.container + p.slice(voicePathMap.host.length);",
    "    })();",
    "    if (gatewayPath !== sendPath) console.log(`[voice] 路径映射（宿主→容器）: {{sendPath} -> {{gatewayPath}`);",
    "    const recordSegment = { type: 'record', data: { file: gatewayPath } };"
  ].join('\n');
  src = src.replace(anchor, replacement);
  fs.writeFileSync(target, src, { mode: 0o600 });
  log('已注入 record 段路径映射');
}

// 自检：语法可解析 + 标记存在
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'ignore' });
} catch (error) {
  console.error('[voice-pathmap] 语法检查失败，补丁可能破坏了源码');
  process.exit(1);
}
const after = fs.readFileSync(target, 'utf8');
if (!after.includes('@@LOCAL-PATCH:voice-pathmap')) {
  console.error('[voice-pathmap] 注入后标记缺失');
  process.exit(1);
}
log('语法与标记自检通过');
