/**
 * memory-store —— 文件化记忆库（第 1 步）
 *
 * 目标：把记忆从 `state/social-v2.json` 里的一坨 JSON，换成**一条记忆一个 markdown 文件**，
 * 让人能打开看、能手改、能 git 管理，并且**支持 [[链接]] 交叉引用**。
 *
 * 为什么需要（实测根因）：
 *   旧实现把「模型一次 append 写来的一整段」直接 `text.slice(0, 50)` 存成一条 trait。
 *   结果：一条 500 字的印象被切成 6 条，**每条都在第 50 字被硬截断**，中英文混排时还会切出
 *   `下午说是「在` 这种断句。检索再准也没用 —— 粒度错了，信息本身就残缺。
 *   所以本模块的核心是 **atomicize()**：把长文本拆成"一件事一条"的原子事实，而不是切字节。
 *
 * 文件格式（Obsidian 风格，纯文本，无私有格式）：
 *   state/memory/群-123456/人物-示例甲.md
 *   ---
 *   id: 群-123456/人物-示例甲
 *   category: memberImpression
 *   subject: 示例甲
 *   tags: [群友, 三角洲]
 *   updated: 2026-10-13T10:30:00.000Z
 *   ---
 *   # 示例甲
 *
 *   - 玩射击游戏
 *   - 爱晒战绩
 *   - 对 [[角色X]] 有敌意，说过受不了这个
 *
 * 设计原则：
 *   1. **零依赖**：不引 yaml 库，frontmatter 用最小子集自己解析（只支持标量/行内数组）。
 *   2. **文件即真相**：JSON 状态可随时由文件重建；反过来不行。
 *   3. **原子化在写入侧**：写的时候就拆，不指望读的时候补救。
 *   4. **幂等**：同一份输入重复导入不产生重复条目。
 */

export const DEFAULT_MEMORY_ROOT = 'state/memory';

/** 一条记忆的正文单行上限（按「一件事一条」取 60）。超过就拆，而不是截断。 */
export const DEFAULT_ATOM_MAX_CHARS = 60;

/**
 * 把长文本拆成原子事实 —— **权威实现**（`retrieval.js` 里那份是等价的内联副本，
 * 为了让检索模块保持零依赖；两边行为由测试钉住一致）。
 *
 * 注意：`index.js` 用 `export *` 汇总，**同名导出会被静默丢弃**，
 * 所以 retrieval 侧那份以 `atomicizeInline` 的名字导出，避免入口不可见。
 *
 * 拆分优先级：
 *   1. 已存在的列表行（- / * / •）
 *   2. 句末标点（。！？；!?;）
 *   3. 换行
 *   4. 次级标点（，,、）—— 仅在单句仍然超长时使用
 * 绝不按字节切：宁可不拆，也不切出半句话。
 *
 * @param {string} text
 * @param {{maxChars?:number}} opts
 * @returns {string[]} 原子条目（已去空、去重、去列表前缀）
 */
export function atomicize(text, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEFAULT_ATOM_MAX_CHARS;
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];

  // ① 先按行拆，顺手剥掉列表前缀
  const lines = raw.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.length <= maxChars) { out.push(line); continue; }
    // ② 超长行：按句末标点切（保留标点）
    // 注意：判空必须用无状态的 String.includes，不能对带 g 标志的正则调 .test()
    // —— 全局正则的 .test() 会改 lastIndex，同一行两次调用结果会不一致（踩过）。
    const hasSentenceEnd = /[。！？；!?;]/.test(line);
    const sentences = hasSentenceEnd ? splitKeep(line, /[。！？；!?;]/) : [line];
    for (const s of sentences) {
      if (s.length <= maxChars) { out.push(s); continue; }
      // ③ 单句仍超长：按次级标点切
      const hasClauseSep = /[，,、]/.test(s);
      const clauses = hasClauseSep ? splitKeep(s, /[，,、]/) : [s];
      if (clauses.length > 1) {
        // 把短句合并到接近 maxChars，避免产出大量碎片
        out.push(...packClauses(clauses, maxChars));
      } else {
        out.push(s); // ④ 无法安全拆分：整条保留，**不截断**
      }
    }
  }
  return dedupe(out);
}

