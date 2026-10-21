-- 0006_entity_types_v2.sql —— 实体大类 8 类落地〔用户裁定 Q3，2026-10-14〕
-- 冻结来源：docs/dev-specs/2026-10-14-图谱推迟与功能取舍清单.md §六之二（Q3 已定）
--   · `game` 并入 `work` —— 游戏是作品的一种，单独占一个大类不成体系。
--   · 新增 `activity`（活动：跑步、爬山、旅行）与 `event`（事件：春节、生日、考试）——
--     这类对象会反复出现在很多条记录里，按旧的 7 类只能掉进「其他」，就永远长不出来。
--   · 最终集合 = person / organization / place / work / product / activity / event / other，
--     逐项与 src/shared/constants/enums.json 的 `entity_types` 同序（T-16 对账）。
--
-- 为什么又是整表重建（与 0005 同一形态，不是可选项）：
--   1. 0003 / 0005 已提交 → 受 sha256 漂移守护，不得就地改（执行准则 §八 + E-04）。
--   2. SQLite 不支持 ALTER TABLE 增删 CHECK 约束。
--
-- 本次动两张表：
--   A. `entity`               —— entity_type 的 CHECK 从 7 值改 8 值（定义面在 0003:318-343）。
--   B. `user_scalar_override` —— §3.18 取值门里 `entity_type` 那条 IN 清单同步为 8 值（定义面在 0005:87-95）。
--
-- ── 引用面清单（谁引用谁，决定拆建顺序）───────────────────────────────
-- entity 自身：无索引、无视图。
-- **入向外键**（子表，重建窗口内父表 momentarily 不存在，靠 defer_foreign_keys 跨过）：
--     entity_alias.entity_id   → entity(id) ON DELETE RESTRICT
--     entity_mention.entity_id → entity(id) ON DELETE RESTRICT
-- 挂在 entity 上的触发器（**必须先摘**：DROP TABLE 前会对该表做一次隐式 DELETE，
--   这两个触发器会照着「实体消失」的语义去清 graph_edge 与 user_scalar_override 的行——
--   那是数据丢失，不是重建）：
--     graph_edge_entity_ad（0003:767）、ovo_entity_ad（0005:248）
-- 挂在 user_scalar_override 上的触发器（随 DROP TABLE 一起消失，末尾原样重建）：
--     ovo_target_bi、ovo_target_bu（0005:127/178）
-- 触发器**体**里引用 entity 或 user_scalar_override、但挂在别的表上的（本次不摘）：
--     graph_edge_endpoints_bi / _bu（ON graph_edge，体内 SELECT ... FROM entity）
--     ovo_episode_ad / ovo_thought_ad / ovo_concept_ad（ON 各自目标表，体内 DELETE FROM user_scalar_override）
--   为什么不摘：本文件**不做 ALTER TABLE ... RENAME**（形态见下），这两个表的名字在
--   DROP → CREATE 之间只空了一句话，窗口内没有任何语句会触发它们，也就不会去解析那个
--    momentarily 缺失的表名。0005 之所以必须摘六个，正是因为它走了 RENAME ——
--   实测「error in trigger …: no such table: …」是 RENAME 的校验，不是 DROP 的。
--   落地后这两个仍照常守门，由 tests/m3-db-1-entity8.test.ts 逐条钉住。
--
-- ── 为什么是「备份中转 + 同名重建」而不是 0005 的「建新名 → RENAME」────────
-- 两条路都被实测过（scratch/fk-probe-*.ts），RENAME 那条对本表不可行：
--   · `PRAGMA foreign_keys = OFF` 在事务里是空操作，而迁移由 migrator 包在
--     BEGIN IMMEDIATE 内 —— 官方 12 步流程里「先关外键」这一条在本项目做不到。
--   · `defer_foreign_keys = ON` 能让 DROP 父表通过，但延迟账目在 COMMIT 处仍按被删的
--     表对象复验：DROP → 建新名 → RENAME 回原名，COMMIT 依旧 `FOREIGN KEY constraint failed`。
--   · `legacy_alter_table = ON`（事务内有效）能躲开引用改写，但 RENAME 之后 DROP 让位的旧表
--     同样在 FK 上失败。
--   · 子表若要不重建，唯一可行的形态就是**父表名以同名恢复**：DROP 旧表 → 立刻按同名建 8 值新表
--     → 从备份回填。这样子表的 `REFERENCES entity (id)` 文本全程不改写、不需要重建 entity_alias /
--     entity_mention（省掉两份会漂移的 DDL 副本），COMMIT 时按名字复验通过。实测见
--     scratch/fk-probe-s.ts：行、外键 RESTRICT、触发器守门、新 CHECK 全部照常生效。
-- 代价：中转用的备份表是普通堆表（CTAS 不继承 STRICT/CHECK），但它只活三句话，
--   且回填走具名列 SELECT，末尾由 FK 守卫与测试各自复验。
--
-- ── 存量 `game` 行的归一（裁定语义，不是随手改数据）───────────────────
-- Q3 裁定的是「game **并入** work」，不是「新增一个值顶替旧值」。所以拷贝步骤把
-- `entity_type = 'game'` 落成 `'work'`，`user_scalar_override` 里 entity_type 的 JSON 值同法。
-- 不归一同时坏三处：新 CHECK 直接拒绝旧行（整份迁移失败回滚，现网升不上去）；库里残留的
-- 'game' 既不在封闭枚举里也不在标签表里；privacy/redaction 会对它抛
-- 「实体 … 的 entity_type 不在封闭集内」（src/server/privacy/redaction.ts:157）。
-- 这不是「静默篡改用户的修正」——用户改口说「这算作品」，落成的正是 work。
--
-- 与 0005 同一立场：存量行里若有既非 8 值又非 game 的脏值，拷贝会让整份迁移失败并回滚。
-- 宁可拒绝迁移，也不静默丢弃。

