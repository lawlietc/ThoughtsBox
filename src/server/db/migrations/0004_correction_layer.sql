-- 0004_correction_layer.sql —— M2 修正层（Schema 审查稿 V2 §3.18 / §7.4 逐字落实）
-- 冻结来源：docs/dev-specs/M1-前置数据库Schema审查.md（V2）
--   · user_scalar_override §3.18 —— 多态标量覆盖：object_table 白名单 + field_name 白名单 CASE CHECK；
--     value_json 过 json_valid；UNIQUE(object_table, object_id, field_name)；
--     BEFORE INSERT/UPDATE 存在性触发器（P4b 形态），并校验目标行可修正
--     （episode / thought_item 若挂 run，其 run 必须 result_state='current'；concept / entity 无 run 列，只做存在性检查）。
--   · user_collection_patch §3.18 —— 集合成员补丁：container_table / collection / op 三个封闭集；
--     UNIQUE(container_table, container_id, collection, member_id) 成员级唯一；BEFORE INSERT/UPDATE 容器存在性触发器。
--   · 删除清理（§3.18 尾段 + §5 删除矩阵）：多态引用无法 FK CASCADE，触发器是唯一等价物——
--     override 的四张目标表（episode / thought_item / concept / entity）与 patch 的两张容器表
--     （episode / thought_item）各挂 AFTER DELETE，删除本层指向行，不留孤儿。
-- id 前缀：ovo_ / ucp_（src/shared/contracts/ids.ts:35-36）；形态 CHECK 与其它派生表同法。
--
-- 本文件相对审查稿的两处如实登记：
--   (a) §3.18 的 patch.op CHECK 冻结原文是 `add|remove`；"收紧到仅 remove"是同段的**提案**、非冻结条款。
--       本迁移按冻结原文落 `add|remove`；T-30 服务层「add 写入被拒」由 M2-5 事务路径承担，DB 面不越权。
--   (b) §3.18 只规定 patch 容器「存在性触发器同 override」，未把 override 的「所在 run 必须 current」
--       扩展到 patch。本迁移严格按字面：容器存在性检查，不检查 run 状态——
--       理由是补丁挂的是成员关系（隐藏 + 防复活），语义与「内容修正」不同；
--       若未来裁定要收紧，只需增补一处 WHEN、不破坏任何既有通过用例。

-- ── §3.18 标量覆盖：override 只能落在四张可修正对象表上 ────────────────
-- 白名单冻结：episode / thought_item / concept / entity。
-- CaptureRecord 的可编辑字段（summary 无关、mode、privacy_level、原文）是行内列，不走 override。
-- field_name 白名单按 object_table 分支；数值 / 区间类字段（evidence）不可 override（K-23 锚定：证据契约不可改写）。
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
  -- field_name 白名单 CASE CHECK（§3.18 逐字）。object_table 已被上一段 CHECK 锁成四值，
  -- ELSE 0 只是纵深防御——若 CHECK 求值绕过，宁可明确拒绝，也不给三值逻辑 NULL 留缝（0003 偏差 (d) 同法）。
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
      WHEN 'entity' THEN field_name IN ('display_name', 'canonical_name')
      ELSE 0
    END
  ),
  UNIQUE (object_table, object_id, field_name)
) STRICT;

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

-- ── §3.18 集合补丁：remove 落补丁行、add 由服务层落真实 user_created Mention ──
-- 容器：仅 episode / thought_item（Mention 的三类来源里，revision 是原文容器、不进 override 面）。
-- 集合：emotions / topics / entities 三个成员集合；member_id 存稳定 Concept / Entity ID。
-- op：`add|remove`（§3.18 冻结原文；M2-5 服务层禁止写 add，见头注偏差 (a)）。
-- UNIQUE 是成员级四元组：同一 (容器, 集合, 成员) 至多一条补丁——重复 remove 不重复成立。
CREATE TABLE user_collection_patch (
  id TEXT PRIMARY KEY,
  container_table TEXT NOT NULL CHECK (container_table IN ('episode', 'thought_item')),
  container_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK (collection IN ('emotions', 'topics', 'entities')),
  member_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('add', 'remove')),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'ucp_*'),
  UNIQUE (container_table, container_id, collection, member_id)
) STRICT;

-- 容器存在性（§3.18 P4b 同形态）：只检查容器行存在；不检查 run 状态（见头注偏差 (b)）。
CREATE TRIGGER ucp_container_bi BEFORE INSERT ON user_collection_patch BEGIN
  SELECT CASE
    WHEN NEW.container_table = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.container_id
    ) THEN RAISE(ABORT, 'user_collection_patch.container_id 指向不存在的 episode')
    WHEN NEW.container_table = 'thought_item'
    AND NOT EXISTS (
      SELECT 1
      FROM thought_item
      WHERE id = NEW.container_id
    ) THEN RAISE(ABORT, 'user_collection_patch.container_id 指向不存在的 thought_item')
  END;
END;

CREATE TRIGGER ucp_container_bu BEFORE UPDATE ON user_collection_patch BEGIN
  SELECT CASE
    WHEN NEW.container_table = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.container_id
    ) THEN RAISE(ABORT, 'user_collection_patch.container_id 指向不存在的 episode')
    WHEN NEW.container_table = 'thought_item'
    AND NOT EXISTS (
      SELECT 1
      FROM thought_item
      WHERE id = NEW.container_id
    ) THEN RAISE(ABORT, 'user_collection_patch.container_id 指向不存在的 thought_item')
  END;
END;

-- 容器删除 ⇒ 引用它的补丁一并清除（§3.18 尾段：容器被 D ⇒ 补丁行 D）。
CREATE TRIGGER ucp_episode_ad AFTER DELETE ON episode BEGIN
  DELETE FROM user_collection_patch
  WHERE
    container_table = 'episode' AND container_id = OLD.id;
END;

CREATE TRIGGER ucp_thought_ad AFTER DELETE ON thought_item BEGIN
  DELETE FROM user_collection_patch
  WHERE
    container_table = 'thought_item' AND container_id = OLD.id;
END;
