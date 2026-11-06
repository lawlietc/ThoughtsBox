-- 0010_privacy_job.sql —— M6-0E 第一批：后台任务队列的存储层（草案 §二 逐字落实）
-- 冻结来源：docs/dev-specs/2026-10-23-M6-0E-后台任务队列设计草案.md
--   · §二 表结构：列集合、`UNIQUE(idempotency_key)`、`snapshot_json` 的 json_valid、FK CASCADE、STRICT。
--   · §三 状态机：`queued/redacting/analyzing/done/failed/canceled` 六值。
--   · §四 恢复与僵尸任务：每次推进写 `updated_at_utc`，租约过期的行由启动扫描回收。
--   · §五 失败分类：`error_kind` 五值决定「是否消耗 attempts」。
--   · §八 断言 1/2/3/7/8/9 的物理载体就是这张表 + `src/server/jobs/jobStore.ts`。
--
-- ── 为什么是「新建表、不重建任何既有表」────────────────────────────────
-- 0005/0008/0009 那三次整表重建各有一个不可回避的动因：改 NOT NULL、换 UNIQUE 键、加组合 CHECK
-- ——SQLite 不支持就地增删列约束，只能重建。本次一条都没有：
--   1. **新子系统**：`privacy_job` 之前不存在，没有任何存量行需要回填或迁移（0009 需要回填
--      `send_content_mode='redacted'`，这里无此负担）。
--   2. **无入向外键**：grep 0001–0009，没有任何表 REFERENCES privacy_job（它还没出生）。
--      因此不需要 0008 那套「事务外关外键 + 守卫表」——DROP 风险面为空。
--   3. 出向外键只有一条（record_revision_id），方向朝外，指向的是**已存在且不改动**的父表。
-- 于是本文件就是 `CREATE TABLE` + `CREATE INDEX`，全程待在 migrator 的 BEGIN IMMEDIATE 里，
-- 不动任何 pragma。
--
-- ── 为什么 `status` 不进 enums.json（本仓库的枚举契约不在这里）──────────
-- `enums.json` 承载的是**记录级领域生命周期**：`processing_statuses`（8 值）、
-- `lifecycle_states.*`（含 `ParseRun.execution_status`）都在 `validateEnums` 的转换表核对之下
-- （`src/shared/contracts/enums.ts` I3 段）。`privacy_job.status` 是**调度语义**——排队、取消、
-- 租约、退避——不是某条用户记录的生命周期阶段。三个理由让它留在 enums 之外：
--   1. 塞进去会让「谁是执行阶段的权威」更糊（见下面 §一-3 的分工），而草案 §一-3 要的正是把它分清。
--   2. 改 `enums.json` 就是改枚举契约本身：`processing_status_transitions` 的核对会跟着动，
--     影响面远超一个新子系统。
--   3. 0D 已经确立了同形做法：取值域写成**模块局部 `as const`** + 迁移里的 CHECK，
--     再由一条**静态对账测试**把两边钉成同源（`GRANT_SEND_CONTENT_MODES` vs 0009 的 CHECK，
--     `tests/m6-0d-raw-grant.test.ts` §G）。本表照此办理：`JOB_STATUSES` / `JOB_ERROR_KINDS`
--     vs 下面的 CHECK 清单，钉在 `tests/m6-0e-job-store.test.ts`。
-- 「同源」靠测试成立，不靠手抄两份——任一漂移即红。
--
-- ── 与 parse_run.execution_status 的分工（草案 §一-3，不造第三套执行态）──
--   · `parse_run.execution_status`（0003:72-74）= 一次**模型执行**走到哪的唯一权威
--     （queued/running/succeeded/failed）。
--   · `privacy_job.status` = 一次**后台调度**走到哪，只承载 run 没有的语义：排队顺序、取消请求、
--     租约到期、退避重试。它与 run 通过 `record_revision_id`（+ 将来的 pipeline_fingerprint）关联。
--   · 记录级 `capture_record.processing_status` 由队列推进，映射写在
--     `jobStore.recordProcessingStatusForJobStatus()`（纯函数 + 全量覆盖测试）。
--     第一批**不接线**到任何写入路径：映射表先立起来，落点留给 worker 那一批。
--   这张表本身不写 run、不写 record：它是纯粹的调度行。
--
-- ── 两个 ID 列，为什么都留着 ──────────────────────────────────────
-- `record_revision_id` 是**权威挂接**（FK + CASCADE + 幂等键的第一段）；`record_id` 是草案 §二
-- 自带的**冗余列**，服务两件不需要 join 的查询：按记录列任务（UI 轮询）与「新 revision 入队 ⇒
-- 旧 revision 的 queued 转 canceled」（§三 supersede）。冗余的代价是它可能与 revision 脱指，
-- 所以这里**不加 FK**（草案 §二 也没加）：加 FK 需要 `record_id` 指向 capture_record，而记录硬删除
-- 路径按 revision 逐层清理，任务行的消失由 `record_revision_id` 那条 CASCADE 负责——
-- 两条 FK 指向同一对父子关系只会增加失败模式，不增加约束。写入侧由服务层保证同源
-- （`enqueue` 从 revision 现读 record_id，不接受调用方声称的值），见 `jobStore.ts`。
--
-- ── 不进导出、不进删除审计（草案 §二 要点 + §八 断言 9）──────────────────
--   · JSONL 导出的对象集合是显式白名单（`src/server/backup/jsonl.ts` 的 RECORD_COLUMNS /
--     REVISION_COLUMNS），`privacy_job` 不在其中，也不得加入：任务行属于「这个数据库文件」的
--     运行期调度状态，跨安装重放它们等于在新机器上凭空造出一批待跑任务。快照备份整库携带，
--     与 `deletion_audit` / `app_meta` 同一口径。
--   · `deletion_audit.object_type`（0002:104-124）的 17 值封闭集**不含** privacy_job：那一列
--     记的是「用户硬删除了某个业务对象」。任务行不是用户对象，只随 revision 级联消失；
--     0002 冻结不可改，本批也不需要改它。
--   · 表里不存原文、不存脱敏文本、不存原文↔脱敏映射：只有 ID、版本标识、取值标签与时间戳。
--     `snapshot_json` 的字段集合是封闭的三轴 + 四个版本标识（`JOB_SNAPSHOT_FIELDS`），
--     由 `tests/m6-0e-job-store.test.ts` 断言 9 钉住「入参类型不含任何文本字段」。
--     配置快照的意义（§二）：入队时定格，执行只读快照，配置漂移不能让老任务按新配置跑。
--
-- 可逆性声明：前向迁移、无 down 脚本（schema 层历来如此）。本文件只新增一张表与两个索引，
-- 不改任何其它表；m0 的表集合断言与 m3-db-2 的「一路升到 HEAD」清单是本次的两个既有测试同步点。

