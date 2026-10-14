/** memory-store 测试。运行：node --test test/store.test.mjs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicize, dedupe, parseFrontmatter, renderMarkdown, createMemoryStore
} from '../src/store.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-')); }

test('atomicize：超长行按句末标点拆分', () => {
  const s = '第一件事发生了。第二件事也发生了！第三件呢？';
  assert.deepEqual(atomicize(s, { maxChars: 10 }), ['第一件事发生了。', '第二件事也发生了！', '第三件呢？']);
});

test('atomicize：无句末标点时按次级标点拆分并打包', () => {
  const s = '有人来测试：问「你是人吗」、要看语音、连甩梗图，还主动给我存了两张表情（表情A';
  const out = atomicize(s, { maxChars: 30 });
  assert.ok(out.length > 1, '应拆成多条');
  assert.ok(out.every((x) => x.length <= 40), '每条约在预算内（打包后允许略超单段）');
});

test('atomicize：已有列表行按行拆，并剥掉前缀', () => {
  const s = '- 玩射击游戏\n* 爱晒战绩\n1. 对角色X有敌意';
  assert.deepEqual(atomicize(s, { maxChars: 50 }), ['玩射击游戏', '爱晒战绩', '对角色X有敌意']);
});

test('atomicize：无法安全拆分时不截断，整条保留', () => {
  const s = '这一句没有任何标点所以不应该被拆开无论多长';
  assert.deepEqual(atomicize(s, { maxChars: 5 }), [s]);
});

test('atomicize：空输入与纯标点', () => {
  assert.deepEqual(atomicize(''), []);
  assert.deepEqual(atomicize(null), []);
  assert.deepEqual(atomicize('，。！'), []);
});

test('dedupe：去重且保序', () => {
  assert.deepEqual(dedupe(['a', 'b', 'a', 'c']), ['a', 'b', 'c']);
});

test('parseFrontmatter：标量与行内数组', () => {
  const md = '---\nid: x/y\ncategory: memberImpression\ntags: [群友, 三角洲]\n---\n\n# t\n\n- a\n';
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.id, 'x/y');
  assert.equal(data.category, 'memberImpression');
  assert.deepEqual(data.tags, ['群友', '三角洲']);
  assert.ok(body.includes('- a'));
});

test('parseFrontmatter：无 frontmatter 时原样返回', () => {
  const { data, body } = parseFrontmatter('就是正文');
  assert.deepEqual(data, {});
  assert.equal(body, '就是正文');
});

test('renderMarkdown：生成可解析的 md（往返一致）', () => {
  const md = renderMarkdown({ id: 'a/b', category: 'memberImpression', subject: '甲', atoms: ['x', 'y'], updated: '2026-01-01T00:00:00.000Z' });
  const { data, body } = parseFrontmatter(md);
  assert.equal(data.id, 'a/b');
  assert.equal(data.subject, '甲');
  assert.ok(body.includes('- x') && body.includes('- y'));
});

test('store.put：写入后可读回；调用方分好的原子保持独立', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  const r = st.put('group:123', { category: 'memberImpression', subject: '甲', atoms: ['他喜欢钓鱼。', '他还喜欢爬山。'] });
  assert.ok(fs.existsSync(r.file));
  const list = st.list('group:123');
  assert.equal(list.length, 1, '同一 subject 归并到一个文件');
  assert.deepEqual(list[0].atoms, ['他喜欢钓鱼。', '他还喜欢爬山。']);
});

test('store.put：单条超长字符串被自动原子化（不截断）', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  // 一次写入多条事实：调用方已分好的原子条目应各自独立保留，不被合并、不被截断
  const long = [
    '他上来先问「你是人吗」，然后连甩几张梗图，还主动给我存了两个表情（表情A / 表情B）。',
    '发图时叫过我「角色X」，是故意的。',
  ];
  st.put('group:123', { category: 'memberImpression', subject: '乙', atoms: long });
  const atoms = st.list('group:123')[0].atoms;
  assert.ok(atoms.length > 1, `应拆成多条，实际 ${atoms.length} 条`);
  assert.ok(atoms.every((a) => /[。！？；!?;]$/.test(a)), '每条都应是完整句子，不应在半句处切断');
  assert.ok(atoms.join('').includes('角色X'), '内容不应丢失');
});

test('store.put：重复导入幂等（不产生重复条目）', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  st.put('group:123', { category: 'memberImpression', subject: '甲', atoms: '他喜欢钓鱼。' });
  const r2 = st.put('group:123', { category: 'memberImpression', subject: '甲', atoms: '他喜欢钓鱼。' });
  assert.deepEqual(r2.added, [], '第二次不应新增');
  assert.equal(r2.total, 1);
});

test('store：目录名可读且安全（group→群，private→私聊）', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  assert.equal(st.dirFor('group:123'), '群-123');
  assert.equal(st.dirFor('private:456'), '私聊-456');
  assert.ok(!st.dirFor('weird/../key').includes('/'));
});

test('store.removeAtom：精确删除一条', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  st.put('group:123', { category: 'memberImpression', subject: '甲', atoms: ['第一条事实', '第二条事实'] });
  const r = st.removeAtom('group:123', '甲', '第一条事实');
  assert.equal(r.ok, true);
  assert.deepEqual(st.list('group:123')[0].atoms, ['第二条事实']);
});

test('store：坏文件不炸，被跳过', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  st.put('group:123', { category: 'activeTopic', subject: '正常', atoms: '好的。' });
  const dir = path.join(root, st.dirFor('group:123'));
  fs.writeFileSync(path.join(dir, 'BROKEN.md'), '不是 md 也不该炸');
  const list = st.list('group:123');
  assert.ok(list.length >= 1, '应至少读到正常那条');
});

test('store.rebuildIndex：生成 INDEX.md', () => {
  const root = tmpRoot();
  const st = createMemoryStore({ root, fs, path });
  st.put('group:123', { category: 'memberImpression', subject: '甲', atoms: 'a' });
  const idx = st.rebuildIndex();
  assert.ok(fs.existsSync(idx));
  assert.ok(fs.readFileSync(idx, 'utf8').includes('记忆索引'));
});
