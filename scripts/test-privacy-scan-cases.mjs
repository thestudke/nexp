// privacy-scan 的判定能力回归：
//   ① 真泄露（凭据字面量、真实本机路径）**必须**被抓到；
//   ② 运行时取值（process.env.X / cfg.a.b / 裸变量 / 函数调用）**必须**不报。
//
// 为什么需要这个文件：这份回归是实测出来的 —— 曾经路径命中会被 isNoise 的
// 「高熵串」判据静默丢掉（`C:\Users\someone` 不含"大小写+数字"三项），
// 也曾经把 `apiKey = dashscopeKey` 这类正常源码报成"有实际值的凭据赋值"。
// 两种情况都只在**对着真数据跑**时才暴露，所以用固定用例钉住。
//
// 用法：node scripts/test-privacy-scan-cases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCANNER = path.join(__dirname, 'privacy-scan.mjs');
const BS = String.fromCharCode(92);   // 反斜杠，避免本文件里的转义地狱

const CASES = [
  { name: '凭据字面量（双引号）', body: 'const accessToken = "a1B2c3D4e5F6g7H8i9J0";\n', caught: true },
  { name: 'API key 字面量', body: 'const apiKey = "sk-live-9f8e7d6c5b4a3210";\n', caught: true },
  { name: 'Windows 用户目录（单反斜杠）', body: `const p = "C:${BS}Users${BS}someone${BS}x";\n`, caught: true },
  { name: 'Windows 用户目录（转义双反斜杠）', body: `const p = "C:${BS}${BS}Users${BS}${BS}someone${BS}${BS}x";\n`, caught: true },
  { name: '非系统盘本机路径', body: `const p = "D:${BS}work${BS}secret${BS}x";\n`, caught: true },
  { name: 'Linux 部署路径', body: 'const p = "/opt/qq-stack/qq-bridge/src";\n', caught: true },
  { name: '运行时取值：环境变量', body: 'const apiKey = process.env.DASHSCOPE_API_KEY;\n', caught: false },
  { name: '运行时取值：配置属性', body: 'const accessToken = cfg.snowluma.accessToken;\n', caught: false },
  { name: '运行时取值：裸变量', body: 'const apiKey = dashscopeKey;\n', caught: false },
  { name: '运行时取值：函数调用', body: 'const secret = readBrowserSessionSecret();\n', caught: false },
];

let pass = 0;
let fail = 0;
console.log('## privacy-scan 判定能力');
for (const c of CASES) {
  const file = path.join(ROOT, `_pscase-${process.pid}.mjs`);
  fs.writeFileSync(file, c.body, 'utf8');
  const r = spawnSync(process.execPath, [SCANNER], { cwd: ROOT, encoding: 'utf8' });
  fs.rmSync(file, { force: true });
  const caught = r.status !== 0;
  const ok = caught === c.caught;
  if (ok) { pass += 1; console.log(`  ✅ ${c.name}`); }
  else { fail += 1; console.error(`  ❌ ${c.name} — 期望${c.caught ? '被抓' : '不报'}，实际${caught ? '被抓' : '不报'}`); }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