/**
 * 按分隔符切分，**保留分隔符附着在前一段末尾**。
 * 用 matchAll + 捕获组明确区分「正文段」与「分隔符段」——
 * 旧写法用 `sepRe.test(seg)` 判断，任何含标点的正文都会被误判成分隔符（实测把整段吞成一条）。
 */
function splitKeep(text, sepRe) {
  const src = String(text ?? '');
  const global = new RegExp(sepRe.source, sepRe.flags.includes('g') ? sepRe.flags : sepRe.flags + 'g');
  const out = [];
  let last = 0;
  for (const m of src.matchAll(global)) {
    const before = src.slice(last, m.index);
    if (before) out.push(before);
    const sep = m[0];
    if (out.length) out[out.length - 1] += sep;
    else out.push(sep);
    last = m.index + sep.length;
  }
  const tail = src.slice(last);
  if (tail) out.push(tail);
  return out.filter((s) => s && /\S/.test(s));
}

/** 把短分句合并到不超过 maxChars，减少碎片。 */
function packClauses(clauses, maxChars) {
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

/** 去重（保持首次出现顺序），并丢掉纯标点/空白。 */
export function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const s = String(it ?? '').trim();
    if (!s || /^[\s\p{P}]+$/u.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ── frontmatter：最小 YAML 子集（标量 + 行内数组）────────────────────────────

export function parseFrontmatter(text) {
  const s = String(text ?? '');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  if (!m) return { data: {}, body: s };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    } else {
      val = unquote(val);
    }
    data[key] = val;
  }
  return { data, body: s.slice(m[0].length) };
}

