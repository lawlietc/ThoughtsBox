# 思绪盒子 Thoughts Box

> 本地优先的个人思绪整理工具 —— 把杂乱的念头、经历、情绪倒进盒子，再由整理与回看帮你重新打开过去的记录。
>
> A local-first personal tool for capturing and re-organizing messy thoughts, episodes and emotions.

**当前状态：早期开发，V0 实现中。** M0–M4 已完成（工程骨架、记录与版本、全文搜索与备份、辅助整理与隐私关卡、生产 HTTP 链路与真实模型调用），M5 正在收口界面与交互（今天 / 盒子 / 记录三页、情绪盒子、设置页双模型档）。对外接口与数据格式仍可能变化，请谨慎用于真实数据。

![情绪盒子：出现过的情绪按频次凝成一颗颗球摆在盒子里，右上角在「盒子 / 列表」两档之间切换，盒盖上的「合上」收起整个盒体](docs/images/Box-1.png)

## 这是什么

Thoughts Box 是一个运行在自己电脑上的单用户记录应用。你随时把未经整理的内容写进来——一段经历、一个念头、一种情绪，不需要格式；之后由应用协助你重新使用这些记录：

- **记录与修订**：原始内容按版本保存，可以被修改而不丢失历史；全文检索覆盖当前与历史文本。
- **中文友好的搜索**：查询侧与索引侧共用同一个确定性分词器（NFKC 归一 → CJK 连续段 1/2/3-gram → ASCII 整词），配合 SQLite FTS5 的 BM25 排序；索引失步可检测、可重建。
- **辅助整理**：应用依据一套公开的封闭词表（36 个情绪概念、18 个主题概念、8 类实体）把自由文本关联到可浏览的结构上。整理结果默认是**候选**，经用户确认后才成为正式内容；用户的手工修正不会被任何自动重算覆盖——「值闸门」在 Schema 层就被钉住。
- **五个回看维度**：情绪 / 经历 / 念头 / 人物与事物 / 主题各成一页，条目能追回它是从哪一条记录的哪一句来的（证据引用）。情绪页额外提供一种盒体表达：出现过的情绪按频次成球、分页摆放，点开球看该情绪的分段详情与原文引用。
- **快速记录与睡前收尾**：写一条随时可用，可选「保存并整理」；睡前模式只做倒出来与收好，**不数你还欠多少条没整理**，不挽留。
- **数据自主**：备份的创建/列表/校验/删除/整库恢复，JSONL 导出与导入，数据自检，都在应用内。

所有数据保存在本机 SQLite 数据库中；无账号体系，无云依赖，本地服务仅监听回环地址。

## 界面结构

顶层三个 tab（`src/web/ui/nav.ts` 是唯一口径，测试直接 import 它做结构断言）：

| tab | 子页 | 定位 |
|---|---|---|
| 今天 | 今天 / 全部记录 / 待整理 / 待确认 | 每天都用的 |
| 盒子 | 情绪 / 经历 / 念头 / 人物与事物 / 主题 / 搜索 | 偶尔回看的 |
| 更多 | 设置 / 隐私 / 数据与备份 | 一年点不了几次的 |

「快速记录」与「睡前收尾」是动作而不是标签页，入口在「今天」上。主题两档：晨雾（浅色）与夜灯（月白青），选择存进 `localStorage`。

## 处理模式与隐私边界

每条记录独立携带一个处理模式，取值封闭：

| 模式 | 含义 | 外发 |
|---|---|---|
| `manual_only` | 只保存，不整理（默认） | 否 |
| `local_model` | 交给本机/局域网自建的模型服务整理 | 不出本机网络边界 |
| `cloud_redacted` | 交给云端模型整理 | 仅在逐条显式授权后 |

云端这条路被刻意做重：**发之前必须先看真实要发出去的那段文本**。`POST /api/ingest/preview` 返回脱敏后的实际待发文本，用户读完再 `POST /api/ingest/confirm-send` 授权，授权只覆盖这一条这一次。脱敏映射表本身不上线。此外每条记录还有 `privacy_level`（`normal` / `sensitive`），状态机 `captured → awaiting_privacy_review → preprocessing → processing → parsed / failed / needs_reparse` 由 `src/shared/constants/enums.json` 封闭定义，实现不得发明取值。

