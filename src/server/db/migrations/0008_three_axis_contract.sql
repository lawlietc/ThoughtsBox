-- 0008_three_axis_contract.sql —— M6-0C：记录级三轴契约落地（analysis_provider / redaction_mode / send_content_mode）
-- 冻结来源：docs/dev-specs/2026-10-23-M6-0C-三轴契约设计草案.md
--   · §二 三轴定义与取值
--   · §三 合法组合矩阵 + 派生规则（本文件的组合 CHECK 逐条照此写，不逐行 if）
--   · §四 旧值映射（存量三值一次性回填，此后三轴是事实源）
--   · §五 已拍板：processing_mode **保留列**但降级为派生兼容字段；新增第 4 个枚举值 cloud_raw
--   · §八-2 三轴取值进 enums.json 单一事实源，本文件的字面量与之逐项一致（E-07 / T-16 对账）
--   · §八之二-1 send_content_mode 有两个定义域：本文件只落**记录轴**（三值）。
--     `cloud_send_grant.send_content_mode` 列（两值 redacted|raw）属 0D，本次不碰授权表。
--   · §八之三 取值域保留完整：redaction_mode=local_llm 与 analysis_provider=local 是**占位/自备**值，
--     仍进 CHECK（否则重启该路线时要再升一次契约），但 v1 无实现，写入由上层闸门显式拒绝。
--
-- ── 为什么是整表重建（与 0006 同一形态，不是可选项）────────────────────────
--   1. 0002 已提交 → 受 sha256 漂移守护，不得就地改（执行准则 §八 + E-04）。
--   2. SQLite 不支持 ALTER TABLE 增删 CHECK 约束；本次既扩 processing_mode 的 CHECK，
--      又加三条列级 CHECK 与一条表级组合/派生 CHECK。ALTER ADD COLUMN 带 CHECK 只能约束新行、
--      无法回改既有列定义，且 processing_mode 的 CHECK 就在旧定义里 —— 只能重建。
--   3. 0006 实测结论沿用：`PRAGMA foreign_keys = OFF` 在事务里是空操作；「建新名 → RENAME 回原名」
--      在 COMMIT 处仍按被删的表对象复验 FK 而失败。可行形态是**父表以同名恢复**：
--      DROP → 立刻同名建 4 值新表 → 从备份回填。
--   4. 但 0006 的那条前提在本次不成立，因此本次必须真的关掉外键（见下条实测）。
--
-- ── 为什么必须走「事务外 PRAGMA foreign_keys = OFF」——本次的新事实 ──────────
-- capture_record 的入向外键是 **ON DELETE CASCADE**（record_revision.record_id，0002:76），
-- 而 0005/0006 重建的两张表入向外键全是 RESTRICT。`DROP TABLE` 在执行前对该表做一次隐式
-- `DELETE FROM`，CASCADE 动作**立即**逐行删子表：defer_foreign_keys 只推迟「违规复验」，
-- 不推迟 FK 动作本身。实测（scratch/probe-0008-rebuild.mjs，库里有 2 条记录 + 2 个版本时）：
--   · 只靠 defer_foreign_keys → record_revision 被清空，capture_record 的 deferred 出向 FK
--     随即违规，本文件的守卫表把整份迁移顶掉（`violation_count = 0` 失败）。
--     也就是说：**没有这道守卫，升级就静默删光用户的全部版本与派生层。**
--   · legacy_alter_table=ON + 改名让位 → 同一守卫照样顶掉（与 0006 记录的实测一致）。
--   · 事务外 `PRAGMA foreign_keys = OFF` → 迁移通过、版本行原样保留、CASCADE 与 FTS 触发器
--     在重建后照常生效（子表 FK 文本仍是 `REFERENCES capture_record (id) ON DELETE CASCADE`）、
--     capture_record 的 deferred 出向 FK 仍拒绝悬空 current_revision_id。
-- 因为该 pragma 只在无事务时有效，本文件自己拆了事务边界（第 0 步 / 第 5b 步），
-- 并把 migrator 的 BEGIN IMMEDIATE 重新接上，使它照常写 schema_migrations 并 COMMIT。
-- 失败面：migrator 的 catch 在 ROLLBACK 后恢复 `foreign_keys = ON`（src/server/db/migrator.ts），
-- 免得带外键关闭的连接在异常路径上继续活着。
-- 原子性代价：schema 变更与版本号记录分成两次提交。崩溃落在两者之间时，下一次启动会重跑本文件，
-- 而重跑是安全的——备份表按具名列取现有行、新表按同一映射回填，行内容与三轴取值都不变；
-- 迁移报告因此写成 upsert，不再因为主键冲突把升级卡死。
--
-- ── 引用面清单（谁引用谁，决定重建窗口）────────────────────────────────────
-- capture_record 自身：两条索引 ix_capture_record_created_utc / ix_capture_record_local_date（随 DROP 消失，末尾原样重建）。
-- **入向外键**（子表，重建窗口内父表 momentarily 不存在）：
--     record_revision.record_id → capture_record(id) ON DELETE CASCADE（0002:76）
--   ← 这一条是本次与 0005/0006 的唯一实质差别，故窗口必须整段在**外键关闭**下运行（见上一节）；
--     窗口外的 FK 复验由第 5 步的守卫表显式承担，不靠 COMMIT 的自动检查。
-- 挂在 capture_record 上的触发器：**无**（0002 的三个 FTS 触发器挂在 record_revision 上，本次不动那张表）。
-- 触发器**体**里引用 capture_record 的：无（grep 0003–0007 对 capture_record 零命中，故本次一个触发器都不用摘）。
-- capture_record 自身的出向 deferred 复合 FK → record_revision(id, record_id)：新表定义里原样保留（0002:48-50 逐字）。
--
-- ── 存量行的三轴回填（§四，语义不是随手改数据）────────────────────────────
--   manual_only    → (none,   manual, none)      行为不变
--   local_model    → (local,  manual, none)      行为有变：本地模型此前看原文，R2 起看脱敏文本（须在发布说明点名）
--   cloud_redacted → (cloud,  manual, redacted)  行为不变
--   不在三值内的脏数据 → 按 manual_only 处理，并把行数写进 app_meta 迁移报告（§四 末段）。
--     现场事实：0002 的 CHECK 已把 processing_mode 钉在三值内，脏值不可能进过库；
--     这条 ELSE 分支是「契约不依赖现场运气」的兜底 —— 命中即回填成 manual_only，同时报告行数不为 0，
--     而不是让 CHECK 拒绝整份迁移（回滚一个只加列的迁移，用户会卡在升级路上）。
--   回填后 processing_mode 逐字保留旧值，由表级派生 CHECK 保证「派生列与旧值一致」（§七 断言 2 的库内面）。
--
-- 可逆性声明：前向迁移、无 down 脚本（schema 层历来如此）。本文件不删任何列、不改任何其它表。