CREATE TABLE privacy_job (
  id TEXT PRIMARY KEY,
  -- 冗余的记录指针（见头注「两个 ID 列」）：不加 FK，权威挂接在 record_revision_id 那条。
  record_id TEXT NOT NULL,
  record_revision_id TEXT NOT NULL,
  -- 草案 §二 逐字：`<record_revision_id>:<prompt_version>:<schema_version>:<model_id>:<redaction_policy_version>`。
  -- 同一 revision + 同一套配置只允许一行；配置变了就是另一行（旧行由 §三 的 supersede 转 canceled）。
  idempotency_key TEXT NOT NULL,
  -- 调度语义六值；与 parse_run.execution_status 是两个定义域（头注分工段）。
  -- 取值域与 `JOB_STATUSES` 由 tests/m6-0e-job-store.test.ts 的静态对账钉成同源。
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'redacting',
      'analyzing',
      'done',
      'failed',
      'canceled'
    )
  ),
  -- 已尝试次数（草案 §五）。语义只有一处落点：`jobStore.transition(..., {attemptsDelta})`。
  -- 消耗与否则由 `consumesAttempt(error_kind)` 判：provider_unavailable / provider_loading 不消耗。
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- 五值失败分类（§五）。NULL = 尚未失败过；它不是「失败原因的自由文本」，故保持封闭集。
  error_kind TEXT CHECK (
    error_kind IS NULL
    OR error_kind IN (
      'provider_unavailable',
      'provider_loading',
      'timeout',
      'invalid_output',
      'internal'
    )
  ),
  -- 取消请求位（§五）：在途态只能被「请求取消」，由 worker 在检查点收尾；queued 才直接置 canceled。
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  -- 入队时的配置快照：三轴 + 版本标识，不含任何文本本体（§二 要点）。
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  -- 每次状态推进必须写它（§四：不允许出现永远 running 的任务；租到期判据就是这一列）。
  updated_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(updated_at_utc, 1, 19)) IS NOT NULL
    AND updated_at_utc LIKE '%Z'
  ),
  started_at_utc TEXT CHECK (
    started_at_utc IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%S', substr(started_at_utc, 1, 19)) IS NOT NULL
      AND started_at_utc LIKE '%Z'
    )
  ),
  finished_at_utc TEXT CHECK (
    finished_at_utc IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%S', substr(finished_at_utc, 1, 19)) IS NOT NULL
      AND finished_at_utc LIKE '%Z'
    )
  ),
  CHECK (id GLOB 'pjob_*'),
  UNIQUE (idempotency_key),
  -- §二：删除 revision ⇒ 任务行级联消失（断言 8），不留孤儿任务。
  FOREIGN KEY (record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE
) STRICT;

-- 调度取任务（`status='queued' AND cancel_requested=0` 取最早）与恢复扫描
-- （`status IN ('redacting','analyzing')` 逐状态比 `updated_at_utc`）共用这一条：
-- status 是等值谓词，created_at_utc 是排序列，两者都在索引里才能免排序取前一行。
CREATE INDEX ix_privacy_job_dispatch ON privacy_job (status, created_at_utc);

-- 断言 7 的 supersede 与 UI 轮询都按记录取任务；没有它就得全表扫。
CREATE INDEX ix_privacy_job_record ON privacy_job (record_id);