function unquote(v) {
  const s = String(v ?? '');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function needsQuote(v) {
  return /^[\s]|[\s]$|[:#\[\]{}",']/.test(String(v ?? '')) || String(v ?? '') === '';
}

function yamlVal(v) {
  if (Array.isArray(v)) return `[${v.map((x) => yamlVal(x)).join(', ')}]`;
  const s = String(v ?? '');
  return needsQuote(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** 由结构化条目渲染成一个 md 文件的内容。 */
export function renderMarkdown(entry) {
  const fm = {
    id: entry.id,
    category: entry.category,
    ...(entry.subject ? { subject: entry.subject } : {}),
    ...(entry.tags && entry.tags.length ? { tags: entry.tags } : {}),
    updated: entry.updated || new Date().toISOString()
  };
  const head = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${yamlVal(v)}`), '---'].join('\n');
  const title = entry.title || entry.subject || entry.id;
  const body = (entry.atoms || []).map((a) => `- ${a}`).join('\n');
  return `${head}\n\n# ${title}\n\n${body}\n`;
}

/**
 * 记忆库：一条记忆一个文件。
 * 文件系统由调用方注入（Node 的 fs 或内存实现），便于单测。
 *
 * @param {{root:string, fs:object, path:object}} deps
 */
export function createMemoryStore({ root, fs, path }) {
  if (!root) throw new Error('createMemoryStore 需要 root');
  if (!fs || !path) throw new Error('createMemoryStore 需要 fs 与 path');

  /** 会话 key → 目录名（文件名安全，可读） */
  function dirFor(key) {
    const k = String(key ?? '').trim();
    const m = /^(group|private):(\d+)$/.exec(k);
    if (m) return `${m[1] === 'group' ? '群' : '私聊'}-${m[2]}`;
    return '其它-' + k.replace(/[^\w\u4e00-\u9fff-]/g, '_');
  }
  function fileFor(key, name) {
    const safe = String(name ?? '').replace(/[\/\\:*?"<>|]/g, '_').trim();
    return path.join(root, dirFor(key), `${safe}.md`);
  }
  function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

  /** 读取单个文件 → 条目 */
  function readFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(text);
    const atoms = body.split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter((l) => l && !l.startsWith('#'));
    return { ...data, atoms, path: file };
  }

  /** 列出某会话（或全部）的条目 */
  function list(key) {
    const dirs = key ? [path.join(root, dirFor(key))] : listDirs();
    const out = [];
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.md') || n === 'INDEX.md') continue;
        try { out.push(readFile(path.join(d, n))); } catch { /* 跳过坏文件 */ }
      }
    }
    return out;
  }
  function listDirs() {
    try {
      return fs.readdirSync(root).map((n) => path.join(root, n))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    } catch { return []; }
  }

  /**
   * 写入记忆。长内容自动原子化，**不做截断**。
   * @returns {{file:string, added:string[], total:number}}
   */
  function put(key, { category, subject, atoms, tags, title, updated }) {
    if (!category) throw new Error('put 需要 category');
    // 调用方**已经分好的原子条目不再重新合并**：逐条原子化后拼接。
    // （旧写法 join('\n') 再原子化，短条目会被 packClauses 合并回去，等于抹掉调用方的切分意图。）
    const flat = dedupe(
      (Array.isArray(atoms) ? atoms : [atoms])
        .flatMap((a) => atomicize(a))
    );
    // 按主体归并到一个文件：同一 subject 的多条事实放同一个 md，天然形成「一条记忆一个文件」
    const name = title || subject || `未命名-${category}`;
    const file = fileFor(key, name);
    ensureDir(path.dirname(file));

    let existing = { atoms: [] };
    if (fs.existsSync(file)) {
      try { existing = readFile(file); } catch { existing = { atoms: [] }; }
    }
    const merged = dedupe([...(existing.atoms || []), ...flat]);
    const content = renderMarkdown({
      id: `${dirFor(key)}/${name}`,
      category, subject, tags, title, updated,
      atoms: merged
    });
    fs.writeFileSync(file, content, 'utf8');
    const added = merged.filter((a) => !(existing.atoms || []).includes(a));
    return { file, added, total: merged.length };
  }

  /** 删除某条原子事实（精确匹配） */
  function removeAtom(key, name, atom) {
    const file = fileFor(key, name);
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    const e = readFile(file);
    const next = (e.atoms || []).filter((a) => a !== atom);
    if (next.length === e.atoms.length) return { ok: false, error: '找不到该条目' };
    fs.writeFileSync(file, renderMarkdown({ ...e, atoms: next }), 'utf8');
    return { ok: true, removed: atom, left: next.length };
  }

  /** 重建 INDEX.md（人看的目录） */
  function rebuildIndex() {
    const lines = ['---', 'id: INDEX', 'category: index', `updated: ${new Date().toISOString()}`, '---', '', '# 记忆索引', ''];
    for (const d of listDirs()) {
      const name = path.basename(d);
      lines.push(`## ${name}`, '');
      for (const e of list(name === d ? undefined : undefined).filter((x) => x.path.startsWith(d))) {
        lines.push(`- [[${e.id || path.basename(e.path, '.md')}]]（${e.category || '?'}，${(e.atoms || []).length} 条）`);
      }
      lines.push('');
    }
    ensureDir(root);
    fs.writeFileSync(path.join(root, 'INDEX.md'), lines.join('\n'), 'utf8');
    return path.join(root, 'INDEX.md');
  }

  return { dirFor, fileFor, list, readFile, put, removeAtom, rebuildIndex };
}

// ── 与记忆检索层的适配器 ─────────────────────────────────────────────────────
/**
 * 把 markdown 记忆库读成「检索层能直接用的条目数组」。
 *
 * 为什么不直接在 retrieval.js 里读文件：那个模块是**零依赖纯函数**，可单测、可移植。
 * 文件读取放在这里（本来就依赖 fs），保持关注点分离。
 *
 * @param {{store:object, key:string, categoryFor:(e)=>string}} args
 * @returns {Array<{id,category,text,extra,names,at}>}
 */
export function loadEntriesForRetrieval({ store, key, maxFiles = 200 }) {
  if (!store || !key) return [];
  const out = [];
  let entries = [];
  try { entries = store.list(key); } catch { return []; }
  for (const e of entries.slice(0, maxFiles)) {
    const category = e.category || 'memberImpression';
    const subject = e.subject || e.title || '';
    const title = e.title || subject;
    // 一条事实一个「条目」，这样检索层可以精确挑选，而不是整块留/整块丢
    for (const [i, atom] of (e.atoms || []).entries()) {
      out.push({
        id: `${e.id || title}:${i}`,
        category,
        text: subject && !atom.startsWith(subject) ? `${subject}：${atom}` : atom,
        extra: '',
        names: subject ? [subject] : [],
        at: e.updated ? Date.parse(e.updated) || 0 : 0
      });
    }
  }
  return out;
}
