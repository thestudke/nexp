/**
 * memory-retrieval —— QQ Agent 记忆检索层（第 2 步）
 *
 * 目标：把「每次唤醒把该会话全部记忆塞进提示词」改成「只注入当下相关的几条」。
 *
 * 为什么：实测群会话每次调用上下文已达 476K token、私聊 430K，日增 20~30K；
 * 而记忆（activeTopics / pendingThoughts / memberImpressions）是**无过滤全量注入**的。
 * 全量注入既贵又稀释注意力：不相关的记忆挤占上下文，还会让模型答非所问。
 *
 * 设计原则：
 *   1. **零依赖纯函数**：不读文件、不发网络、不碰全局状态。输入进、结果出，可单测、可移植。
 *   2. **接缝在格式化层**：桥接侧只需把「取全部」换成「先选后格式化」，不改记忆的写入/编辑路径。
 *   3. **降级安全**：任何异常都不允许让机器人失去记忆——调用方拿到的失败结果应退回全量。
 *   4. **可观测**：返回 dropped 与统计，便于量化「省了多少」。
 */

/**
 * 记忆类别权重：按「稳定性」排序。
 *   印象（人的长期事实）> 话题（进行中，可能重要）> 想法（短命且易变）。
 * 想法权重最低是有意的：它是临时草稿，不该挤掉关于人的长期判断。
 */
export const CATEGORY_WEIGHT = Object.freeze({
  memberImpression: 1.0,
  activeTopic: 0.85,
  pendingThought: 0.45
});

export const DEFAULT_OPTIONS = Object.freeze({
  maxItems: 6,              // 最多注入几条
  maxChars: 900,            // 字符预算（比条数更贴近真实成本）
  minScore: 0.05,           // 低于此分不注入
  recentMessageLimit: 12,   // 只用最近这么多条消息做语境
  recencyHalfLifeMs: 6 * 60 * 60 * 1000,        // 话题/印象：6 小时半衰
  pendingThoughtHalfLifeMs: 90 * 60 * 1000,      // 想法：90 分钟半衰（它本来就短命）
  nameHitBonus: 0.55,       // 记忆涉及的群友当前在说话
  keywordHitBonus: 0.22,    // 每个命中的关键词
  alwaysKeepImpressions: false // true = 印象类无条件保留（老行为）
});

/**
 * 把 QQ 消息文本切成可用于匹配的词元。
 * 中文按 2-gram + 单字，英文/数字按词；去掉常见停用词与标点。
 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '都', '也',
  '不', '没', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '哈', '把', '被', '给', '让', '对', '从', '到',
  '一个', '什么', '怎么', '这个', '那个', '可以', '但是', '然后', '因为', '所以', '如果', '还是'
]);

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();
  // 英文/数字串
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) {
    if (!STOPWORDS.has(m[0])) tokens.add(m[0]);
  }
  // 中文：单字 + 2-gram
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (!STOPWORDS.has(c)) tokens.add(c);
      if (i + 1 < chars.length) {
        const bigram = c + chars[i + 1];
        if (!STOPWORDS.has(bigram)) tokens.add(bigram);
      }
      // 3-gram：中文里真正承载语义的多是 2~3 字词（「三角洲」「红狼」「抽卡」），
      // 只到 2-gram 会导致「三角洲」匹配不上「洲开黑」这类滑动窗口。
      if (i + 2 < chars.length) {
        const tri = c + chars[i + 1] + chars[i + 2];
        if (!STOPWORDS.has(tri)) tokens.add(tri);
      }
    }
  }
  return tokens;
}

/**
 * 从会话状态里抽出「当前的语境信号」：谁在说话、在聊什么。
 * @param {object} st 桥接的 socialV2 会话状态（recentMessages / unread）
 * @param {object} opts
 */