-- ── 第 0 步：外键判定推迟到 COMMIT（见上面引用面清单）──────────────────
PRAGMA defer_foreign_keys = ON;

-- ── 第 1 步：摘掉四个必须摘的触发器 ──────────────────────────────────
DROP TRIGGER graph_edge_entity_ad;
DROP TRIGGER ovo_entity_ad;
DROP TRIGGER ovo_target_bi;
DROP TRIGGER ovo_target_bu;

-- ── 第 2 步：entity 现有行中转（具名列，列序变化不会静默错位）────────
CREATE TABLE entity_v6_backup AS
SELECT id,
  entity_type,
  canonical_name,
  display_name,
  lifecycle_status,
  privacy_level,
  origin_type,
  created_at_utc
FROM entity;

-- ── 第 3 步：删旧表、以同名建 8 值新表 ──────────────────────────────
DROP TABLE entity;

CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'person',
      'organization',
      'place',
      'work',
      'product',
      'activity',
      'event',
      'other'
    )
  ),
  canonical_name TEXT NOT NULL CHECK (length(canonical_name) >= 1),
  display_name TEXT NOT NULL CHECK (length(display_name) >= 1),
  lifecycle_status TEXT NOT NULL DEFAULT 'provisional' CHECK (
    lifecycle_status IN ('provisional', 'active', 'archived')
  ),
  privacy_level TEXT NOT NULL DEFAULT 'normal' CHECK (privacy_level IN ('normal', 'sensitive')),
  origin_type TEXT NOT NULL CHECK (origin_type IN ('ai_generated', 'user_created')),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'entity_*')
) STRICT;

-- ── 第 4 步：回填，game 在此并入 work ───────────────────────────────
INSERT INTO entity (
  id,
  entity_type,
  canonical_name,
  display_name,
  lifecycle_status,
  privacy_level,
  origin_type,
  created_at_utc
)
SELECT id,
  CASE WHEN entity_type = 'game' THEN 'work' ELSE entity_type END,
  canonical_name,
  display_name,
  lifecycle_status,
  privacy_level,
  origin_type,
  created_at_utc
