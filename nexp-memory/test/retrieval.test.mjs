/**
 * memory-retrieval 测试套件。
 * 目标：钉住行为，并量化「相对全量注入省了多少」。
 * 运行：node test/retrieval.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tokenize, buildContext, flattenMemory, scoreEntry, selectMemory, renderMemory,
  DEFAULT_OPTIONS
} from '../src/retrieval.js';

const NOW = Date.now();

function mkState(over = {}) {
  return {
    activeTopics: [
      { text: '今晚一起打排位', lastMentionAt: NOW - 5 * 60 * 1000, participants: ['示例甲'] },
      { text: '讨论新番剧情', lastMentionAt: NOW - 40 * 60 * 1000, participants: ['小美'] },
      { text: '抽卡晒卡', lastMentionAt: NOW - 3 * 60 * 60 * 1000, participants: [] },
      { text: '很早以前的话题', lastMentionAt: NOW - 30 * 60 * 60 * 1000, participants: [] }
    ],
    pendingThoughts: [
      { text: '想吐槽他手速', motivation: '刚被嘲', createdAt: NOW - 60 * 1000, expiresAt: NOW + 3600 * 1000 },
      { text: '过期的想法', motivation: 'x', createdAt: NOW - 5 * 3600 * 1000, expiresAt: NOW - 1000 }
    ],
    memberImpressions: {
      '示例甲': { traits: ['玩射击游戏', '爱晒战绩'], interactionCount: 3, updatedAt: NOW - 3600 * 1000 },
      '小美': { traits: ['一起打排位'], interactionCount: 1, updatedAt: NOW - 7200 * 1000 },
      '示例丙': { traits: ['偶尔冒泡'], interactionCount: 1, updatedAt: NOW - 86400 * 1000 }
    },
    recentMessages: [
      { sender: '群友X', tail: '今天天气不错' },
      { sender: '示例甲', tail: '排位来不来，上分' },
      { sender: '示例甲', tail: '我刚上了王者' }
    ],
    unread: [],
    ...over
  };
}

test('tokenize：中文出 2-gram 与单字，英文出词，去掉停用词', () => {
  const t = tokenize('三角洲 delta force 的');
  assert.ok(t.has('三角洲'));
  assert.ok(t.has('三角'));
  assert.ok(t.has('delta'));
  assert.ok(t.has('force'));
  assert.ok(!t.has('的'), '停用词应被去掉');
});

test('buildContext：收集在说话的人与语境词元，排除自己', () => {
  const ctx = buildContext(mkState());
  assert.ok(ctx.speakers.has('示例甲'));
  assert.ok(ctx.speakers.has('群友X'));
  assert.ok(!ctx.speakers.has('我'), 'isSelf 的消息不应算作说话人');
  assert.ok(ctx.tokens.has('排位'));
});

test('flattenMemory：拍平三个字段，过期的想法被剔除', () => {
  const e = flattenMemory(mkState());
  assert.equal(e.length, 4 + 1 + 3, '4 话题 + 1 有效想法 + 3 印象（过期想法剔除）');
  assert.ok(e.some((x) => x.category === 'activeTopic'));
  assert.ok(e.some((x) => x.category === 'pendingThought'));
  assert.ok(e.some((x) => x.category === 'memberImpression'));
  assert.ok(!e.some((x) => x.text === '过期的想法'));
});

test('flattenMemory：字段缺失/类型异常时不炸', () => {
  assert.deepEqual(flattenMemory(null), []);
  assert.deepEqual(flattenMemory({}), []);
  assert.deepEqual(flattenMemory({ activeTopics: 'nope', memberImpressions: 42 }), []);
});

test('scoreEntry：当下说话的人相关的记忆得分更高', () => {
  const st = mkState();
  const ctx = buildContext(st);
  const entries = flattenMemory(st);
  const aboutSpeaker = entries.find((e) => e.id === 'impression:示例甲');
  const aboutStranger = entries.find((e) => e.id === 'impression:示例丙');
  const a = scoreEntry(aboutSpeaker, ctx);
  const b = scoreEntry(aboutStranger, ctx);
  assert.ok(a.score > b.score, `示例甲(${a.score.toFixed(3)}) 应高于 示例丙(${b.score.toFixed(3)})`);
  assert.ok(a.nameHits > 0, '应命中名字信号');
});

test('scoreEntry：类别权重 印象 > 话题 > 想法（同相关度时）', () => {
  const ctx = buildContext({ recentMessages: [] });
  // 无关条目下相关度为 0，分数会全为 0 —— 这里给一点关键词命中，让权重成为唯一变量。
  ctx.tokens.add('一样');
  ctx.tokens.add('一样的话');
  const common = { text: '一样的话', extra: '', names: [], at: NOW };
  const imp = scoreEntry({ ...common, category: 'memberImpression' }, ctx);
  const top = scoreEntry({ ...common, category: 'activeTopic' }, ctx);
  const thg = scoreEntry({ ...common, category: 'pendingThought' }, ctx);
  assert.ok(imp.score > 0, '应有关键词命中');
  assert.ok(imp.score > top.score, `印象 ${imp.score.toFixed(3)} > 话题 ${top.score.toFixed(3)}`);
  assert.ok(top.score > thg.score, `话题 ${top.score.toFixed(3)} > 想法 ${thg.score.toFixed(3)}`);
});

test('scoreEntry：与语境零相关的记忆分数为 0（不被"没过期"救回）', () => {
  const ctx = buildContext({ recentMessages: [{ sender: '甲', tail: '完全无关的内容' }] });
  const e = { id: 'x', category: 'memberImpression', text: '乙：喜欢钓鱼', extra: '', names: ['乙'], at: NOW };
  const s = scoreEntry(e, ctx);
  assert.equal(s.score, 0, '无关记忆必须是 0 分，否则等于没过滤');
});

test('selectMemory：只留下相关条目，并给出省了多少', () => {
  const st = mkState();
  const { kept, dropped, stats } = selectMemory(st);
  assert.ok(kept.length > 0, '不应为空');
  assert.ok(kept.length <= DEFAULT_OPTIONS.maxItems, `不超过 ${DEFAULT_OPTIONS.maxItems} 条`);
  assert.equal(kept.length + dropped.length, stats.total, 'kept+dropped 应等于总数');
  assert.ok(stats.savedChars > 0, '应省下字符');
  const keptText = kept.map((e) => e.text).join('|');
  assert.ok(keptText.includes('示例甲'), '当下说话的人应被保留');
  assert.ok(!keptText.includes('很早以前的话题'), '30 小时前的无关话题应被丢弃');
});

test('selectMemory：maxChars 生效（严格字符预算）', () => {
  const st = mkState();
  const { kept, stats } = selectMemory(st, { maxChars: 40, maxItems: 99 });
  const used = kept.reduce((n, e) => n + e.text.length + e.extra.length, 0);
  assert.ok(used <= 40, `实际用 ${used} 字符，应 <= 40`);
  assert.ok(stats.keptChars <= 40);
});

test('selectMemory：maxItems 生效', () => {
  const st = mkState();
  const { kept } = selectMemory(st, { maxItems: 2 });
  assert.ok(kept.length <= 2);
});

test('selectMemory：空闲会话（无 recentMessages）不崩，仍能给出结果', () => {
  const st = mkState({ recentMessages: [], unread: [] });
  const { kept } = selectMemory(st);
  assert.ok(Array.isArray(kept));
});

test('selectMemory：空会话返回空且 stats 归零', () => {
  const { kept, dropped, stats } = selectMemory({});
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped, []);
  assert.equal(stats.total, 0);
  assert.equal(stats.savedChars ?? 0, 0);
});

test('alwaysKeepImpressions=true 时印象无条件保留（兼容老行为）', () => {
  const st = mkState({ recentMessages: [] });
  const { kept } = selectMemory(st, { alwaysKeepImpressions: true, maxItems: 1 });
  const imps = kept.filter((e) => e.category === 'memberImpression');
  assert.equal(imps.length, 3, '三条印象都应保留，不受 maxItems 限制');
});

test('renderMemory：分节格式与桥接原格式一致', () => {
  const st = mkState();
  const { kept } = selectMemory(st);
  const text = renderMemory(kept);
  assert.ok(text.includes('【对群友的印象】') || text.includes('【进行中的话题】'));
  assert.ok(!text.includes('undefined'));
  assert.equal(renderMemory([]), '');
});

test('renderMemory：不产生空节标题', () => {
  const text = renderMemory([{ category: 'memberImpression', text: '甲：安静', extra: '', at: 0 }]);
  assert.ok(text.startsWith('【对群友的印象】'));
  assert.ok(!text.includes('【进行中的话题】'));
  assert.ok(!text.includes('【你想说但还没说的】'));
});

test('flattenMemory：st.__mdEntries 优先于 JSON 三字段（md 记忆库扩展点）', () => {
  const st = {
    activeTopics: [{ text: 'JSON 里的旧话题', lastMentionAt: Date.now() }],
    memberImpressions: { 'JSON里的人': { traits: ['旧'], interactionCount: 1 } },
    __mdEntries: [
      { id: 'a:0', category: 'memberImpression', text: '甲：来自 md 的事实一', names: ['甲'], at: Date.now() },
      { id: 'a:1', category: 'memberImpression', text: '甲：来自 md 的事实二', names: ['甲'], at: Date.now() }
    ]
  };
  const flat = flattenMemory(st);
  assert.equal(flat.length, 2, '应只用注入的条目');
  assert.ok(flat.every((e) => e.text.includes('来自 md')), '不应混入 JSON 旧条目');
});

test('flattenMemory：__mdEntries 为空/缺失时回退 JSON（防失忆）', () => {
  const st = { memberImpressions: { '甲': { traits: ['x'], interactionCount: 1 } }, __mdEntries: [] };
  const flat = flattenMemory(st);
  assert.equal(flat.length, 1);
  assert.ok(flat[0].text.includes('甲'));
});
