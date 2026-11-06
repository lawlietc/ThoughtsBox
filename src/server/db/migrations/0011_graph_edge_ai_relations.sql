-- 0011_graph_edge_ai_relations.sql —— M7-1：graph_edge 放行 AI 边与六类稳定社会关系
-- 冻结来源：docs/dev-specs/2026-10-27-M7关系分析阶段任务拆分与执行准则.md §三.2（本文件逐条落实）
--   · R1：抽取结果直接入库，不等用户点头 ⇒ `created_by` 必须有 `ai_generated` 这一落点。
--   · R2：首批六类稳定社会关系（五无向 + `reports_to` 有向，方向为「下属 → 上级」）。
--   · R5：同 `(relation_type, src_id, dst_id)` 已有边 ⇒ 不新建、不改写 ⇒ UNIQUE 键原样保留。
--   · R6：无向类型按实体 id 字典序归一 ⇒ `src_id <= dst_id` 那条 CHECK 原样保留，只是豁免名单变宽。
--   · §3.5：边要能追到「哪一次解析产出的它」⇒ 新列 `origin_parse_run_id`。
--
-- ── 为什么是整表重建（与 0005/0006/0008/0009 同一形态，不是可选项）──────────
--   1. 0003 已提交 → 受 sha256 漂移守护，不得就地改（执行准则 §八 + E-04；禁区「0001–0010 一字节不动」）。
--   2. SQLite 不支持 `ALTER TABLE` 增删 CHECK：本次换 `relation_type` 取值集、加 `ai_generated`、
--      加一条新列的 FK，三处都是表级约束。
--
-- ── 为什么本次不需要 0008 那套「事务外关外键」，也不需要 defer_foreign_keys ──
-- 照 0009 的引用面清单口径逐条核对：
--   · 入向外键：**无**。grep 0001–0010：没有任何表 `REFERENCES graph_edge`。
--   · 出向外键：`origin_suggestion_id → suggestion(id) ON DELETE SET NULL`（0003:663），方向朝外；
--     本次新增 `origin_parse_run_id → parse_run(id) ON DELETE SET NULL` 同样朝外。父表全程在场，
--     拷贝步骤的 FK 求值照常可做，DROP 本表不波及任何别表。
--   · 挂在 graph_edge 上的触发器：`graph_edge_endpoints_bi` / `_bu`（0003:670/711）——随 DROP TABLE
--     也会消失，但按下面那条风险，显式先摘。
--   · 触发器**体**里 `DELETE FROM graph_edge` 的三条：`graph_edge_episode_ad`（0003:753，ON episode）、
--     `graph_edge_concept_ad`（0003:760，ON concept）、`graph_edge_entity_ad`（0003:767 建、
--     **0006:236 重建**，ON entity）。这就是 0005 踩过的那个坑（0009:28 明写「本次没有这一项」）：
--     `ALTER TABLE ... RENAME` 会重新校验引用该表名的 schema 对象，窗口内 graph_edge 这个名字
--     不存在 ⇒ `error in trigger ...: no such table`。所以第 1 步先把这五条摘干净，末尾第 6 步原样重建。
--     **漏摘一条 = 悄悄丢一条隐私清理路径**：那三条 `_ad` 正是「端点消失 ⇒ 引用它的边一并清除」
--     的物理实现，实体硬删除时不清边，脱敏与删除的口径就从库里破了。
-- 因此本文件全程待在 migrator 的 BEGIN IMMEDIATE 里，不动任何 pragma。
--
-- ── 重建逐项恢复 0003 的约束（不给缝）────────────────────────────────────
--   PRIMARY KEY (id)                        ← 0003:632
--   relation_type / src_kind / dst_kind 的定义处 CHECK ← 0003:633-637（前者的 IN 清单换成
--     `graphEdgeRelationTypes(enums)` 的 9 值，顺序与 enums.json 逐字同序，由
--     tests/m7-1-graph-contract.test.ts 动态对账钉住；后两份取值集逐字不动）
--   lifecycle_status 的 CHECK 与 DEFAULT 'active' ← 0003:640-642，逐字不动
--     （`superseded` 是 UI 阶段留给「用户否定 AI 边」的落点，本轮不写它，但列语义不许变）
--   CHECK (id GLOB 'edge_*')                ← 0003:655，逐字不动（m2-schema-contract 的前缀守门读它）
--   类型 ⊥ 端点种类的组合 CHECK              ← 0003:656-660：既有三支定义一个都不动，新增一支
--     把六类社会关系与 `same_as` 同绑 entity/entity（enums 里这七类的 source/target 都是 Entity*）
--   `src_id <= dst_id` 的无向归一 CHECK      ← 0003:661：豁免名单从 `merged_into` 一个值变两个值
--   UNIQUE (relation_type, src_id, dst_id)  ← 0003:662，逐字不动（R5 的物理基础）
--   FOREIGN KEY ... ON DELETE SET NULL      ← 0003:663，逐字不动
--   STRICT                                  ← 0003:664
--   ix_graph_edge_src / ix_graph_edge_dst   ← 0003:666-667，逐字重建
--
-- ── 本次的三处语义变化 ──────────────────────────────────────────────────
--   1. `created_by` 增 `ai_generated`：K-18 原先由这一列的 CHECK 整体兜住（「所有边的写入动作都
--      源自用户」）。放行 AI 边之后，那条 CHECK 就再也表达不了「哪几类关系 AI 永不创建」——
--      `ai_may_never_create`（triggered_by / same_as / merged_into）改由存储层守（R1 只放开六类
--      新关系，`same_as` / `merged_into` 的既有取值面一个 AI 都不许写）。这个落点不是可选装饰：
--      库里现在**能**写出 `same_as + ai_generated` 这一行，不守就是拿放宽列约束当没看见。
--   2. `relation_type` 从 3 值到 9 值。新六类的端点种类与 `same_as` 同支（entity/entity），
--      无向五类继续受 `src_id <= dst_id` 归一，`reports_to` 与 `merged_into` 一样两向语义两行。
--   3. 新列 `origin_parse_run_id`。**存量行一律 NULL**：NULL 的含义是「本轮之前写入，来源未知」，
--      不是「用户手工创建」（用户手工边在 `created_by` 上，两个事实各自有列，不互相代偿）。
--      ON DELETE SET NULL 而不是 CASCADE：一次解析被清理不该连带抹掉一条已经独立成立的关系，
--      来源指针失效即可。
--
-- 存量行不删、不改写（禁区 §三）：拷贝步骤原样搬，只有新列补 NULL。
-- 若存量行里有违反新 CHECK 的脏数据，拷贝让整份迁移失败并回滚——与 0005/0006/0009 同一立场。
-- 可逆性声明：前向迁移、无 down 脚本；本文件不新增表，m0 的表集合断言因此只多一个迁移文件名。

