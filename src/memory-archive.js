/**
 * memory-archive —— 归档与检索（记忆框架 第 3 环）
 *
 * 解决的核心问题：**上下文重置 = 失忆**。
 *   DSH 会话历史是只增不减的（实测群会话每次调用已达 476K token、日增 20~30K）。
 *   到了上下文上限就必须重置；而重置后模型对之前发生的事一无所知。
 *   本模块在重置**之前**把该会话的快照落成 markdown，重置**之后**能读回来，
 *   并支持**关键词检索**跨越任意多次重置去翻旧账。
 *
 * 文件布局（全部纯文本，Obsidian 可直接打开）：
 *   state/memory/<会话>/快照-2026-10-13T1030.md      ← 每次归档一份
 *   state/memory/<会话>/人物-某某.md                  ← 长期记忆（由 store.js 管）
 *   state/memory/INDEX.md                            ← 索引
 *
 * 与 store.js 的分工：
 *   store.js   —— 长期记忆（人物印象/进行中话题），原子事实，可增删改
 *   archive.js —— 时间切片快照（某段时间发生了什么），只追加，可检索
 *
 * 设计原则：
 *   1. 零依赖，文件即真相。
 *   2. 归档**不做 LLM 摘要**（那要多花一次调用且可能失真）：落原始对话的压缩形态，
 *      由需要它的那一方（模型）自己读。宁可存全，不存错。
 *   3. 检索是纯函数 + 文件读取分离：打分逻辑可单测。
 */

export const DEFAULT_ARCHIVE_LIMIT = 60;      // 单次快照最多带多少条消息
export const DEFAULT_SNIPPET_CHARS = 160;      // 检索结果每条的上下文片段长度

/**
 * 快照文件名（可读、可排序）。
 * 精确到**秒**：实测只到分钟时，同一分钟内连续两次归档会互相覆盖
 * （重置可能连续发生，快照丢了就真丢了）。
 */
export function snapshotName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = date;
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `快照-${ts}`;
}

/**
 * 归一发送者名。
 * 实测踩过的坑：网关事件里 sender 有时被塞进**系统事件文本**
 * （如「系统提示：某某加入了群聊。」），直接当人名会写出
 * 「系统提示：某某加入了群聊。：吔」这种脏数据，检索也会被噪声污染。
 * 这里做长度与关键词判断，可疑就换成中性名。
 */
function normalizeSender(m) {
  if (m?.isSelf) return '我';
  const raw = String(m?.sender ?? '').replace(/\s+/g, ' ').trim();
  const suspicious = !raw
    || raw.length > 16
    || /加入了群聊|撤回了一条|邀请|群公告|系统消息|开启了|禁言/.test(raw);
  if (!suspicious) return raw;
  const uid = String(m?.userId ?? '').trim();
  return uid ? `成员${uid}` : '某人';
}

/** 把一条消息压成一行，供快照与检索使用 */
function formatMessage(m) {
  if (!m || typeof m !== 'object') return '';
  const who = normalizeSender(m);
  const text = String(m.tail ?? m.plain ?? m.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const t = Number(m.time) || 0;
  const hhmm = t ? new Date(t).toTimeString().slice(0, 5) : '';
  return `${hhmm ? hhmm + ' ' : ''}${who}：${text}`;
}

/**
 * 生成一份快照的 markdown。
 * @param {{key:string, reason?:string, st:object, memoryBlock?:string, limit?:number, now?:Date}} args
 */
export function buildSnapshotMarkdown({ key, reason = 'manual', st, memoryBlock = '', limit = DEFAULT_ARCHIVE_LIMIT, now = new Date() }) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const unread = Array.isArray(st?.unread) ? st.unread : [];
  const all = [...recent, ...unread].filter((m) => m && !m.isSelf ? true : true);
  const picked = all.slice(-limit);
  const lines = [];

  lines.push('---');
  lines.push(`id: ${key}/${snapshotName(now)}`);
  lines.push('category: snapshot');
  lines.push(`session: ${key}`);
  lines.push(`reason: ${reason}`);
  lines.push(`messages: ${picked.length}`);
  lines.push(`archived: ${now.toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${snapshotName(now)}`);
  lines.push('');
  lines.push(`- 归档原因：${reason}`);
  lines.push(`- 消息条数：${picked.length}`);
  lines.push('');

  if (memoryBlock && String(memoryBlock).trim()) {
    lines.push('## 归档时的记忆', '');
    lines.push(String(memoryBlock).trim(), '');
  }

  lines.push('## 当时的对话', '');
  const msgs = picked.map(formatMessage).filter(Boolean);
  if (msgs.length) for (const l of msgs) lines.push(`- ${l}`);
  else lines.push('-（这段没有可归档的消息）');
  lines.push('');

  return { name: snapshotName(now), markdown: lines.join('\n') };
}

/**
 * 从归档文件里解析出可检索的结构。
 * 兼容：snapshot（快照）与 store 写的长期记忆文件。
 */