删除采用应用层硬删除（FTS 影子表 + 触发器 + `PRAGMA secure_delete`），并留下**不含原文**的审计记录；但不回溯旧备份，也不承诺物理介质上绝对不可恢复——隐私声明只写做得到的事。

## 本地 API 面

前端与后端之间的全部接口，都是本机的、无鉴权的回环 HTTP（单用户应用的明确取舍）：

```
GET  /api/health                        自检摘要（版本、契约指纹、数据目录、绑定地址）
POST /api/records                       写一条（带处理模式）
GET  /api/records?limit&offset          列表
GET/PUT/DELETE /api/records/:id         读 / 改原文（产生新版本）/ 硬删除
PATCH /api/records/:id/mode             改这条的处理模式（状态随之迁移）
GET  /api/search?q=                     全文检索
POST /api/search/rebuild                索引重建（先报失步，再报重建后）
GET  /api/ingest/pending                待整理队列
POST /api/ingest/parse                  跑一次整理（本机或云端 Provider）
POST /api/ingest/preview                取真实待发文本（脱敏预览）
POST /api/ingest/confirm-send           逐条本次发送授权
POST /api/ingest/confirm-candidates     确认候选成为正式内容
POST /api/ingest/adopt | /discard       采纳 / 丢弃一次整理结果
GET/PUT /api/ingest/config              模型与隐私模式（两档：本机 / 云端）
POST /api/backups                       建快照
GET  /api/backups                       列表 + 磁盘余量
POST /api/backups/:name/verify          校验快照
DELETE /api/backups/:name               删快照
POST /api/restore                       整库替换（必须 confirm=true，替换前先做安全备份）
GET  /api/export/jsonl                  全量导出 NDJSON
POST /api/import/jsonl                  导入（目标非空即 409 拒绝）
GET  /api/data-check                    数据一致性自检
GET  /api/storage-maintenance[/retry]   存储维护待办与重试
```

错误响应只带错误码与策展过的说明，不回显输入原文，也不透出 SQL 细节。

## 运行要求

- Node.js `>=24.18.0 <27`（依赖运行时内建的 `node:sqlite` 与 `crypto.randomUUIDv7`，版本过低或过高都会在启动自检中被明确拒绝）。
- 主要开发于 Windows；macOS / Linux 走 XDG 数据目录，不硬编码路径。

## 启动

```bash
npm install
npm run dev            # 同时拉起本地后端（8737）与前端（5173）
npm run launch         # 同上，但若存在 ~/.thoughtsbox/provider.key 则注入模型 key，走真实整理链路
npm run typecheck      # 服务端 + 前端两套 tsconfig
npm test               # 全部验收断言（本快照 46 个测试文件 / 998 条断言）
```

只起后端：`npm run start:server`；只起前端：`npm run start:web`；只看演示数据界面：`npm run start:mock`。

两个端口都是固定的，不静默切换（`strictPort`）——这是产品约束而不是偏好：端口被占时必须显式失败，而不是悄悄换到下一个端口，让第二个实例绕过单实例锁。

想在没有后端的情况下看界面（无模型 key、无数据库）：

```bash
npm run start:mock     # 5174，仅 dev 构建生效，用 fixtures/ 的演示数据
```

上面几条都是 `node scripts/*.mjs`，Windows / macOS / Linux 同一条命令——需要跨平台的只是「谁来设 `VITE_USE_MOCK`」，脚本里改完 env 再拉起 vite，不依赖 shell 的前置赋值语法。

该开关只在开发构建里被读到，`npm run build` 之后整条假数据链路（连同 `fixtures/`）会被树摇掉，不进入生产产物。

## 数据在哪