FROM entity_v6_backup;

DROP TABLE entity_v6_backup;

-- ── 第 5 步：user_scalar_override 现有行中转 ────────────────────────
CREATE TABLE user_scalar_override_v6_backup AS
SELECT id,
  object_table,
  object_id,
  field_name,
  value_json,
  updated_at_utc
FROM user_scalar_override;

-- ── 第 6 步：删旧表、以同名建新表（列与 0005 逐字一致，只取值门换 8 值）──
DROP TABLE user_scalar_override;

CREATE TABLE user_scalar_override (
  id TEXT PRIMARY KEY,
  object_table TEXT NOT NULL CHECK (
    object_table IN ('episode', 'thought_item', 'concept', 'entity')
  ),
  object_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(updated_at_utc, 1, 19)) IS NOT NULL
    AND updated_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'ovo_*'),
  -- field_name 白名单 CASE CHECK（§3.18 逐字，四分支本次都不动）。
  CHECK (
    CASE object_table
      WHEN 'episode' THEN field_name IN (
        'summary',
        'event_time_raw',
        'event_time_precision',
        'event_time_certainty'
      )
      WHEN 'thought_item' THEN field_name IN ('text')
      WHEN 'concept' THEN field_name IN ('canonical_name')
      WHEN 'entity' THEN field_name IN ('display_name', 'canonical_name', 'entity_type')
      ELSE 0
    END
  ),
  -- 取值门：本次唯一变化是 entity_type 那条 IN 清单随 enums.json 的 `entity_types` 改 8 值。
  -- NULL 安全形态与 0005 同（先 json_type(value_json)='text' 再比字面量），ELSE 1 的语义也不动。
  CHECK (
    CASE field_name
      WHEN 'event_time_precision' THEN json_type(value_json) = 'text' AND json_extract(value_json, '$') IN (
        'year',
        'month',
        'day',
        'unknown'
      )
      WHEN 'event_time_certainty' THEN json_type(value_json) = 'text' AND json_extract(value_json, '$') IN (
        'explicit',
        'approximate',
        'unknown'
      )
      WHEN 'entity_type' THEN json_type(value_json) = 'text' AND json_extract(value_json, '$') IN (
        'person',
        'organization',
        'place',
        'work',
        'product',
        'activity',
        'event',
        'other'
      )
      ELSE 1
    END
  ),
  UNIQUE (object_table, object_id, field_name)
) STRICT;

-- ── 第 7 步：回填，entity_type 的 game 同法并入 work ─────────────────
INSERT INTO user_scalar_override (
  id,
  object_table,
  object_id,
  field_name,
  value_json,
  updated_at_utc
)
SELECT id,
  object_table,
  object_id,
  field_name,
  CASE
    WHEN field_name = 'entity_type'
    AND json_type(value_json) = 'text'
    AND json_extract(value_json, '$') = 'game' THEN '"work"'
    ELSE value_json
  END,
  updated_at_utc
FROM user_scalar_override_v6_backup;

DROP TABLE user_scalar_override_v6_backup;

-- ── 第 8 步：四个触发器原样重建（定义与 0003 / 0005 逐字一致） ───────
-- 端点消失 ⇒ 引用它的边一并清除（§5 矩阵「端点 D ⇒ 边 D（CASCADE）」的多态等价实现）。
CREATE TRIGGER graph_edge_entity_ad AFTER DELETE ON entity BEGIN
  DELETE FROM graph_edge
  WHERE
    (src_kind = 'entity' AND src_id = OLD.id)
    OR (dst_kind = 'entity' AND dst_id = OLD.id);
END;