export function parseArchivedFile(text, filePath = '') {
  const s = String(text ?? '');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  const body = m ? s.slice(m[0].length) : s;
  // 收集所有「- xxx」条目作为可检索行
  const lines = body.split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
  return {
    path: filePath,
    category: fm.category || 'unknown',
    session: fm.session || '',
    id: fm.id || '',
    archived: fm.archived || '',
    reason: fm.reason || '',
    title: (/^#\s+(.+)$/m.exec(body) || [])[1] || '',
    lines
  };
}

/**
 * 关键词检索（纯函数：给定已解析的文档集合与查询，返回命中的行）。
 *
 * 打分：查询词元命中数 × 位置权重（标题/记忆区高于对话区）× 文档新旧。
 * 支持空格分隔的多关键词（全部命中才算，避免噪声）。
 *
 * @param {Array} docs  parseArchivedFile 的结果集合
 * @param {string} query
 * @param {{limit?:number, snippetChars?:number}} opts
 */
export function searchDocs(docs, query, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 20;
  const snippetChars = Number(opts.snippetChars) > 0 ? Number(opts.snippetChars) : DEFAULT_SNIPPET_CHARS;
  // 查询按空格切成多个词；中文没有空格也可以，此时整串当一个词
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const hits = [];
  for (const d of docs) {
    if (!d || !Array.isArray(d.lines)) continue;
    const meta = `${d.title} ${d.session} ${d.id}`.toLowerCase();
    for (const line of d.lines) {
      const low = line.toLowerCase();
      // 全部关键词都要命中（AND 语义，降噪）
      if (!terms.every((t) => low.includes(t) || meta.includes(t))) continue;
      let score = 0;
      for (const t of terms) {
        score += (low.split(t).length - 1);          // 出现次数
        if (meta.includes(t)) score += 1.5;          // 标题/会话命中加权
        if (/人物-|管理员|群主|印象/.test(line)) score += 0.5;
      }
      // 新文档略加权
      const at = d.archived ? Date.parse(d.archived) : 0;
      if (at > 0) {
        const days = Math.max(0, (Date.now() - at) / 86400000);
        score *= Math.pow(0.97, days);
      }
      hits.push({
        score: Number(score.toFixed(3)),
        path: d.path,
        category: d.category,
        session: d.session,
        archived: d.archived,
        text: line.length > snippetChars ? line.slice(0, snippetChars) + '…' : line
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // 同一文件最多留 3 条，避免一份快照刷屏
  const perFile = new Map();
  const out = [];
  for (const h of hits) {
    const n = perFile.get(h.path) || 0;
    if (n >= 3) continue;
    perFile.set(h.path, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 基于文件系统的归档库。
 * @param {{root:string, fs:object, path:object, dirFor:(key)=>string}} deps
 */
export function createArchiveStore({ root, fs, path, dirFor }) {
  if (!root || !fs || !path) throw new Error('createArchiveStore 需要 root/fs/path');
  if (typeof dirFor !== 'function') throw new Error('createArchiveStore 需要 dirFor(key)');

  function listFiles() {
    const out = [];
    const walk = (dir) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = path.join(dir, n);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (n.endsWith('.md') && n !== 'INDEX.md') out.push(p);
      }
    };
    walk(root);
    return out;
  }

  /** 读取全部归档文档（用于检索） */
  function loadAll(limitFiles = 500) {
    const docs = [];
    for (const f of listFiles().slice(0, limitFiles)) {
      try { docs.push(parseArchivedFile(fs.readFileSync(f, 'utf8'), f)); } catch { /* 跳过坏文件 */ }
    }
    return docs;
  }

  /** 落一份快照 */
  function writeSnapshot(key, { reason, st, memoryBlock, limit, now }) {
    const { name, markdown } = buildSnapshotMarkdown({ key, reason, st, memoryBlock, limit, now });
    const dir = path.join(root, dirFor(key));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf8');
    return { file, name, bytes: Buffer.byteLength(markdown, 'utf8') };
  }

  /** 列出某会话的快照文件（按名排序 = 按时间排序） */
  function listSnapshots(key) {
    const dir = path.join(root, dirFor(key));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => n.startsWith('快照-') && n.endsWith('.md')).sort().map((n) => path.join(dir, n));
  }

  /** 取最近 n 份快照的文本（供"恢复"用） */
  function recentSnapshots(key, n = 1) {
    const files = listSnapshots(key).slice(-n);
    const out = [];
    for (const f of files) {
      try { out.push({ file: f, text: fs.readFileSync(f, 'utf8') }); } catch { /* 跳过 */ }
    }
    return out;
  }

  /** 关键词检索全库 */
  function search(query, opts = {}) {
    return searchDocs(loadAll(opts.limitFiles), query, opts);
  }

  /** 把检索结果渲染成给模型看的文本 */
  function renderSearchResults(results) {
    if (!results.length) return '';
    const lines = ['【记忆检索结果】'];
    for (const r of results) {
      const when = r.archived ? r.archived.slice(0, 16).replace('T', ' ') : '';
      lines.push(`- ${when ? when + ' ' : ''}${r.text}`);
    }
    return lines.join('\n');
  }

  return { listFiles, loadAll, writeSnapshot, listSnapshots, recentSnapshots, search, renderSearchResults };
}