-- ── 第 1 步：摘掉全部相关触发器（见文件头引用面清单）─────────────────────
DROP TRIGGER graph_edge_endpoints_bi;
DROP TRIGGER graph_edge_endpoints_bu;
DROP TRIGGER graph_edge_episode_ad;
DROP TRIGGER graph_edge_concept_ad;
DROP TRIGGER graph_edge_entity_ad;

-- ── 第 2 步：建新名（列与 0003 同序，新列插在 origin_suggestion_id 之后）──
CREATE TABLE graph_edge_new (
  id TEXT PRIMARY KEY,
  -- 取值集 = graphEdgeRelationTypes(enums) 的 9 值，与 enums.json 同序。
  relation_type TEXT NOT NULL CHECK (
    relation_type IN (
      'possibly_related',
      'same_as',
      'merged_into',
      'colleague_of',
      'friend_of',
      'family_of',
      'partner_of',
      'classmate_of',
      'reports_to'
    )
  ),
  src_kind TEXT NOT NULL CHECK (src_kind IN ('episode', 'entity', 'concept')),
  dst_kind TEXT NOT NULL CHECK (dst_kind IN ('episode', 'entity', 'concept')),
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'superseded')
  ),
  -- R1：AI 直接入库的落点。哪几类关系不接受它，见上面语义变化 1（存储层守 `ai_may_never_create`）。
  created_by TEXT NOT NULL CHECK (
    created_by IN ('user', 'user_confirmed_suggestion', 'ai_generated')
  ),
  origin_suggestion_id TEXT,
  -- §3.5 的来源指针：这条边是哪一次 parse_run 产出的。存量行为 NULL = 来源未知。
  origin_parse_run_id TEXT,
  evidence_reason TEXT,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  updated_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(updated_at_utc, 1, 19)) IS NOT NULL
    AND updated_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'edge_*'),
  -- 类型 ⊥ 端点种类绑定：前两支与 0003:657-659 逐字同；第三支把 entity/entity 的七类并成一列清单。
  CHECK (
    (relation_type = 'possibly_related' AND src_kind = 'episode' AND dst_kind = 'episode')
    OR (relation_type = 'merged_into' AND src_kind = 'concept' AND dst_kind = 'concept')
    OR (
      relation_type IN (
        'same_as',
        'colleague_of',
        'friend_of',
        'family_of',
        'partner_of',
        'classmate_of',
        'reports_to'
      )
      AND src_kind = 'entity'
      AND dst_kind = 'entity'
    )
  ),
  -- R6：无向类型只存一个字典序方向；有向的两类（merged_into / reports_to）两向语义两行。
  CHECK (relation_type IN ('merged_into', 'reports_to') OR src_id <= dst_id),
  UNIQUE (relation_type, src_id, dst_id),
  FOREIGN KEY (origin_suggestion_id) REFERENCES suggestion (id) ON DELETE SET NULL,
  FOREIGN KEY (origin_parse_run_id) REFERENCES parse_run (id) ON DELETE SET NULL
) STRICT;

