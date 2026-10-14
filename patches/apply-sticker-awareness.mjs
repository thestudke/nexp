/**
 * 本地补丁：让 AI 真正「认识」群友发来的表情包（nexp v0.1.7）。
 *
 * 背景（2026-09-28，用户反馈「我发表情包他不认识」）：
 *   排查发现三层缺陷，全部在**运行时注入**这一层，不在角色卡里：
 *
 *   ① 【根因】extractMediaFromSegments() 只取 image/face 段的 file/url/subType/summary，
 *      把 QQ 表情自带的 emoji_id / md5 全丢了；而且完全不认 mface 段。
 *      → 桥接本地有 38 条「QQ 收藏表情」库（每条都带 AI 自己写的中文备注，如
 *        「糊脸仓鼠怼脸特写，适合无语/盯人/发呆」），但**没有任何字段能把发来的表情对上库**。
 *      实测：state/social-v2.json 里 31 条 media 记录，命中表情库 0 条。
 *      → 后果：AI 只看到一个泛泛的 [图片]，要么看不见、要么退回「看图说话」的默认行为，
 *        而不是「这是一张无语脸」。
 *
 *   ② mediaHintFor() 的注入文本是**中性**的：「如需要查看/识别，请调用 qq_get_message_images」。
 *      「如需要」对模型等于「不必」。而且它不区分三种情况：
 *        明确问图 / 只发图不配字 / 图配了话。
 *      对方只丢一张表情不说话时，提示词等于空转，模型就退回描述画面。
 *
 *   ③ 取图失败只写日志，模型看到的仍是「本条消息包含 N 个图片/表情」，
 *      于是照着这个暗示编画面。取不到必须显式告诉模型「你看不到它」。
 *
 * 修法（只改运行时注入与元数据提取，不改角色卡、不改发送通道）：
 *   1. extractMediaFromSegments 额外保留 emojiId / md5，并支持 mface 段。
 *   2. mediaHintFor 分支：识别出表情库备注就直接写进提示词（不用先取图）；
 *      取图失败时明确说「你现在看不到它」；说明文本用「以下」包裹，防模型回声。
 *   3. 三处上下文/快照渲染统一走 messageLineWithMediaHint：只用图片或表情、
 *      没有任何文字时，明确告诉模型「这张图就是他要说的话本身」。
 *
 * 幂等：已打过标记就跳过。nexp 升级（git pull）后重跑本脚本即可。
 * 部署位置：服务器上的工作目录（本地留档在 server-deploy/）
 * 用法：node apply-sticker-awareness.mjs [--app-dir DIR] [--quiet]
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

const MARKER = '@@LOCAL-PATCH:sticker-awareness';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const bridgePath = path.join(appDir, 'src', 'bridge.js');

const log = (m) => { if (!values.quiet) console.log(m); };

if (!fs.existsSync(bridgePath)) {
  console.error(`找不到 ${bridgePath}`);
  process.exit(1);
}

let src = fs.readFileSync(bridgePath, 'utf8');

if (src.includes(MARKER)) {
  log('已打过补丁，跳过。');
  process.exit(0);
}

// ── 1) 提取段：保留表情身份字段 + 支持 mface ────────────────────────────────
const OLD_EXTRACT = `function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}`;

const NEW_EXTRACT = `// ${MARKER} —— 表情身份字段：QQ 收藏表情的 emoji_id / md5 是把它对上本地备注库的唯一钥匙，
// 之前被整段丢掉，导致「AI 不认识群友发的表情包」。mface 段也必须认（部分实现用 mface 发表情）。
const STICKER_ID_KEYS = ['emoji_id', 'emojiId', 'emojiid', 'resId', 'res_id', 'key', 'md5', 'file', 'url'];
function pickStickerIdentity(d) {
  const out = { emojiId: '', md5: '' };
  for (const k of STICKER_ID_KEYS) {
    const v = d?.[k];
    if (v == null || v === '') continue;
    const s = String(v);
    if (!out.emojiId) out.emojiId = s;
    // 32 位十六进制就是 md5；emoji_id 里也内嵌 md5，取出来便于与表情库精确匹配
    const m = /[0-9a-fA-F]{32}/.exec(s);
    if (m && !out.md5) out.md5 = m[0].toUpperCase();
  }
  return out;
}
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image' || seg.type === 'mface') {
      const id = pickStickerIdentity(d);
      media.push({
        kind: seg.type === 'mface' ? 'mface' : 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : (seg.type === 'mface' ? 'sticker' : ''),
        summary: String(d.summary ?? d.summaryText ?? ''),
        emojiId: id.emojiId,
        md5: id.md5
      });
    } else if (seg.type === 'face') {
      const id = pickStickerIdentity(d);
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        emojiId: id.emojiId,
        md5: id.md5
      });
    }
  }
  return media;
}`;

// ── 2) 注入文本：分支 + 直接带上表情库备注 + 取图失败要出声 ─────────────────
const OLD_HINT = `  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return \`\\n【图片/表情】本条消息包含 \${mediaList.length} 个图片/表情（消息ID=\${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="\${key}", messageId="\${messageRef}"。\`;
    }
    return \`\\n【图片/表情】本条消息包含 \${mediaList.length} 个图片/表情（消息ID=\${messageRef}）。\`;
  }`;

const NEW_HINT = `  function stickerNoteFor(media) {
    if (!media || media.kind === 'face') return null;
    const md5 = String(media.md5 ?? '').toUpperCase();
    const emojiId = String(media.emojiId ?? '');
    if (!md5 && !emojiId) return null;
    const list = Array.isArray(stickerEntries) ? stickerEntries : [];
    const hit = list.find((s) => {
      const sMd5 = String(s?.md5 ?? '').toUpperCase();
      const sId = String(s?.resId ?? s?.id ?? s?.emojiId ?? '');
      if (md5 && sMd5 && md5 === sMd5) return true;
      if (emojiId && sId && (sId === emojiId || (md5 && sId.includes(md5)))) return true;
      return false;
    });
    if (!hit) return null;
    // 命中库但没备注，和「压根没收藏」是两回事，调用方要能分开措辞
    const note = String(hit.localNote ?? '').trim();
    const usage = String(hit.usage ?? '').trim();
    return { entry: hit, note: note || usage || '' };
  }
  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0) return '';
    const total = mediaList.length;
    // 表情库备注：命中就写进去。最多 3 条，避免提示词膨胀。
    const noted = [];
    const seenNote = new Set();
    let knownNoNote = 0;  // 收藏过但还没写备注
    let unknown = 0;      // 库里没有（多半是普通照片）
    for (const m of mediaList) {
      const found = stickerNoteFor(m);
      if (!found) { unknown++; continue; }
      if (!found.note) { knownNoNote++; continue; }
      if (!seenNote.has(found.note)) { seenNote.add(found.note); noted.push(found.note); }
    }
    // 取图失败要显式出声，否则模型会照着「有图片」的暗示编画面
    const failed = mediaList.filter((m) => m && m.kind !== 'face' && typeof m.text === 'string' && m.text.includes('失败')).length;
    const lines = [];
    const refPart = messageRef ? \`（消息ID=\${messageRef}）\` : '';
    if (total === 1 && mediaList[0]?.kind === 'face') {
      lines.push(\`【表情】对方只发了一个 QQ 系统表情\${refPart}。\`);
    } else if (noted.length > 0 && noted.length >= total) {
      lines.push(\`【表情包】对方发来 \${total} 张表情，你已经认识这些：\${noted.map((n) => \`「\${n}」\`).join('、')}。\`);
    } else {
      lines.push(\`【图片/表情】本条消息包含 \${total} 个图片/表情\${refPart}。\`);
      if (noted.length > 0) lines.push(\`其中 \${noted.length} 张是你收藏过的：\${noted.map((n) => \`「\${n}」\`).join('、')}。\`);
      // 命中库但没有备注 / 压根没进库：这两种情况下模型最该做的是「看一眼 + 补一条备注」，
      // 否则备注库永远不会长，下次还是「不认识」。两种要分开说，别把普通照片说成「你收藏过」。
      if (knownNoNote > 0) lines.push(\`其中 \${knownNoNote} 张是你收藏过但还没写备注的。看过之后用 qq_sticker_note 补一句你自己的理解，下次就能直接认出来。\`);
      // 没进库的（多半是普通照片/没收藏的表情）：鼓励「看一眼 + 收藏并写备注」，
      // 否则备注库永远不会长，下次还是「不认识」。
      if (unknown > 0) lines.push(\`有 \${unknown} 张你库里还没有。觉得以后用得上就 qq_collect_sticker 收进来并写一句备注。\`);
    }
    if (failed > 0) {
      lines.push(\`注意：有 \${failed} 张取不到内容，你现在**看不到**它，别猜、别描述画面，需要就说一句你看不清。\`);
    }
    lines.push('（上面是给你的说明，不要把它原样念出来。）');
    // 已经认出表情就不催它再取一次图：省一次工具往返，也省掉提示词里的噪声。
    if (currentMode === 'reserved2' && messageRef && noted.length < total) {
      lines.push(\`要亲眼看的话调用 mcp__snowluma__qq_get_message_images，参数 key="\${key}", messageId="\${messageRef}"。\`);
    }
    return \`\\n以下内容是给你的图片说明，不是群友消息：\\n\${lines.join('\\n')}\`;
  }`;

// ── 3) 「只发图不配字」时明确告诉模型：这张图就是他要说的话本身 ──────────────
// 统一走一个 helper，三处上下文/快照渲染都改，避免漏掉某一处导致行为不一致。
const HELPER_ANCHOR = `  function mediaHintFor(key, messageRef, mediaList) {`;
const HELPER_TEXT = `  // @@LOCAL-PATCH:sticker-awareness —— 把「只发图不配字」这一种情况显式标出来。对方只丢一张表情不说话时，
  // 「接他那句话的情绪」这类指令没有落点，模型会退回默认的「看图说话」。
  const ONLY_MEDIA_NOTE = '\\n【重要】这条消息除图片/表情外没有任何文字 —— 这张图就是他要说的话本身，直接当作他说了一句话来接，不要描述画面。';
  function messageLineWithMediaHint(key, m) {
    const body = String(m?.text ?? '').replace(/\\[图片\\]|\\[表情[^\\]]*\\]/g, '').trim();
    const onlyMedia = !body && Array.isArray(m?.media) && m.media.length > 0;
    const hint = mediaHintFor(key, m?.messageId, m?.media) + (onlyMedia ? ONLY_MEDIA_NOTE : '');
    return \`\${m?.isOwner ? '【管理员】' : ''}\${m?.sender}：\${m?.text}\${hint}\`;
  }
  // @@LOCAL-PATCH:sticker-awareness
  // 把发来的表情对上本地备注库：命中就直接把「AI 自己写过的中文理解」写进提示词，
  // 不必先取图 —— 这正是「认识表情包」的关键（取图多一次往返，且模型常常干脆不取）。
`;

// 三处渲染点：把内联的 mediaHintFor 换成 helper
const LINE_SPECS = [
  {
    label: 'buildContextBlock（上下文块）',
    old: "    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\\n') || '（无）';",
    new: "    return ctx.map((m) => messageLineWithMediaHint(key, m)).join('\\n') || '（无）';"
  },
  {
    label: '新消息渲染',
    old: "    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\\n');",
    new: "    const lines = newMsgs.map((m) => messageLineWithMediaHint(key, m)).join('\\n');"
  },
  {
    label: '唤醒快照（对方只发表情触发唤醒的那条路）',
    old: "      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\\n');",
    new: "      const lines = entry.items.map((m) => messageLineWithMediaHint(k, m)).join('\\n');"
  }
];

// ── 先全部校验，再一次性写入（避免中途失败留下半成品）──────────────────────
const missing = [];
if (!src.includes(OLD_EXTRACT)) missing.push('extractMediaFromSegments 定义');
if (!src.includes(OLD_HINT)) missing.push('mediaHintFor 定义');
if (!src.includes(HELPER_ANCHOR)) missing.push('mediaHintFor 定义处（helper 插入点）');
for (const s of LINE_SPECS) if (!src.includes(s.old)) missing.push(s.label);
if (missing.length) {
  console.error('锚点缺失，中止（未改动任何内容）：\n  - ' + missing.join('\n  - '));
  process.exit(1);
}

let out = src;
out = out.replace(HELPER_ANCHOR, HELPER_TEXT + HELPER_ANCHOR);
out = out.replace(OLD_EXTRACT, NEW_EXTRACT);
out = out.replace(OLD_HINT, NEW_HINT);
for (const s of LINE_SPECS) out = out.replace(s.old, s.new);

fs.writeFileSync(bridgePath, out, 'utf8');
log(`补丁已写入 ${bridgePath}`);
log('  1) extractMediaFromSegments：保留 emojiId/md5 + 支持 mface 段');
log('  2) mediaHintFor：识别表情库备注 / 取图失败出声 / 说明用「以下」包裹防回声');
log('  3) 三处渲染点统一走 messageLineWithMediaHint：「只发图不配字」时明确告知那张图就是他说的话');
log('  下一步：systemctl --user restart nexp.service');
