# 宿主集成说明

本框架只做**存储 / 检索 / 归档**三件事，不含任何宿主特有的东西。
接进你自己的机器人时，只需要在四个点上打桩。

## 1. 会话状态从哪来

检索层需要知道「此刻谁在说话、在聊什么」，用 `sessionState` 传入：

```js
{
  recentMessages: [{ sender, text, tail, isSelf, time }],  // 最近的消息
  unread:         [{ sender, text, tail, isSelf, time }],  // 未读（优先）
  // 以及记忆本体，二选一：
  activeTopics:        [{ text, lastMentionAt, participants, pendingQuestion }],
  pendingThoughts:     [{ text, motivation, createdAt, expiresAt }],
  memberImpressions:   { '名字': { traits: [], interactionCount, lastSeenAt } },
  // 或者：外部注入的原子条目（推荐）
  __mdEntries:         [{ id, category, text, names, at }]
}
```

`__mdEntries` 有值时优先用它，为空则回退到 JSON 三字段 —— **这样记忆库被删/读失败也不会让机器人失忆**。

## 2. 四个打桩点

| 时机 | 调什么 |
|---|---|
| **每轮唤醒** | `selectMemory(st)` → `renderMemory(kept)` → 拼进提示词 |
| **每轮唤醒（可选）** | `loadEntriesForRetrieval({store, key})` 挂到 `st.__mdEntries` |
| **上下文重置之前** | `archive.writeSnapshot(key, {reason, st, memoryBlock})` |
| **新建会话之后** | `archive.recentSnapshots(key, 1)` → 把对话尾部灌回 `recentMessages` |

关键顺序：**归档必须在清理会话状态之前调用**，否则快照是空的。

## 3. 两侧都要能失败

生产环境的铁律：**记忆相关的任何一步失败，都不能让机器人停止工作**。

```js
// 归档：失败只记日志，不阻断重置
try { archive.writeSnapshot(...) } catch (e) { log('归档失败（不影响重置）', e) }

// 检索：失败退回全量注入
const picked = (() => { try { return selectMemory(st) } catch { return null } })();
const block = picked ? renderMemory(picked.kept) : legacyFormatMemory(st);
```

## 4. 迁移旧记忆

见 `examples/migrate-from-json.mjs`。要点是**受控重建**而不是全自动搬运，
理由（以及一个踩过的坑）写在那个文件的头部注释里。

## 5. 一个真实接入案例

本框架源自一个跑在 低配 Ubuntu VPS 上的 QQ 机器人（DSH + MCP 架构）。
接入方式是 6 个幂等补丁脚本，每个都带 `@@LOCAL-PATCH:名字` 标记，
宿主升级后重跑即可。规模参考：

| 补丁 | 改动量 |
|---|---|
| 检索层接线 | ~40 行（import + 一个 `buildMemoryBlock`）|
| md 存储接线 | ~35 行 |
| 归档 + 恢复 | ~60 行 |
| 搜索工具 | ~50 行（一个 HTTP 端点 + 一个 MCP 工具）|

合计不到 200 行改动就完成了闭环 —— 这正是把逻辑放在独立模块里的好处。