-- ── 第 3 步：存量行原样搬运，新列补 NULL（不猜来源）────────────────────
INSERT INTO graph_edge_new (
  id,
  relation_type,
  src_kind,
  dst_kind,
  src_id,
  dst_id,
  lifecycle_status,
  created_by,
  origin_suggestion_id,
  origin_parse_run_id,
  evidence_reason,
  created_at_utc,
  updated_at_utc
)
SELECT id,
  relation_type,
  src_kind,
  dst_kind,
  src_id,
  dst_id,
  lifecycle_status,
  created_by,
  origin_suggestion_id,
  NULL,
  evidence_reason,
  created_at_utc,
  updated_at_utc
FROM graph_edge;

-- ── 第 4 步：换名（DROP 与 RENAME 之间没有别的语句，窗口内无人引用这个名字）──
DROP TABLE graph_edge;

ALTER TABLE graph_edge_new RENAME TO graph_edge;

-- ── 第 5 步：索引（前两条与 0003:666-667 逐字同，第三条是本轮新增的读面）──
CREATE INDEX ix_graph_edge_src ON graph_edge (src_kind, src_id);
CREATE INDEX ix_graph_edge_dst ON graph_edge (dst_kind, dst_id);
CREATE INDEX ix_graph_edge_origin_run ON graph_edge (origin_parse_run_id);

-- ── 第 6 步：五条触发器原样重建（体与 0003 / 0006 逐字一致）──────────────
-- 端点存在性：多态引用无法用 FK，触发器是唯一等价物（P4b）。概念/实体不存在同样拒绝。
CREATE TRIGGER graph_edge_endpoints_bi BEFORE INSERT ON graph_edge BEGIN
  SELECT CASE
    WHEN NEW.src_kind = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 episode')
    WHEN NEW.dst_kind = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 episode')
    WHEN NEW.src_kind = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 concept')
    WHEN NEW.dst_kind = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 concept')
    WHEN NEW.src_kind = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 entity')
    WHEN NEW.dst_kind = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 entity')
  END;
END;

CREATE TRIGGER graph_edge_endpoints_bu BEFORE UPDATE ON graph_edge BEGIN
  SELECT CASE
    WHEN NEW.src_kind = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 episode')
    WHEN NEW.dst_kind = 'episode'
    AND NOT EXISTS (
      SELECT 1
      FROM episode
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 episode')
    WHEN NEW.src_kind = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 concept')
    WHEN NEW.dst_kind = 'concept'
    AND NOT EXISTS (
      SELECT 1
      FROM concept
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 concept')
    WHEN NEW.src_kind = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.src_id
    ) THEN RAISE(ABORT, 'graph_edge.src_id 指向不存在的 entity')
    WHEN NEW.dst_kind = 'entity'
    AND NOT EXISTS (
      SELECT 1
      FROM entity
      WHERE id = NEW.dst_id
    ) THEN RAISE(ABORT, 'graph_edge.dst_id 指向不存在的 entity')
  END;
END;

-- 端点消失 ⇒ 引用它的边一并清除（§5 矩阵「端点 D ⇒ 边 D（CASCADE）」的多态等价实现）。
CREATE TRIGGER graph_edge_episode_ad AFTER DELETE ON episode BEGIN
  DELETE FROM graph_edge
  WHERE
    (src_kind = 'episode' AND src_id = OLD.id)
    OR (dst_kind = 'episode' AND dst_id = OLD.id);
END;

CREATE TRIGGER graph_edge_concept_ad AFTER DELETE ON concept BEGIN
  DELETE FROM graph_edge
  WHERE
    (src_kind = 'concept' AND src_id = OLD.id)
    OR (dst_kind = 'concept' AND dst_id = OLD.id);
END;

CREATE TRIGGER graph_edge_entity_ad AFTER DELETE ON entity BEGIN
  DELETE FROM graph_edge
  WHERE
    (src_kind = 'entity' AND src_id = OLD.id)
    OR (dst_kind = 'entity' AND dst_id = OLD.id);
END;

-- ── 第 7 步：FK 面自检（与 0006:353-367 / 0009:125-137 同一手法）────────
-- `PRAGMA foreign_key_check` 只返回结果集、不报错，而 migrator 在 COMMIT **之后**才跑它。
-- 用一条「有违规就必然违反 CHECK」的条件守门表，让本事务在 COMMIT 前被顶掉并整份回滚，
-- 不留半迁移的库。守卫表随即删除，不进最终 schema（m0 的表集合断言因此不受影响）。
CREATE TABLE _fk_guard_after_rebuild (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

INSERT INTO _fk_guard_after_rebuild
SELECT count(*)
FROM pragma_foreign_key_check;

DROP TABLE _fk_guard_after_rebuild;
