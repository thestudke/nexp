/**
 * nexp-memory —— 给 QQ 聊天机器人用的文件化记忆框架。
 *
 * 三块能力，可单独用也可组合：
 *   store     长期记忆：一条事实一个 markdown 文件，Obsidian 可直接打开
 *   retrieval 相关性检索：把「全部注入」换成「只注入当下相关的几条」
 *   archive   归档与回溯：上下文重置前落快照，之后可关键词检索历史
 *
 * 设计约束（刻意的）：
 *   - 零运行时依赖。只用 Node 内置模块，不引 yaml / 向量库 / 数据库。
 *   - 纯文本即真相。JSON 状态可由文件重建，反过来不行。
 *   - 打分与文件读取分离。检索是纯函数，能单测、能换宿主。
 */
export * from './store.js';
export * from './retrieval.js';
export * from './archive.js';
