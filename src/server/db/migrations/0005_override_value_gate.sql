-- 0005_override_value_gate.sql —— §3.18 增补〔用户裁定 2026-10-13〕：修正层取值门 + entity_type 可修正
-- 冻结来源：docs/dev-specs/M1-前置数据库Schema审查.md §3.18 末段「增补〔用户裁定 2026-10-13〕」
--   · 缺口一（取值门）：原条款只要求 value_json 过 json_valid，白名单里的枚举型字段因此可写入枚举外取值
--     （M2-2 复核实测复现：event_time_precision = "瞎编的精度" 被接受）。与 enums.json
--     closed_set_rule「封闭枚举不得用字符串列 + 自由取值绕过 CHECK」直接冲突。
--   · 缺口二（entity_type 不可修正）：entity 表无 parse_run_id 列（0003:318-343），实体行永久存在、
--     重跑不重建，模型一次分类错误即永久固化。用户裁定：给用户改的地方，且只能在 7 个既定取值内选。
--
-- 为什么是整表重建（两条硬约束决定的形态，不是可选项）：
--   1. 0004 已提交 → 受 sha256 漂移守护，不得就地改（执行准则 §八 + E-04）。
--   2. SQLite 不支持 ALTER TABLE 增删 CHECK 约束 → 只能 建新表 → 拷贝既有行 → DROP → RENAME → 重建触发器。
--
-- 触发器恢复清单——六个全部先 DROP、改名完成后逐一重建，一个不留悬空：
--   挂在 user_scalar_override 上：ovo_target_bi、ovo_target_bu（DROP TABLE 本来就会连带删掉它们）
--   挂在四张目标表上：ovo_episode_ad、ovo_thought_ad、ovo_concept_ad、ovo_entity_ad
-- 后四个为什么也要摘：本任务前置实测——只要它们体内还引用着待改名的表，
-- `ALTER TABLE ... RENAME TO` 就会以「error in trigger ovo_episode_ad: no such table: main.user_scalar_override」失败。
-- 六个触发器的定义与 0004 逐字一致——本次增补只动 CHECK 与白名单，不动存在性/清理语义。
--
-- 存量行：既有 override 行必须原样拷贝过去（重建不是清表）。若库里存在违反新取值门的旧行，
-- 拷贝步骤会让整个迁移失败并回滚——这是有意的：宁可拒绝迁移，也不静默丢弃或篡改用户已提交的修正。
-- M2-2 至今服务层不写 override（写入路径归 M2-5），实际不存在此类存量行。
--
-- user_collection_patch 不动（§3.18 增补只针对标量覆盖面）。

-- ── 第一步：先摘掉六个触发器（重建段在最后） ─────────────────────────
DROP TRIGGER ovo_target_bi;
DROP TRIGGER ovo_target_bu;
DROP TRIGGER ovo_episode_ad;
DROP TRIGGER ovo_thought_ad;
DROP TRIGGER ovo_concept_ad;
DROP TRIGGER ovo_entity_ad;

-- ── 第二步：新表（列与 0004 逐字一致，两处 CHECK 增补见注） ──────────
CREATE TABLE user_scalar_override_new (
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
  -- field_name 白名单 CASE CHECK（§3.18 逐字）。object_table 已被上一段 CHECK 锁成四值，
  -- ELSE 0 只是纵深防御——若 CHECK 求值绕过，宁可明确拒绝，也不给三值逻辑 NULL 留缝（0003 偏差 (d) 同法）。
  -- 增补〔用户裁定 2026-10-13〕之二：entity 分支增 entity_type；episode / thought_item / concept 三分支不动。
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
  -- 取值门（§3.18 增补〔用户裁定 2026-10-13〕之一）：白名单里的枚举型字段，value_json 必须落在所属封闭枚举内。
  -- 字面量与 src/shared/constants/enums.json 逐项一致（event_time_precision / event_time_certainty / entity_types），
  -- 对账由 m2-schema-contract / m2-correction 的 T-16 手法守住，本文件是唯一落点。
  -- **NULL 安全（强制形态）**：value_json 为 JSON null 时 json_extract(value_json,'$') 求值为 SQL NULL，
  -- SQLite 的 CHECK 对 NULL 判定为「通过」→ 会从三值逻辑的缝里漏过去。故先要求
  -- json_type(value_json) = 'text'（JSON null / 数字 / 对象 / 数组 一律 FALSE），再比字面量。
  -- ELSE 1：summary / event_time_raw / text / canonical_name / display_name 是自由文本，不受取值门约束
  -- （§3.18 增补明文）。这里不能写 ELSE 0：field_name 不在这三个枚举字段之内 ≠ 非法，
  -- 非法 field_name 由上一段白名单 CHECK 拦截（field_name NOT NULL，CASE 求值不会落进 NULL 分支）。
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
        'game',
        'other'
      )
      ELSE 1
    END
  ),
  UNIQUE (object_table, object_id, field_name)
) STRICT;

-- ── 第三步：拷贝既有行（具名列，列序变化不会静默错位） ───────────────
INSERT INTO user_scalar_override_new (
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
  value_json,
  updated_at_utc
FROM user_scalar_override;

-- ── 第四步：换名 ─────────────────────────────────────────────────────
DROP TABLE user_scalar_override;
ALTER TABLE user_scalar_override_new RENAME TO user_scalar_override;

-- ── 第五步：六个触发器原样重建（定义与 0004 逐字一致） ───────────────
-- 目标存在性 + 目标可修正性：override 只能指向存在的、且不是 candidate 的行（§3.18 P4b）。
-- episode / thought_item 若挂 run，run 必须 result_state='current'；user_created / detach 行 parse_run_id 为 NULL，同样放行。
-- concept / entity 无 parse_run_id 列，只做存在性。
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

-- 目标行删除 ⇒ 引用它的 override 一并清除（§3.18 尾段：不留孤儿；§5 删除矩阵的多态等价实现）。
CREATE TRIGGER ovo_episode_ad AFTER DELETE ON episode BEGIN
  DELETE FROM user_scalar_override
  WHERE
    object_table = 'episode' AND object_id = OLD.id;
END;

CREATE TRIGGER ovo_thought_ad AFTER DELETE ON thought_item BEGIN
  DELETE FROM user_scalar_override
  WHERE
    object_table = 'thought_item' AND object_id = OLD.id;
END;

CREATE TRIGGER ovo_concept_ad AFTER DELETE ON concept BEGIN
  DELETE FROM user_scalar_override
  WHERE
    object_table = 'concept' AND object_id = OLD.id;
END;

CREATE TRIGGER ovo_entity_ad AFTER DELETE ON entity BEGIN
  DELETE FROM user_scalar_override
  WHERE
    object_table = 'entity' AND object_id = OLD.id;
END;