- 运行时数据目录：`%LOCALAPPDATA%\ThoughtsBox\`（非 Windows：`$XDG_DATA_HOME` 或 `~/.local/share`）。
- 数据库、备份、日志、本地配置、实例锁都在该目录，**仓库目录不放私人数据**。
- 用 `TB_DATA_DIR=<目录>` 覆盖——测试与多实例开发必须用它隔离。
- 首次启动从 `config.example.json` 生成 `config.local.json`；模板只有占位值，密钥只经环境变量提供，配置文件中出现疑似密钥字面值会被直接拒绝。
- 启动时执行单实例检查与自检（Node/SQLite 版本、迁移版本、契约指纹、目录布局），任一不过即拒绝启动而非降级运行。

## 项目原则

- **本地优先**：记录、整理结果、回看、搜索全部存在本机 SQLite，服务只监听回环地址，固定端口，不自动切换。
- **云端是显式选项**：每条内容的处理方式独立标记；发往云端前必须经过逐条的「本次发送授权」，并向用户展示真实脱敏文本。不使用云端模式则永不外发。
- **删除是真的删除**：见上文隐私边界一节；声明只承诺做得到的事。
- **AI 是建议者，不是裁决者**：自动产生的情绪、主题、实体关联先进入候选与建议队列，由用户确认后才成为正式内容；用户的手工修正优先于任何重算。
- **封闭枚举**：状态、关系类型、处理方式、实体类型等取值集合全部固化在 `src/shared/constants/enums.json`，由 Schema 校验与测试断言共同守护，实现不得发明取值。
- **图谱暂时不做**：记录之间的关系目前以候选建议（可能相关、疑似同一）的形式存在，由人在「待确认」里裁决；跨记录的全局图谱已裁定推迟，不是被遗漏了。

## 仓库结构

```
src/server/   本地后端：HTTP 服务与三条路由面、启动自检、单实例锁、
              SQLite 适配层与迁移、词表播种、配置加载、
              记录/搜索/备份恢复/整理与隐私/修正层各服务
src/shared/   契约层：封闭枚举（constants/enums.json）、情绪与主题词表
              （vocab/）、Zod Schema 与 DTO、ID 前缀、CJK 分词器、契约指纹加载
src/web/      React 19 + Vite 7 前端（可视化层，不持有业务数据）：
              三 tab 外壳与今天 / 盒子 / 记录 / 搜索 / 数据 / 睡前 / 更多各面板，
              可读投影与两个数据口（真接口 productPort / 演示 fixturePort）
scripts/      开发启动器：dev.mjs 纯本地、launch.mjs 会注入仓库外的模型 key、
              mock-web.mjs 拉起 5174 的演示界面；三个都是 node 脚本，跨系统同一条命令
fixtures/     演示数据（mock 模式，仅 dev 构建被引用）
tests/        vitest 验收断言（一律使用隔离数据目录，不触碰真实用户数据）
```

## 开发路线

按里程碑推进，不承诺日期：M0 工程骨架 → M1 记录 / 版本 / 搜索 / 备份 → M2 辅助整理与隐私关卡 → M3 Web 外壳与可读投影 → M4 生产链路与真实模型调用（以上均已完成）→ M5 界面与交互收口（进行中）→ 移动端（推迟，先做完 Web）→ 受限全局图谱（长期候选）。产品规格与设计文档不在本仓库发布；上文即为 V0 目标的完整自述。

## 关于本仓库

本仓库以里程碑为单位单向同步上游开发进展，不承载完整提交历史，因此看不到「某一行为什么这样改」的过程；欢迎通过 issue 讨论方向与缺陷。

## License

AGPL-3.0-only（见 [LICENSE](LICENSE)）。选择带网络条款的强 Copyleft 是明确的设计立场：这个工具处理的是个人最私密的记录，任何人基于本代码修改后以服务形式提供给他人，同样必须公开其源代码——「数据留在本机」的承诺不应因分发形态的改变而失效。

其中两个文件移植自作者的另一份工程（`src/shared/search/tokenizer.ts`、`src/server/ingest/extractJson.ts`），来源与移植时的内容指纹记在各自文件头；逻辑逐字保留，仅统一了代码风格。