-- ── 第 0 步：交出 migrator 的事务，在事务外关掉外键，再自开一个事务 ──────
-- migrator 已经在 BEGIN IMMEDIATE 里（此前本文件未写过任何东西，空提交无损）。CASCADE 的隐式
-- DELETE 只能靠 foreign_keys=OFF 挡住，而该 pragma 在事务里是空操作 —— 所以必须先出去。
COMMIT;
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- ── 第 1 步：现有行中转（具名列，列序变化不会静默错位）────────────────
CREATE TABLE capture_record_v8_backup AS
SELECT id,
  created_at_utc,
  created_at_local,
  timezone_id,
  created_local_date,
  current_revision_id,
  processing_status,
  processing_mode,
  privacy_level
FROM capture_record;

-- ── 第 1b 步：迁移报告（§四 末段「列出行数」）────────────────────────
-- 从备份表现算，两个计数：回填总行数 + 落进 manual_only 兜底分支的脏值行数。
-- 键名带迁移编号前缀，不与运行期的 preview_* / contracts_fingerprint / backup_index 撞面。
-- 写成 upsert：崩溃落在「schema 已改、版本号未记」之间时本文件会重跑一次，主键冲突不该把
-- 用户的升级路卡死（文件头 原子性代价 一段）。SQLite 的 upsert 子句只挂在 VALUES 形态上
-- （INSERT ... SELECT 后面写 ON CONFLICT 直接语法错误），所以计数走标量子查询。
INSERT INTO app_meta (key, value, updated_at) VALUES (
  'migration_0008_three_axis_backfill',
  (
    SELECT json_object(
      'rows_backfilled',
      count(*),
      'dirty_processing_mode_rows',
      sum(CASE WHEN processing_mode IN ('manual_only', 'local_model', 'cloud_redacted') THEN 0 ELSE 1 END),
      'contract',
      'docs/dev-specs/2026-10-23-M6-0C-三轴契约设计草案.md §四'
    )
    FROM capture_record_v8_backup
  ),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- ── 第 2 步：删旧表、以同名建 4 值新表 + 三轴列 ───────────────────────
DROP TABLE capture_record;

CREATE TABLE capture_record (
  id TEXT PRIMARY KEY,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  created_at_local TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_local, 1, 19)) IS NOT NULL
    AND (created_at_local LIKE '%Z' OR substr(created_at_local, -6, 1) IN ('+', '-'))
  ),
  timezone_id TEXT NOT NULL CHECK (length(timezone_id) >= 1),
  created_local_date TEXT NOT NULL CHECK (
    created_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND strftime('%Y-%m-%d', created_local_date) IS NOT NULL
  ),
  current_revision_id TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'captured' CHECK (
    processing_status IN (
      'captured',
      'awaiting_privacy_review',
      'preprocessing',
      'processing',
      'parsed',
      'failed',
      'needs_reparse',
      'not_processed'
    )
  ),
  -- 派生兼容字段（§五）：写入方由三轴派生，读取方（DTO / UI / trace 兼容面）继续可用。
  -- 本次唯一变化是 CHECK 从 3 值扩 4 值，字面量顺序与 enums.json 的 processing_modes 逐项同序。
  processing_mode TEXT NOT NULL DEFAULT 'manual_only' CHECK (
    processing_mode IN ('manual_only', 'local_model', 'cloud_redacted', 'cloud_raw')
  ),
  privacy_level TEXT NOT NULL DEFAULT 'normal' CHECK (privacy_level IN ('normal', 'sensitive')),
  -- 三轴（草案 §二）：列名与 enums.json 的 analysis_providers / redaction_modes / send_content_modes 同源。
  -- DEFAULT 是「不外发」那一侧的取值：缺省必须是保守形态，新列不能因为漏写就把原文送出去。
  analysis_provider TEXT NOT NULL DEFAULT 'none' CHECK (
    analysis_provider IN ('local', 'cloud', 'none')
  ),
  redaction_mode TEXT NOT NULL DEFAULT 'manual' CHECK (
    redaction_mode IN ('local_llm', 'manual', 'none')
  ),
  send_content_mode TEXT NOT NULL DEFAULT 'none' CHECK (
    send_content_mode IN ('redacted', 'raw', 'none')
  ),
  CHECK (id GLOB 'rec_*'),
  -- §三 派生规则逐条落 CHECK（不是 12 行 if）：
  --   raw ⟺ cloud ∧ ¬none(redaction) / redacted ⟹ cloud ∧ ¬none(redaction) /
  --   none ⟺ analysis_provider ≠ cloud / local ⟹ redaction_mode ≠ none（矩阵 #6，R2 裁决）
  CHECK (
    CASE send_content_mode
      WHEN 'raw' THEN analysis_provider = 'cloud'
      AND redaction_mode = 'none'
      WHEN 'redacted' THEN analysis_provider = 'cloud'
      AND redaction_mode <> 'none'
      ELSE analysis_provider <> 'cloud'
      AND NOT (
        analysis_provider = 'local'
        AND redaction_mode = 'none'
      )
    END
  ),
  -- §五 派生规则：processing_mode 必须等于三轴的派生结果。
  -- 这一条让「降级为派生字段」在库里就是事实，而不是约定：写了 (cloud,none,raw) 却标 cloud_redacted 的行，
  -- 数据库直接拒绝；因此 §七 断言 2「派生列与旧值一致」有库内保证，UI/DTO 兼容面不可能说谎。
  -- 合法性 CHECK 与这条相互独立地求值：任何一条不成立都拒绝写入，所以不依赖求值顺序。
  CHECK (
    processing_mode = CASE
      WHEN analysis_provider = 'none' THEN 'manual_only'
      WHEN analysis_provider = 'local' THEN 'local_model'
      WHEN send_content_mode = 'raw' THEN 'cloud_raw'
      ELSE 'cloud_redacted'
    END
  ),
  FOREIGN KEY (current_revision_id, id)
    REFERENCES record_revision (id, record_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- ── 第 3 步：回填，三轴按 §四 旧值映射现算（脏值兜底见文件头）───────────
-- 三个 CASE 必须同构；表级派生 CHECK 是它们的一致性守卫：任一分支写歪，整份迁移失败回滚。
INSERT INTO capture_record (
  id,
  created_at_utc,
  created_at_local,
  timezone_id,
  created_local_date,
  current_revision_id,
  processing_status,
  processing_mode,
  privacy_level,
  analysis_provider,
  redaction_mode,
  send_content_mode
)
SELECT id,
  created_at_utc,
  created_at_local,
  timezone_id,
  created_local_date,
  current_revision_id,
  processing_status,
  CASE
    WHEN processing_mode IN ('manual_only', 'local_model', 'cloud_redacted') THEN processing_mode
    ELSE 'manual_only'
  END,
  privacy_level,
  CASE processing_mode
    WHEN 'local_model' THEN 'local'
    WHEN 'cloud_redacted' THEN 'cloud'
    ELSE 'none'
  END,
  -- §四 的三行旧值映射在 redaction_mode 这一轴上取值全同（都是 manual），所以这里是一个常量：
  -- 「规则/实体脱敏」正是旧 local_model 与 cloud_redacted 的既有形态，不是本次的新语义。
  'manual',
  CASE processing_mode
    WHEN 'cloud_redacted' THEN 'redacted'
    ELSE 'none'
  END
FROM capture_record_v8_backup;

DROP TABLE capture_record_v8_backup;

-- ── 第 4 步：两条索引原样重建（定义与 0002:53-54 逐字一致）────────────
CREATE INDEX ix_capture_record_created_utc ON capture_record (created_at_utc);
CREATE INDEX ix_capture_record_local_date ON capture_record (created_local_date);

-- ── 第 5 步：FK 面自检（把违规变成事务失败，而不是打印一行就过去）──────
-- 与 0006 同一手法，但本次**承担全部复验责任**：窗口内 foreign_keys=OFF，SQLite 在 COMMIT
-- 处不会自动检查外键（`PRAGMA foreign_key_check` 只返回结果集、不报错，而 migrator 在 COMMIT
-- **之后**才跑它）。所以这里用一条「有违规就必然违反 CHECK」的条件守门表，让本事务在 COMMIT
-- 前就被错误顶掉并整份回滚，不留半迁移的库。守卫表随即删除，不进最终 schema（m0 的表集合断言因此不受影响）。
CREATE TABLE _fk_guard_after_rebuild (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

INSERT INTO _fk_guard_after_rebuild
SELECT count(*)
FROM pragma_foreign_key_check;

DROP TABLE _fk_guard_after_rebuild;

-- ── 第 5b 步：收尾，把外键与事务都交回 migrator 的形态 ──────────────────
-- 先提交本事务（守卫已通过），再在事务外恢复 foreign_keys=ON —— 这是 applyPragmas 对每个连接
-- 的承诺（src/server/db/adapter.ts:52），不能让它停在这次迁移留下的关闭态。
-- 最后重新 BEGIN IMMEDIATE，让 migrator 照常 insert into schema_migrations 并 COMMIT；
-- 它的失败路径假定事务开着，这里必须给它留着。
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