-- 目标行删除 ⇒ 引用它的 override 一并清除（§3.18 尾段：不留孤儿）。
CREATE TRIGGER ovo_entity_ad AFTER DELETE ON entity BEGIN
  DELETE FROM user_scalar_override
  WHERE
    object_table = 'entity' AND object_id = OLD.id;
END;

-- 目标存在性 + 目标可修正性：override 只能指向存在的、且不是 candidate 的行（§3.18 P4b）。
CREATE TRIGGER ovo_target_bi BEFORE INSERT ON user_scalar_override BEGIN
  SELECT CASE
    WHEN NEW.object_table = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.object_id
        AND (
          parse_run_id IS NULL
          OR parse_run_id IN (
            SELECT id
            FROM parse_run
            WHERE result_state = 'current'
          )
        )
    ) THEN RAISE(
      ABORT,
      'user_scalar_override.object_id 指向不存在的 episode，或其所在 run 非 current（候选行不可被修正）'
    )
    WHEN NEW.object_table = 'thought_item'
    AND NOT EXISTS (
      SELECT 1
      FROM thought_item
      WHERE id = NEW.object_id
        AND (
          parse_run_id IS NULL
          OR parse_run_id IN (
            SELECT id
            FROM parse_run
            WHERE result_state = 'current'
          )
        )
    ) THEN RAISE(
      ABORT,
      'user_scalar_override.object_id 指向不存在的 thought_item，或其所在 run 非 current（候选行不可被修正）'
    )
    WHEN NEW.object_table = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.object_id
    ) THEN RAISE(ABORT, 'user_scalar_override.object_id 指向不存在的 concept')
    WHEN NEW.object_table = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.object_id
    ) THEN RAISE(ABORT, 'user_scalar_override.object_id 指向不存在的 entity')
  END;
END;

CREATE TRIGGER ovo_target_bu BEFORE UPDATE ON user_scalar_override BEGIN
  SELECT CASE
    WHEN NEW.object_table = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.object_id
        AND (
          parse_run_id IS NULL
          OR parse_run_id IN (
            SELECT id
            FROM parse_run
            WHERE result_state = 'current'
          )
        )
    ) THEN RAISE(
      ABORT,
      'user_scalar_override.object_id 指向不存在的 episode，或其所在 run 非 current'
    )
    WHEN NEW.object_table = 'thought_item'
    AND NOT EXISTS (
      SELECT 1
      FROM thought_item
      WHERE id = NEW.object_id
        AND (
          parse_run_id IS NULL
          OR parse_run_id IN (
            SELECT id
            FROM parse_run
            WHERE result_state = 'current'
          )
        )
    ) THEN RAISE(
      ABORT,
      'user_scalar_override.object_id 指向不存在的 thought_item，或其所在 run 非 current'
    )
    WHEN NEW.object_table = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.object_id
    ) THEN RAISE(ABORT, 'user_scalar_override.object_id 指向不存在的 concept')
    WHEN NEW.object_table = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.object_id
    ) THEN RAISE(ABORT, 'user_scalar_override.object_id 指向不存在的 entity')
  END;
END;

-- ── 第 9 步：FK 面自检（把违规变成事务失败，而不是打印一行就过去） ────
-- `PRAGMA foreign_key_check` 只返回结果集、不报错，而 migrator 是在 COMMIT **之后**才跑它——
-- 那时半迁移的库已经落盘了。故这里用一条「有违规就必然违反 CHECK」的条件插入守门：
-- pragma_foreign_key_check 是表值函数，count(*) 非 0 ⇒ CHECK(violation_count = 0) 失败
-- ⇒ defer_foreign_keys 在 COMMIT 前就被这条错误顶掉，整份迁移回滚，不留半迁移的库。
-- 守卫表随即删除，不进最终 schema（m0 的表集合断言因此不受影响）。
CREATE TABLE _fk_guard_after_rebuild (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

INSERT INTO _fk_guard_after_rebuild
SELECT count(*)
FROM pragma_foreign_key_check;

DROP TABLE _fk_guard_after_rebuild;
