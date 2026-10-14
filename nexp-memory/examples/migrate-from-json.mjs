/**
 * 迁移示例：把宿主 JSON 里的旧记忆搬进文件化记忆库。
 *
 * 这里演示的是**受控重建**而不是全自动搬运 —— 原因：
 *   旧记忆往往是模型分多次写入、可能被宿主截断过的碎片，同一个人分散在多条记录里且互相重叠。
 *   全自动归并会产出一堆荒谬的主体名（我在真实数据上得到过「人物-管理员半夜来测试.md」），
 *   也无法判断哪条事实已经过时。把整理好的事实写成**显式表**，迁移过程才可审阅、可复现。
 *
 * 用法：
 *   node examples/migrate-from-json.mjs --dry-run     # 只看结果
 *   node examples/migrate-from-json.mjs --root DIR    # 实际写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createMemoryStore } from '../src/store.js';

const { values } = parseArgs({
  options: { root: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } }
});

const root = path.resolve(values.root || './memories');
const dry = !!values['dry-run'];

// ── 迁移表：把旧数据里识别出的事实整理成「一条事实一条」──────────────────────
// 每项：会话 key / 类别 / 主体 / 标签 / 事实数组
const MIGRATION = [
  {
    key: 'private:10001',
    category: 'memberImpression',
    subject: '管理员',
    title: '人物-管理员',
    tags: ['管理员'],
    facts: [
      '他习惯半夜冒泡试我，常先 @ 我、再只发一个「干」字',
      '他玩射击游戏，晒过武器皮肤和抽卡截图',
      '他嫌我消息里逗号太多，明确说过「少用」——之后发消息要少加逗号',
      // 过时事实要被替换而不是照搬：
      // 旧记忆写的是「没有可用的语音工具，只能老实说发不了」，
      // 但该能力已在 2026-10-13 修好 —— 留着会让机器人一直说"发不了"。
      '他多次点名要语音；语音发送已于 2026-10-13 修好，现在可以直接发库里的音频'
    ]
  },
  {
    key: 'group:123456',
    category: 'memberImpression',
    subject: '示例甲',
    title: '人物-示例甲',
    tags: ['群友', '射击游戏'],
    facts: [
      '示例甲玩撤离类射击（跑刀／红狼／鼠鼠），爱晒战绩',
      '他对我有敌意，说过受不了这个 AI —— 别主动去接他的话'
    ]
  },
  {
    key: 'group:123456',
    category: 'activeTopic',
    subject: '追比赛',
    title: '话题-追比赛',
    tags: ['比赛'],
    facts: [
      '他们在追 CN 队的比赛，赢了吹输了骂',
      '有人说过某件事，结果没做成 —— 这个梗可以拿来调侃'
    ]
  }
];

function memFs() {
  const files = new Map();
  return {
    _files: files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    writeFileSync: (p, c) => { files.set(p, c); },
    mkdirSync: () => {},
    readdirSync: (d) => [...new Set([...files.keys()]
      .filter((k) => k.startsWith(d + path.sep))
      .map((k) => k.slice(d.length + 1).split(path.sep)[0]))],
    statSync: () => ({ isDirectory: () => true })
  };
}

const fsImpl = dry ? memFs() : fs;
const store = createMemoryStore({ root, fs: fsImpl, path });

console.log(dry ? '【干跑，不落盘】' : '【实际写入】', root, '\n');
let n = 0, atoms = 0;
for (const m of MIGRATION) {
  const r = store.put(m.key, { category: m.category, subject: m.subject, title: m.title, tags: m.tags, atoms: m.facts });
  n++; atoms += r.total;
  console.log(`  ${m.key} → ${path.relative(root, r.file)}（${r.total} 条）`);
}
if (!dry) console.log('\n索引已重建:', store.rebuildIndex());
else {
  console.log('\n（干跑）会生成:');
  for (const f of [...fsImpl._files.keys()].sort()) console.log('   ', path.relative(root, f));
}
console.log(`\n合计 ${n} 个文件、${atoms} 条原子事实`);