export function buildContext(st, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const unread = Array.isArray(st?.unread) ? st.unread : [];
  // 未读优先（那是"当下"），再补最近历史
  const pool = [...recent.slice(-o.recentMessageLimit), ...unread];
  const speakers = new Set();
  const tokens = new Set();
  const textParts = [];
  for (const m of pool) {
    if (!m || typeof m !== 'object') continue;
    const sender = String(m.sender ?? '').trim();
    const tail = String(m.tail ?? '').trim();
    if (sender && !m.isSelf) speakers.add(sender);
    if (tail) {
      textParts.push(tail);
      for (const t of tokenize(tail)) tokens.add(t);
    }
  }
  return { speakers, tokens, text: textParts.join('\n') };
}

/**
 * 把桥接的三个记忆字段拍平成统一条目数组。
 * 兼容字段缺失/类型异常（老会话、手改过的 json）。
 */
export function flattenMemory(st) {
  // 外部可注入条目（例如 md 记忆库）：调用方把它挂到 st.__mdEntries 上。
  // 为空时回退到 JSON 的三字段，保证"记忆库被删/读失败"也不会让机器人失忆。
  // 这是框架的公开扩展点，而不是桥接侧的私有补丁 —— 换宿主也能用。
  const injected = Array.isArray(st?.__mdEntries) ? st.__mdEntries : null;
  if (injected && injected.length) {
    return injected.map((e, i) => ({
      id: e.id || `md:${i}`,
      category: e.category || 'memberImpression',
      text: String(e.text ?? ''),
      extra: String(e.extra ?? ''),
      names: Array.isArray(e.names) ? e.names : [],
      at: Number(e.at) || 0,
      raw: e
    })).filter((e) => e.text);
  }

  const out = [];
  const topics = Array.isArray(st?.activeTopics) ? st.activeTopics : [];
  topics.forEach((t, i) => {
    if (!t || typeof t !== 'object' || !t.text) return;
    out.push({
      id: `topic:${i}`,
      category: 'activeTopic',
      text: String(t.text),
      extra: t.pendingQuestion ? `待追问：${String(t.pendingQuestion)}` : '',
      names: Array.isArray(t.participants) ? t.participants.map(String) : [],
      at: Number(t.lastMentionAt) || 0,
      raw: t
    });
  });
  const thoughts = Array.isArray(st?.pendingThoughts) ? st.pendingThoughts : [];
  thoughts.forEach((t, i) => {
    if (!t || typeof t !== 'object' || !t.text) return;
    if (t.expiresAt && Date.now() > Number(t.expiresAt)) return; // 已过期不参与
    out.push({
      id: `thought:${i}`,
      category: 'pendingThought',
      text: String(t.text),
      extra: t.motivation ? `（${String(t.motivation)}）` : '',
      names: [],
      at: Number(t.createdAt) || 0,
      raw: t
    });
  });
  const impressions = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  for (const [name, im] of Object.entries(impressions)) {
    const traits = Array.isArray(im?.traits) ? im.traits.map(String) : [];
    out.push({
      id: `impression:${name}`,
      category: 'memberImpression',
      text: `${name}：${traits.length ? traits.join('、') : '暂无记录'}`,
      extra: `（互动 ${Number(im?.interactionCount) || 0} 次）`,
      names: [name],
      at: Number(im?.updatedAt) || 0,
      raw: im
    });
  }
  return out;
}

/**
 * 给单条记忆打分。
 * 信号：名字命中（谁在说话）× 关键词命中 × 类别权重 × 时效衰减。
 */
