/** memory-archive 测试。运行：node --test test/archive.test.mjs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  snapshotName, buildSnapshotMarkdown, parseArchivedFile, searchDocs, createArchiveStore
} from '../src/archive.js';

const NOW = new Date('2026-10-13T10:30:00Z');

function mkState(over = {}) {
  return {
    recentMessages: [
      { sender: '示例甲', tail: '今晚打排位来不来', time: Date.parse('2026-10-13T10:00:00Z') },
      { sender: '小美', tail: '我在写作业', time: Date.parse('2026-10-13T10:01:00Z') },
      { isSelf: true, tail: '那我自己去', time: Date.parse('2026-10-13T10:02:00Z') }
    ],
    unread: [],
    ...over
  };
}

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memarch-')); }
function mkStore(root) {
  return createArchiveStore({ root, fs, path, dirFor: (k) => k.replace(':', '-') });
}

test('snapshotName：可读且按时间可排序', () => {
  // 用**本地时间**是有意的：归档文件是给人看的，应与群友看到的时间一致。
  // 所以断言也按本地时间构造，不写死 UTC（服务器时区不同会挂）。
  const d = new Date('2026-10-13T10:30:00Z');
  const p = (n) => String(n).padStart(2, '0');
  const expect = `快照-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  assert.equal(snapshotName(d), expect);
  const a = snapshotName(new Date('2026-10-13T09:00:00Z'));
  const b = snapshotName(new Date('2026-10-13T10:00:00Z'));
  assert.ok(a < b, '字符串排序应等于时间排序');
});

test('buildSnapshotMarkdown：含 frontmatter、记忆区、对话区', () => {
  const { name, markdown } = buildSnapshotMarkdown({
    key: 'group:123456', reason: 'context-reset', st: mkState(),
    memoryBlock: '【对群友的印象】\n- 示例甲：爱打排位', now: NOW
  });
  assert.ok(name.startsWith('快照-'));
  assert.ok(markdown.startsWith('---\n'));
  assert.ok(markdown.includes('category: snapshot'));
  assert.ok(markdown.includes('reason: context-reset'));
  assert.ok(markdown.includes('## 归档时的记忆'));
  assert.ok(markdown.includes('## 当时的对话'));
  assert.ok(markdown.includes('示例甲：今晚打排位来不来'));
  assert.ok(markdown.includes('我：那我自己去'), '自己发的消息应标注为「我」');
});

test('buildSnapshotMarkdown：消息带上时间且限制条数', () => {
  const many = { recentMessages: Array.from({ length: 200 }, (_, i) => ({ sender: '甲', tail: 'm' + i, time: Date.now() })) };
  const { markdown } = buildSnapshotMarkdown({ key: 'g:1', st: many, limit: 10, now: NOW });
  const bullets = markdown.split('\n').filter((l) => l.startsWith('- ') && l.includes('甲：'));
  assert.equal(bullets.length, 10, '应只保留最近 10 条');
  assert.ok(bullets[bullets.length - 1].includes('m199'), '应保留最新的');
});

test('buildSnapshotMarkdown：空会话不炸', () => {
  const { markdown } = buildSnapshotMarkdown({ key: 'g:1', st: {}, now: NOW });
  assert.ok(markdown.includes('（这段没有可归档的消息）'));
});

test('parseArchivedFile：解析 frontmatter 与列表行', () => {
  const { markdown } = buildSnapshotMarkdown({
    key: 'group:123456', reason: 'manual', st: mkState(),
    memoryBlock: '【对群友的印象】\n- 示例甲：爱打排位', now: NOW
  });
  const d = parseArchivedFile(markdown, '/x/y.md');
  assert.equal(d.category, 'snapshot');
  assert.equal(d.session, 'group:123456');
  assert.equal(d.reason, 'manual');
  assert.ok(d.lines.some((l) => l.includes('示例甲：爱打排位')));
  assert.ok(d.lines.some((l) => l.includes('小美：我在写作业')));
});

test('parseArchivedFile：无 frontmatter 的文件也能读', () => {
  const d = parseArchivedFile('# 标题\n\n- 一条事实', '/x.md');
  assert.equal(d.category, 'unknown');
  assert.deepEqual(d.lines, ['一条事实']);
});

test('searchDocs：多关键词是 AND 语义', () => {
  const docs = [
    parseArchivedFile('- 示例甲 喜欢打排位', '/a.md'),
    parseArchivedFile('- 小美 喜欢写作业', '/b.md')
  ];
  assert.equal(searchDocs(docs, '排位').length, 1);
  assert.equal(searchDocs(docs, '示例甲 排位').length, 1, '两词都命中才算');
  assert.equal(searchDocs(docs, '示例甲 作业').length, 0, 'AND 语义下应无结果');
});

test('searchDocs：大小写不敏感，空查询返回空', () => {
  const docs = [parseArchivedFile('- KFC 好吃', '/a.md')];
  assert.equal(searchDocs(docs, 'kfc').length, 1);
  assert.deepEqual(searchDocs(docs, ''), []);
  assert.deepEqual(searchDocs(docs, '   '), []);
});

test('searchDocs：同一文件最多留 3 条（防刷屏）', () => {
  const body = Array.from({ length: 10 }, () => '- 关键词 命中').join('\n');
  const docs = [parseArchivedFile(body, '/a.md')];
  const hits = searchDocs(docs, '关键词', { limit: 20 });
  assert.equal(hits.length, 3, '同一文件最多 3 条');
});

test('searchDocs：标题/会话命中加权，排序更靠前', () => {
  const docs = [
    parseArchivedFile('---\nsession: group:999\n---\n\n# 排位赛\n\n- 无关内容', '/t.md'),
    parseArchivedFile('- 这里提到一次排位', '/n.md')
  ];
  const hits = searchDocs(docs, '排位');
  assert.equal(hits[0].path, '/t.md', '标题命中应排前');
});

test('archiveStore：落快照、列快照、取最近', () => {
  const root = tmpRoot();
  const s = mkStore(root);
  const r1 = s.writeSnapshot('group:123456', { reason: 'a', st: mkState(), now: new Date('2026-10-13T10:00:00Z') });
  s.writeSnapshot('group:123456', { reason: 'b', st: mkState(), now: new Date('2026-10-13T11:00:00Z') });
  assert.ok(fs.existsSync(r1.file));
  assert.equal(s.listSnapshots('group:123456').length, 2);
  const recent = s.recentSnapshots('group:123456', 1);
  assert.equal(recent.length, 1);
  assert.ok(recent[0].text.includes('reason: b'), '取到的应是最近一份');
});

test('archiveStore：跨会话隔离', () => {
  const root = tmpRoot();
  const s = mkStore(root);
  s.writeSnapshot('group:111', { reason: 'a', st: mkState(), now: NOW });
  s.writeSnapshot('private:222', { reason: 'a', st: mkState(), now: NOW });
  assert.equal(s.listSnapshots('group:111').length, 1);
  assert.equal(s.listSnapshots('private:222').length, 1);
});

test('archiveStore.search：能搜到快照里的对话与记忆', () => {
  const root = tmpRoot();
  const s = mkStore(root);
  s.writeSnapshot('group:123456', {
    reason: 'context-reset', st: mkState(),
    memoryBlock: '【对群友的印象】\n- 示例甲：只在深夜出没', now: NOW
  });
  const byChat = s.search('写作业');
  assert.equal(byChat.length, 1);
  const byMemory = s.search('深夜出没');
  assert.equal(byMemory.length, 1, '记忆区也应可检索');
  const none = s.search('不存在的词xyz');
  assert.equal(none.length, 0);
});

test('archiveStore.search：空库返回空而不是报错', () => {
  const root = tmpRoot();
  const s = mkStore(root);
  assert.deepEqual(s.search('任意'), []);
});

test('renderSearchResults：渲染成给模型的文本，空结果返回空串', () => {
  const root = tmpRoot();
  const s = mkStore(root);
  s.writeSnapshot('group:123456', { reason: 'a', st: mkState(), now: NOW });
  const text = s.renderSearchResults(s.search('排位'));
  assert.ok(text.startsWith('【记忆检索结果】'));
  assert.equal(s.renderSearchResults([]), '');
});

test('formatMessage：可疑的"发送者名"被归一（系统事件文本不当作人名）', () => {
  const st = { recentMessages: [
    { sender: '系统提示：某某加入了群聊。', userId: '10086', tail: '吔', time: Date.now() },
    { sender: '示例甲', tail: '正常消息', time: Date.now() }
  ] };
  const { markdown } = buildSnapshotMarkdown({ key: 'g:1', st, now: NOW });
  assert.ok(!markdown.includes('加入了群聊。：吔'), '不应把系统事件当人名');
  assert.ok(markdown.includes('成员10086：吔'), '应退化成中性名+ID');
  assert.ok(markdown.includes('示例甲：正常消息'), '正常名应保留');
});

test('快照标题不重复', () => {
  const { markdown } = buildSnapshotMarkdown({ key: 'g:1', st: mkState(), now: NOW });
  assert.ok(!/# 快照 快照/.test(markdown), '不应出现「# 快照 快照-…」');
  assert.ok(/^# 快照-\d{4}-/m.test(markdown));
});

test('快照文件名精确到秒：同一分钟内两次归档不覆盖', () => {
  const t0 = new Date('2026-10-13T10:30:00Z');
  const t1 = new Date('2026-10-13T10:30:45Z');
  assert.notEqual(snapshotName(t0), snapshotName(t1), '相差 45 秒应有不同文件名');
});
