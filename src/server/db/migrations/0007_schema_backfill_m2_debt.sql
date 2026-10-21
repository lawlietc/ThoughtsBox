-- 0007_schema_backfill_m2_debt.sql —— M3-DB-2：M2 遗留的 schema 层补票（任务书 §五.1 DB-2 / §十四 3・4・5・11）
-- 冻结来源：docs/dev-specs/M1-前置数据库Schema审查.md
--   · §3.7（parse_run 与「当前视图」唯一定义）、§3.16（trigger_assertion 契约提前定形〔冻结·B7〕）、
--     §3.17（suggestion 端点矩阵与 ux_sug_term）
-- 派发依据：docs/dev-specs/2026-10-15-M3-前端骨架合并与可读投影任务书.md §五.1 DB-2 行、§十、§十四 第 3/4/5/11 条
-- 交付记录：docs/dev-specs/worklogs/2026-10-17-M3-db-2-schema-backfill.md
--
-- 四件事里本迁移真正落地的只有 ①④，②③ 的核对结论记在这里，免得下一轮重新考古：
--
-- ② §3.17 的 `ux_sug_term` **早已逐字存在**：0003_derived_layer.sql:622-624
--   `CREATE UNIQUE INDEX ux_sug_term ON suggestion (kind, endpoint_a, subject_term) WHERE subject_term <> '';`
--   实测（沙箱 0001→0006 后查 sqlite_master）该索引在场，且由 `m2-schema-contract.test.ts` T-25 钉住。
--   派发件「没建」这一现场事实不成立，本迁移不重复建它（重复建会 `index ux_sug_term already exists`）。
--   ⚠️ 连带结论：§四-3 的「evidence_repair 每 revision 只能一行」**不因为这条索引而解开**——
--   0003:618 的表级 `UNIQUE(kind, relation_type, endpoint_a, endpoint_b)` 比它更粗（同一 (kind, 端点)
--   只能一行），§3.17 原文也明写这条表级 UNIQUE 保留。派发件第 ② 项同样要求「不删旧约束（0003 冻结）」。
--   所以粒度损失要解，只能整表重建 suggestion 去放宽 0003:618——那是 schema 文档之外的改动，交裁决，本轮不做。
--
-- ③ §3.7 的「当前视图」在库里没有视图对象，唯一定义是应用层的 SQL 表达式
--   （src/server/ingest/ingestService.ts 的 currentView，注释自证「§3.7 的唯一定义」）。
--   第三腿要的取值面 `user_confirmed_suggestion` 三张 Mention 表的 CHECK 早在 0003 就含它
--   （0003:377 / :448 / :509），且 0003:396-399 把「非 ai_generated ⇒ parse_run_id IS NULL」钉死——
--   腿本身合法，缺的是那条 OR。故 ③ 无 schema 改动，改在应用层表达式（见工作日志 §三）。
--   注意 `episode` / `thought_item` 的 origin_type CHECK 只有两值（0003:126 / :216），
--   §3.8/§3.9 也未给它们第三个 origin，所以这两张表的查询**无腿可扩**。
--
-- ① 新增列命名决定：`ai_title` / `ai_summary`。
--   §3.7 的 parse_run 字段表里没有标题/摘要列，全库与全部上游文档也无 `title` 列先例
--   （grep：`docs/dev-specs/M1-前置数据库Schema审查.md` 无 title 列；`ai_title`/`ai_summary` 此前全库 0 命中）。
--   这两个名字是**本轮的新增列命名决定**，非取自冻结件。带 `ai_` 前缀的理由：这两个值来自
--   `StructuredOutput.title/summary`（Provider 产出），与 `episode.summary`（§3.8，用户可 override 的派生文本）
--   是两个不同事实；不带前缀会让「run 说了什么」与「这条经历说了什么」在列名上撞车。
--   `TEXT NOT NULL DEFAULT ''`：空串 = 「没落过」（失败 run、回放、存量行）。不用 NULL——
--   禁可空键列的先例 P5（§3.17 头注），且可空列会把「没落过」与「落了个空」两种状态压成一种。
--
-- ④ trigger_assertion 逐字照 §3.16：id `trig_`（前缀早在 src/shared/contracts/ids.ts:25 就登记了
--   `triggerAssertion: "trig"`）；两条 FK 都 ON DELETE CASCADE；`created_by` CHECK 只许 'user'〔冻结 K-06〕；
--   `UNIQUE(emotion_mention_id, trigger_episode_id)`——同对唯一，不同触发经历可多条（§3.16 第 2 段）。
--   本轮**只建表**：触发认定的业务面属图谱，M3 已裁定推迟，不写任何服务层消费代码。
--   `deletion_audit.object_type` 的 17 值 CHECK 在 0002:104-124 冻结，实测**已含** 'trigger_assertion'
--   （0002:121），无需扩面，也不许扩 0002（逐字冻结）。
--   不加二级索引：§3.16 未列索引，`UNIQUE(emotion_mention_id, trigger_episode_id)` 已覆盖
--   「某 Mention 的全部触发认定」这条正向查询；反向（某 Episode 被哪些 Mention 认定为触发）
--   属图谱消费面，等 M4 真有查询再补，不提前造。
--
-- 可逆性声明：本迁移只做「加列 + 建新表」，不删列、不改既有表定义、不动任何既有触发器与索引，
--   因此不存在「回滚到 0006 才能跑」的步骤；schema 层历来前向迁移、无 down 脚本，此处仅作声明。

-- ── ① §3.7 parse_run：AI 标题/摘要落库处（M2 验收报告 §四-4；PROJ-1「事后取回」的前提）──
-- 值来自 ingestService.commitDerived 的成功路径（候选 run 也写：事后取回问的是「那次解析说了什么」，
-- 与 result_state 无关）。ADD COLUMN 对既有行一律填 DEFAULT ''，不回填任何猜测值。
ALTER TABLE parse_run ADD COLUMN ai_title TEXT NOT NULL DEFAULT '';
ALTER TABLE parse_run ADD COLUMN ai_summary TEXT NOT NULL DEFAULT '';

-- ── ④ §3.16 触发认定（TriggerAssertion）──────────────────────────────
-- 关系**针对具体 EmotionMention 行**而非共享 Concept：外键即 mention id，schema 结构天然保证（§3.16 第 2 段）。
-- created_at_utc 的 UTC 格式 CHECK 沿用每张表的同一形态（0002 起的全部业务表皆如此）。
CREATE TABLE trigger_assertion (
  id TEXT PRIMARY KEY,
  emotion_mention_id TEXT NOT NULL,
  trigger_episode_id TEXT NOT NULL,
  -- 冻结 K-06：非 user 写入被数据库拒绝（T-03）。
  created_by TEXT NOT NULL CHECK (created_by = 'user'),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'trig_*'),
  UNIQUE (emotion_mention_id, trigger_episode_id),
  FOREIGN KEY (emotion_mention_id) REFERENCES emotion_mention (id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_episode_id) REFERENCES episode (id) ON DELETE CASCADE
) STRICT;