export function scoreEntry(entry, ctx, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const catW = CATEGORY_WEIGHT[entry.category] ?? 0.5;

  // 名字命中：记忆里提到的群友，此刻正在这个会话里说话
  let nameHits = 0;
  for (const n of entry.names) {
    if (!n) continue;
    if (ctx.speakers.has(n)) { nameHits++; continue; }
    // 昵称常带后缀（如「示例乙（小号）」），做前缀宽松匹配
    for (const s of ctx.speakers) {
      if (s && (s.includes(n) || n.includes(s))) { nameHits++; break; }
    }
  }
  const nameScore = nameHits > 0 ? o.nameHitBonus : 0;

  // 关键词命中：记忆文本与当下语境的词元重合
  const entryTokens = tokenize(`${entry.text} ${entry.extra}`);
  let kwHits = 0;
  for (const t of entryTokens) if (ctx.tokens.has(t)) kwHits++;
  const kwScore = Math.min(0.6, kwHits * o.keywordHitBonus);

  // 时效：越新越高（半衰）。想法类自带到期语义，用更短的半衰。
  const halfLife = entry.category === 'pendingThought'
    ? Math.min(o.pendingThoughtHalfLifeMs, o.recencyHalfLifeMs)
    : o.recencyHalfLifeMs;
  let recency = 1; // 没有时间戳（如印象）视为不衰减
  if (entry.at > 0) {
    const age = Math.max(0, Date.now() - entry.at);
    recency = Math.pow(0.5, age / halfLife);
  }

  // 相关度是乘法地板：**零相关的条目分数就是 0**，不会因为"没过期"而混进提示词。
  // 旧写法给 recency 加了 0.3 底数，导致无关记忆也拿 0.3，等于没过滤。
  const relevance = nameScore + kwScore;
  const score = relevance * catW * (0.25 + 0.75 * recency);
  return { score, nameHits, kwHits, recency, catW, relevance };
}

/**
 * 主入口：选出该注入的记忆。
 *
 * @param {object} st   桥接的 socialV2 会话状态
 * @param {object} opts { maxItems, maxChars, minScore, ... }
 * @returns {{kept:Array, dropped:Array, stats:object}}
 *   kept    —— 选中的条目（含 score 与命中原因，便于日志与调试）
 *   dropped —— 因预算/低分被丢弃的条目
 *   stats   —— 量化指标，用来验证「省了多少」
 */
export function selectMemory(st, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const entries = flattenMemory(st);
  const ctx = buildContext(st, o);
  const stats = {
    total: entries.length,
    kept: 0,
    dropped: 0,
    totalChars: 0,
    keptChars: 0,
    speakers: ctx.speakers.size,
    contextTokens: ctx.tokens.size
  };
  for (const e of entries) stats.totalChars += e.text.length + e.extra.length;

  if (!entries.length) return { kept: [], dropped: [], stats };

  const scored = entries.map((e) => {
    const s = scoreEntry(e, ctx, o);
    return { ...e, ...s };
  });

  const mustKeep = o.alwaysKeepImpressions
    ? scored.filter((e) => e.category === 'memberImpression')
    : [];

  const rest = scored
    .filter((e) => !mustKeep.includes(e))
    .sort((a, b) => b.score - a.score);

  const kept = [...mustKeep];
  let usedChars = kept.reduce((n, e) => n + e.text.length + e.extra.length, 0);

  for (const e of rest) {
    if (kept.length >= o.maxItems) break;
    const len = e.text.length + e.extra.length;
    if (e.score < o.minScore) continue;
    if (usedChars + len > o.maxChars) continue;
    kept.push(e);
    usedChars += len;
  }

  const keptIds = new Set(kept.map((e) => e.id));
  const dropped = scored.filter((e) => !keptIds.has(e.id));
  stats.kept = kept.length;
  stats.dropped = dropped.length;
  stats.keptChars = usedChars;
  stats.savedChars = stats.totalChars - stats.keptChars;
  stats.savedRatio = stats.totalChars > 0 ? stats.savedChars / stats.totalChars : 0;

  // 输出时按原格式顺序稳定排列：话题 → 想法 → 印象
  const order = { activeTopic: 0, pendingThought: 1, memberImpression: 2 };
  kept.sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9));

  return { kept, dropped, stats };
}

