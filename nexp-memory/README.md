# nexp-memory

给 **QQ 聊天机器人**用的文件化记忆框架。

一条记忆一个 markdown 文件，Obsidian 直接能打开；上下文重置前自动落快照，重置后能关键词回溯。
**零依赖**，只用 Node 内置模块，`node --test` 直接验证。

---

## 来源与边界

本库是从**一个真实在跑的 QQ 机器人**上排查出来的，不是凭空设计的。

那个机器人的架构是 **[qq-bridge](https://github.com/Derpyu520/qq-bridge)**（QQ ↔ DeepSeek Harness 桥接）
+ **SnowLuma**（OneBot 网关）+ **DSH**（agent 运行时）。README 里那些实测数字
（每次调用 476K token、记忆被截断在 50 字、缓存命中率 99.5%）
都来自那套系统的真实账本。

有两件事想先说清楚，免得误会：

1. **记忆层这部分是我自己写的**，用的是 Node 内置模块，零依赖、可单测。这层里没有直接
   搬 qq-bridge 的代码 —— 但**整个项目是在它基础上改的**，见下面第 2 条。
2. **它是一个通用的存储/检索/归档模块**，不绑定 qq-bridge、也不绑定 DSH / SnowLuma：
   任何需要"给聊天机器人做长期记忆"的项目都能接。接回原系统的方式是一层薄补丁
   （见 `docs-integration.md` 末尾的接入规模参考）。

> 本库是**在 qq-bridge 上做出来的**：仓库根那一部分是它的补丁分支，记忆层则是从这次
> 改造里独立抽出来的模块。所以这里对 [Derpyu520](https://github.com/Derpyu520) 标一句来源：
> **没有它作为真实运行环境，这些问题不会以可复现的形式暴露出来；没有它的既有设计，这个库
> 也无从下笔。**



```
memories/
  群-123456/
    人物-示例甲.md           ← 长期记忆：一条事实一行
    话题-追比赛.md
    快照-2026-10-13T104126.md  ← 时间切片：某段时间发生了什么
  私聊-10001/
    人物-管理员.md
  INDEX.md                 ← 目录索引
```

---

## 它解决什么问题

这套东西不是凭空设计的，是**从三个真实故障里长出来的**。如果你的机器人也踩过，这个框架就是给它的。

### 故障一：记忆被硬截断，事实全是半句话

原实现把模型写来的一整段话按字节截断后存进 JSON：

```js
traits.push(text.slice(0, 50));   // ← 问题在这
```

模型一次写来 500 字的印象，被切成 6 条各 50 字，**每条都在半句处断掉**。实际存出来的东西长这样：

```
…下午说是「在          ← 断在这
…明确说过他发的表情就是随手一发，不用我逐张点评；另外半夜发过 QQ 扫码登录的二维码，我没扫也没做任   ← 断在这
```

**检索再准也救不回来 —— 信息本身就残缺。**

本框架的 `atomicize()` 按标点拆，**绝不按字节切**：

```js
atomicize('他上来先问「你是人吗」，然后连甩几张梗图，还主动给我存了两个表情（表情A / 表情B）。发图时叫过我「角色X」，是故意的')
// → [
//     '他上来先问「你是人吗」，然后连甩几张梗图，还主动给我存了两个表情（表情A / 表情B）。',
//     '发图时叫过我「角色X」，是故意的'
//   ]
```

实在无法安全拆分时（整句没有标点）**宁可整条保留，也不截断**。

### 故障二：记忆无过滤全量注入

原实现把该会话**全部**记忆塞进每次提示词。记忆一多，既贵又稀释注意力。

本框架的 `selectMemory()` 按相关性挑选：

| 信号 | 权重 |
|---|---|
| 记忆里提到的群友**此刻正在说话** | 0.55（名字命中）|
| 记忆文本与当下语境的词元重合 | 每个 +0.22，上限 0.6 |
| 类别稳定性：印象 > 话题 > 想法 | 1.0 / 0.85 / 0.45 |
| 时效衰减 | 话题 6 小时半衰；想法 90 分钟（它本来就短命）|

**相关度是乘法地板**：与语境零相关的条目分数就是 0，不会因为"没过期"就混进提示词。

实测（真实线上数据，两条会话）：

| 会话 | 记忆总量 | 注入 | 省 |
|---|---|---|---|
| 群聊 | 11 条原子事实 | 6 条 / 209 字符 | **54%** |
| 私聊 | 17 条原子事实 | 6 条 / 221 字符 | **70%** |

> ⚠️ **诚实说明**：省的是"记忆块"的 54~70%，而记忆块本身只占上下文的千分之几。
> **真正的大头是宿主自己的会话历史**（实测单次调用 476K token，其中 98% 是对话历史）。
> 这个框架**不负责**省那部分 —— 它负责的是**记忆质量**和**跨重置的回溯能力**。

### 故障三：上下文重置 = 彻底失忆

宿主会话历史只增不减。到上限就必须重置，而重置后模型对之前发生的事一无所知。

本框架在**重置之前**落快照，**之后**可检索：

```js
// 重置前
archive.writeSnapshot('group:123456', {
  reason: 'context-reset',
  st: sessionState,
  memoryBlock: currentMemory
});

// 之后任何时候，模型都能翻旧账
archive.search('KFC');
// → [{ when: '2026-10-13T10:41:26Z', kind: 'snapshot',
//      text: '有人说过某件事，结果没做成——这个梗可以拿来调侃' }]
```

---

## 三块能力

| 模块 | 管什么 | 关键导出 |
|---|---|---|
| `src/store.js` | **长期记忆**：一条事实一个文件，可增删改 | `atomicize` `createMemoryStore` `parseFrontmatter` `renderMarkdown` |
| `src/retrieval.js` | **相关性检索**：决定这次该注入哪几条 | `selectMemory` `renderMemory` `scoreEntry` `tokenize` |
| `src/archive.js` | **归档与回溯**：快照、搜索、恢复 | `createArchiveStore` `buildSnapshotMarkdown` `searchDocs` |

三者**互不依赖**（`archive.js` 刻意不 import `store.js`，避免宿主改名时崩）。可以只用其中一块。

---

## 快速开始

```bash
npm test          # 51 个用例
npm run bench     # 用真实数据量化省了多少
```

### 存一条记忆

```js
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from 'nexp-memory/store';

const store = createMemoryStore({ root: 'memories', fs, path });

store.put('group:123456', {
  category: 'memberImpression',
  subject: '示例甲',
  atoms: '他喜欢玩射击游戏。他爱晒战绩。'   // 长内容自动原子化
});
```

生成 `memories/群-123456/人物-示例甲.md`：

```markdown
---
id: 群-123456/人物-示例甲
category: memberImpression
subject: 示例甲
updated: "2026-10-13T02:32:33.956Z"
---

# 人物-示例甲

- 他喜欢玩射击游戏。
- 他爱晒战绩。
```

### 检索该注入哪几条

```js
import { selectMemory, renderMemory } from 'nexp-memory/retrieval';

const { kept, dropped, stats } = selectMemory(sessionState, {
  maxItems: 6,
  maxChars: 900
});

console.log(stats.savedRatio);   // 0.54 → 省了 54%
prompt += renderMemory(kept);
```

`sessionState` 里检索层会看的字段：`recentMessages` / `unread`（用来算"谁在说话"），
以及记忆本体。也支持外部注入条目（`__mdEntries`）—— 把上面的 md 库接进来就靠它：

```js
import { createMemoryStore, loadEntriesForRetrieval } from 'nexp-memory/store';

const st = { ...sessionState, __mdEntries: loadEntriesForRetrieval({ store, key }) };
selectMemory(st);   // md 优先；为空则自动回退到 JSON 里的旧字段（防失忆）
```

### 归档与回溯

```js
import { createArchiveStore } from 'nexp-memory/archive';

const archive = createArchiveStore({ root: 'memories', fs, path, dirFor: store.dirFor });

archive.writeSnapshot('group:123456', { reason: 'context-reset', st, memoryBlock });
archive.search('KFC');                       // 跨快照 + 长期记忆
archive.recentSnapshots('group:123456', 1);  // 取最近一份（用于恢复）
```

---

## 设计决策（以及为什么）

**为什么零依赖？**
宿主可能跑在任何地方（我这边是一个 低配 的 VPS）。引一个 yaml 库就意味着升级时会断。
frontmatter 只用最小子集（标量 + 行内数组），自己解析 20 行搞定。

**为什么纯文本而不是数据库/向量库？**
- 能直接打开看它到底记了什么 —— 调试时这一点无可替代
- 能手改 —— 模型记错了，人工能修
- 能 git —— 记忆的变更历史本身就值得留
- 关键词检索对"翻旧账"够用（实测查几条口语化的词都能准确定位到几百条消息前的那一句）

**为什么归档不做 LLM 摘要？**
摘要要多花一次模型调用，还可能失真。落**压缩的原始对话**，
需要时让模型自己检索阅读 —— **宁可存全，不存错**。
一份 60 条消息的快照约 5KB，成本可以忽略。

**为什么打分要乘法地板？**
最初写成 `score = (nameScore + kwScore) * catW * (0.55 + 0.45 * recency)`，
结果 recency 给了 0.3 的底数，**无关记忆也拿 0.3 分**，过滤形同虚设。
改成 `relevance * catW * (0.25 + 0.75 * recency)`：零相关就是零分。

---

## 已知边界

- **不省宿主会话历史的 token。** 那部分占大头（实测 98%），但只有"重置会话"能清掉，
  而重置会让 prompt cache 失效、首次调用更贵。本框架提供归档/恢复的**零件**，
  是否、何时重置由宿主决定。
- **关键词检索不是语义检索。** 查「他上次为什么生气」这种意图式问题，命中率不如向量检索。
  但换来的好处是没有 embedding 依赖、不需要额外服务、结果可解释。
- **检索质量取决于记忆粒度。** 如果一条记忆塞了 8 件事，检索只能整条留或整条丢。
  所以 `atomicize` 和"一条事实一条"是前提，不是可选项。

---

## 许可

MIT
