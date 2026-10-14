# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注）

> ⚠️ **本仓库是脱敏后的发布版**：原项目里的大量内部文档（项目说明书、设计规划、
> 调研记录、审查报告、历史归档）**未随本仓库发布**，因此下面的索引只列出仓库中
> 实际存在的文档。如果你从别处看到指向 `design/`、`research/`、`audits/`、`legacy/`
> 或 `guides/PROJECT_GUIDE.md`、`guides/VOICE.md` 的链接，那些文件不在本仓库。

---

## 根目录

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [../README.md](../README.md) | 主说明：架构、安装配置、启动流程、运行与运维、已知限制 | ✅ |
| [../README.en.md](../README.en.md) | 上述的英文版（内容较简） | ✅ |
| [../RULES.md](../RULES.md) | QQ 会话的权限边界与安全承诺（运行模式、管理员能力、群友不能做什么） | ✅ |

## docs/ —— 索引与地图

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 仓库目录地图与 `scripts/` 命名约定：每个目录/脚本是干什么的 | ✅ |
| 本文件 | 文档索引（你正在看的这份） | ✅ |

## docs/guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`qq-chat` / `qq-chat-v2` preset 与三个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单 | ✅ **改动安全相关代码前必读** |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私检查：脱敏规则的判定标准与用法（配套 `scripts/privacy-scan.mjs`） | ✅ **提交前建议先跑一遍** |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 / 全部配置项 | [../README.md](../README.md)（配置字段表在其中） |
| 在新设备上把 nexp 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)、[guides/PRIVACY.md](guides/PRIVACY.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 记忆库本身的说明 | [../nexp-memory/README.md](../nexp-memory/README.md) |
| 补丁怎么打 / 打补丁的顺序 | [../patches/](../patches/)（顺序见根 README 的「本 fork 的差异」） |
