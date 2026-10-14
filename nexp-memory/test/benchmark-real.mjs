/**
 * 用线上真实 state/social-v2.json 跑一遍检索，量化省了多少。
 * 用法：node test/benchmark-real.mjs [state文件路径]
 */
import fs from 'node:fs';
import { selectMemory, renderMemory, flattenMemory, DEFAULT_OPTIONS } from '../src/retrieval.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node test/benchmark-real.mjs <宿主状态文件.json>');
  console.error('');
  console.error('这个脚本用来量化「检索后注入」相对「全量注入」省了多少，需要一份真实宿主状态。');
  console.error('结构要求：{ conversations: { "<会话key>": { activeTopics, pendingThoughts, memberImpressions, recentMessages } } }');
  console.error('（本库不附带真实数据 —— 那属于使用者自己的记忆）');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

function legacyRender(st) {
  // 复刻桥接原有的全量注入（formatMemoryV2 的分节与截尾规则：每类最多 10 条）
  const lines = [];
  const topics = (st.activeTopics || []).filter((t) => t && t.text);
  if (topics.length) {
    lines.push('【进行中的话题】');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 3600 * 1000 ? '（已搁置）' : '';
      lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    }
  }
  const thoughts = (st.pendingThoughts || []).filter((t) => t && t.text && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-10)) lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
  }
  const imps = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(imps);
  if (names.length) {
    lines.push('【对群友的印象】');
    for (const n of names.slice(-10)) {
      const im = imps[n] || {};
      const tr = Array.isArray(im.traits) ? im.traits : [];
      lines.push(`- ${n}：${tr.length ? tr.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
    }
  }
  return lines.join('\n');
}

console.log('状态文件:', file, '\n');
let totLegacy = 0, totNew = 0;
for (const [key, st] of Object.entries(raw.conversations || {})) {
  const legacy = legacyRender(st);
  const { kept, dropped, stats } = selectMemory(st);
  const next = renderMemory(kept);
  totLegacy += legacy.length; totNew += next.length;
  console.log(`════ ${key} ════`);
  console.log(`  全量注入 : ${legacy.length} 字符`);
  console.log(`  检索后   : ${next.length} 字符  （省 ${stats.savedRatio ? Math.round(stats.savedRatio * 100) : 0}%）`);
  console.log(`  条目     : 共 ${stats.total} → 留 ${kept.length} / 丢 ${dropped.length}`);
  console.log(`  语境信号 : 在说话 ${stats.speakers} 人、词元 ${stats.contextTokens} 个`);
  console.log('  ── 留下的 ──');
  for (const e of kept) console.log(`    ✅ [${e.category}] ${e.text.slice(0, 52)}   (score ${e.score.toFixed(3)}${e.nameHits ? ', 名字命中' : ''}${e.kwHits ? ', 关键词×' + e.kwHits : ''})`);
  console.log('  ── 丢弃的 ──');
  for (const e of dropped.slice(0, 6)) console.log(`    ⬜ [${e.category}] ${e.text.slice(0, 52)}   (score ${e.score.toFixed(3)})`);
  if (dropped.length > 6) console.log(`    …还有 ${dropped.length - 6} 条`);
  console.log(`  ── 检索后实际注入文本 ──`);
  console.log(next.split('\n').map((l) => '    ' + l).join('\n') || '    （空）');
  console.log();
}
console.log('══ 合计 ══');
console.log(`  全量 ${totLegacy} 字符 → 检索后 ${totNew} 字符`);
if (totLegacy > 0) console.log(`  共省 ${totLegacy - totNew} 字符（${Math.round((1 - totNew / totLegacy) * 100)}%）`);