/**
 * 渲染成注入用的文本块。与桥接原有 formatMemoryV2 的分节格式保持一致，
 * 这样模型看到的结构不变，只是条目变少了。
 * @param {Array} kept selectMemory 的 kept
 */
export function renderMemory(kept) {
  if (!Array.isArray(kept) || !kept.length) return '';
  const lines = [];
  const topics = kept.filter((e) => e.category === 'activeTopic');
  const thoughts = kept.filter((e) => e.category === 'pendingThought');
  const impressions = kept.filter((e) => e.category === 'memberImpression');
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of topics) {
      const ago = t.at ? Math.round((Date.now() - t.at) / 60000) : 0;
      lines.push(`- ${t.text}${t.extra ? `；${t.extra}` : ''}（${ago > 0 ? ago + '分钟前' : '刚刚'}）`);
    }
  }
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts) lines.push(`- ${t.text}${t.extra}`);
  }
  if (impressions.length) {
    lines.push('【对群友的印象】');
    for (const t of impressions) lines.push(`- ${t.text}${t.extra}`);
  }
  return lines.join('\n');
}

// ── 原子化（store.js 的 atomicize 的内联等价副本）──────────────────────────
/**
 * 把长文本拆成「一件事一条」的原子事实。
 *
 * 为什么在这里内联一份而不是 import store.js：检索模块要保持**零依赖**（可单测、可移植）。
 * 代价是同名导出在 index.js 的 `export *` 汇总里会与 store.js 冲突并被静默丢弃 ——
 * 所以对外**改名为 `atomicizeInline`**，store.js 那版才是权威的 `atomicize`。
 *
 * 为什么必须有：桥接原来用 `text.slice(0, 50)` 存印象，模型一次 append 写来一整段时
 * 会被切成若干条各 50 字、**每条都在半句处断掉**（实测出现 `下午说是「在` 这种）。
 * 这里改成按标点拆，**绝不按字节截断**。
 *
 * @param {string} text
 * @param {{maxChars?:number}} opts
 * @returns {string[]}
 */
export function atomicizeInline(text, opts = {}) {
  const maxChars = Number(opts?.maxChars) > 0 ? Number(opts.maxChars) : 60;
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.length <= maxChars) { out.push(line); continue; }
    const sentences = /[。！？；!?;]/.test(line) ? splitKeepLocal(line, /[。！？；!?;]/) : [line];
    for (const s of sentences) {
      if (s.length <= maxChars) { out.push(s); continue; }
      const clauses = /[，,、]/.test(s) ? splitKeepLocal(s, /[，,、]/) : [s];
      if (clauses.length > 1) out.push(...packLocal(clauses, maxChars));
      else out.push(s);
    }
  }
  // 去重 + 丢掉纯标点
  const seen = new Set();
  return out.filter((s) => {
    const v = String(s ?? '').trim();
    if (!v || /^[\s\p{P}]+$/u.test(v) || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

/** 按分隔符切分，分隔符附着在前一段末尾（用 matchAll 明确区分正文与分隔符）。 */
function splitKeepLocal(text, sepRe) {
  const src = String(text ?? '');
  const g = new RegExp(sepRe.source, 'g');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(g)) {
    const before = src.slice(last, m.index);
    if (before) out.push(before);
    if (out.length) out[out.length - 1] += m[0]; else out.push(m[0]);
    last = m.index + m[0].length;
  }
  const tail = src.slice(last);
  if (tail) out.push(tail);
  return out.filter((s) => s && /\S/.test(s));
}

/** 把短分句打包到接近 maxChars，减少碎片。 */
function packLocal(clauses, maxChars) {
  const out = [];
  let buf = '';
  for (const c of clauses) {
    if (!buf) { buf = c; continue; }
    if ((buf + c).length <= maxChars) { buf += c; continue; }
    out.push(buf.trim());
    buf = c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 兼容别名：桥接侧的补丁按 `atomicize` 引入，这里保持可用。 */
export const atomicize = atomicizeInline;
