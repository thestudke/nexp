/**
 * 本地补丁：让"发语音"真的对模型可用（nexp v0.1.7 + 本机已开语音库）。
 *
 * 背景（2026-10-01，用户反馈「他跟我讲没有语音工具」）：
 *   排查结论：工具**一直在**，是**注入文本在劝退模型**。
 *   ① `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 第 39 行的原文是
 *      「16.【发语音（默认没开）】…语音**默认是关闭的**（管理员还没准备好语音库）：
 *        qq_list_voices 报「语音功能已关闭」、qq_send_voice 报「工具未启用」都是正常状态，
 *        **不要重试、不要问群友要音频、也不要假装发了语音**，继续打字即可。…」
 *      这段是**为"默认关闭"写的说明**。本机语音是**开着的**
 *      （config.json: socialV2.voice.enabled=true, tools.sendVoice=true，语音库 7 个音频），
 *      于是模型读到"默认关闭/别重试"就去跟用户说"没有语音工具"。
 *   ② 当前角色卡 `roles/小鲸鱼.md`（仓库自带默认人设）里**一个"语音"字都没有**——
 *      模型连"语音库里有哪几条、什么时候该发"都不知道。
 *
 * 修法（两处，都可回滚）：
 *   A. 预设：把那行改写成"已启用"的语气，并给它一个**自愈式护栏**——
 *      万一以后管理员真把语音关了，工具会报「未启用/已关闭」，那时再安静打字即可，
 *      不需要在这里预先吓唬模型。改完用 build-agent-preset-patches.mjs 重新渲染。
 *   B. 角色卡：`roles/小鲸鱼.md` 追加「十一、语音」（用 `## 十一、语音` 小节，
 *      自动被 role-card 的 ## 分节识别并注入）。带 `@@LOCAL-PATCH:voice-card` 标记，
 *      可用 --revert 精确移除，不影响卡片其余内容。
 *
 * 幂等：两处都带标记，已打过就跳过。
 * 用法：
 *   node apply-voice-tool.mjs                  # 打补丁并重新渲染预设
 *   node apply-voice-tool.mjs --revert          # 只移除角色卡里的语音节
 *   node apply-voice-tool.mjs [--app-dir DIR] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    revert: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false }
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(values['app-dir'] || path.join(__dirname, '..'));
const presetFile = path.join(appDir, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const cardFile = path.join(appDir, 'roles', '小鲸鱼.md');
const PRESET_MARK = '【发语音】';
const CARD_MARK = '@@LOCAL-PATCH:voice-card';
const log = (m) => { if (!values.quiet) console.log(m); };

// ── 角色卡：追加/移除「十一、语音」小节 ─────────────────────────────────────
const CARD_SECTION = `
## 十一、语音
你有一个**现成的语音库**（不是合成的，是预先放好的整活音频），能当 QQ 语音条发出去。
- 先看有什么：qq_list_voices。要发：qq_send_voice 传文件名。
- **什么时候值得发**：被逗笑 / 被怼得接不住 / 想阴阳装傻 / 群友整活你跟着来一条 / 收尾时一声"哈"。语音是"开口说话"，比打字更亲密也更打扰。
- **别发**：严肃话题、有人真难受、技术求助、冷场；也别拿它回一条正常提问。
- 一轮最多一条；挑不准就别发，发错气氛比不发更尴尬。
- 发完只有 verified=true 才能说"我给你发了语音"；否则别声称发过。
`;

function patchCard(revert) {
  if (!fs.existsSync(cardFile)) {
    console.error('找不到 ' + cardFile);
    process.exit(1);
  }
  let card = fs.readFileSync(cardFile, 'utf8');
  const hasSection = card.includes('## 十一、语音');

  if (revert) {
    if (!hasSection) { log('角色卡里没有语音节，跳过。'); return; }
    card = card.replace(/\n?## 十一、语音[\s\S]*?(?=\n## |\s*$)/, '\n');
    fs.writeFileSync(cardFile, card, 'utf8');
    log('角色卡语音节已移除（' + card.length + ' 字符）');
    return;
  }

  if (hasSection) { log('角色卡已有语音节，跳过。'); return; }
  card = card.replace(/\s*$/, '\n') + CARD_SECTION;
  fs.writeFileSync(cardFile, card, 'utf8');
  log('角色卡已追加「十一、语音」（' + card.length + ' 字符 / 上限 6000）');
}

// ── 预设：把"默认没开"的劝退说明改写为"已启用" ──────────────────────────────
function patchPreset() {
  if (!fs.existsSync(presetFile)) {
    console.error('找不到 ' + presetFile);
    process.exit(1);
  }
  let yml = fs.readFileSync(presetFile, 'utf8');

  if (yml.includes(PRESET_MARK)) { log('预设语音行已是启用版，跳过。'); return; }
  if (!yml.includes('【发语音（默认没开）】')) {
    console.error('预设锚点缺失（找不到「【发语音（默认没开）】」），中止（未改动文件）');
    process.exit(1);
  }

  const NEW_LINE = '      16. 【发语音】qq_send_voice 能把语音库（qq_list_voices 可查）里的音频当**语音条**发出去，当前**已启用**。'
    + '语音是「开口说话」的强表达，比打字更亲密也更打扰：**在情绪高点偶尔来一条**（被逗笑、被怼得接不住、想阴阳装傻、群友整活你跟着、收尾），'
    + '别连着发、别拿它替代正常回话、也别每轮都发；一轮最多一条，挑不准就不发。'
    + '只想说一句正经话时继续打字。若 qq_list_voices 报「语音库为空」或 qq_send_voice 报「工具未启用」，说明管理员把语音关了或库空了，'
    + '那就安静打字，不要重试、不要问群友要音频、也不要假装发了语音。返回 verified=true 才代表这条语音确实落地。';

  yml = yml.replace(/^.*【发语音（默认没开）】.*$/m, NEW_LINE);
  fs.writeFileSync(presetFile, yml, 'utf8');
  log('预设语音行已改写为启用版');

  // 渲染成 DSH 读的 patch 文件（源 → 产物的唯一转换器）
  const builder = path.join(appDir, 'scripts', 'build-agent-preset-patches.mjs');
  try {
    execFileSync(process.execPath, [builder], { cwd: appDir, stdio: 'pipe' });
    log('  已重新渲染 plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
  } catch (error) {
    console.error('  渲染失败：' + (error?.stderr?.toString() || error?.message));
    process.exit(1);
  }
}

patchCard(values.revert);
if (!values.revert) patchPreset();

if (!values.revert) {
  log('  下一步：systemctl --user restart nexp.service');
  log('  （只改了预设与角色卡，二者都是每轮注入，无需重启 DSH）');
}
