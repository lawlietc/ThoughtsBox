-- 0003_derived_layer.sql —— M2 派生层（Schema 审查稿 V2 §3.6–§3.17 逐字落实）
-- 冻结来源：docs/dev-specs/M1-前置数据库Schema审查.md（V2）
--   · cloud_send_grant §3.6（K-17 逐版本授权；表内不存待发送文本本体；脱敏映射归 pipeline_manifest）
--   · parse_run §3.7（双态 B3；manifest 字段集合封闭；idempotency_key UNIQUE NOT NULL（K-03）；ux_run_current/ux_run_live〔P16〕）
--   · episode §3.8（时间五元组相容 CHECK〔B8/P14 逐字〕；evidence 锚原文 UTF-16〔K-23〕）
--   · thought_item §3.9（永不无来源〔B4/K-22〕）
--   · concept §3.10 / concept_alias §3.11（分域唯一〔B5/P15〕+ domain 一致性触发器〔P4b〕）
--   · entity §3.12 / entity_alias §3.13（不设名称 UNIQUE〔B5〕；别名仅实体内唯一）
--   · 三类 mention §3.14（来源 exactly-one〔K-04/P3〕；basis⊥origin 非法组合〔K-05+I2〕；per-run 唯一键〔P5〕）
--   · graph_edge §3.15（无 directed 列〔四.2/P19〕；端点存在性触发器〔P4b〕；kind 绑定端点种类）
--   · suggestion §3.17（空串哨兵〔四.3/P18〕；ux_sug_term；reason_code 封闭代码集〔B6〕）
-- 枚举字面量与 src/shared/constants/enums.json 逐项一致（E-07 / T-16），顺序亦一致。
--
-- 本文件相对审查稿的三处实现期偏差（全部如实登记，验收报告同步披露）：
--   (a) §3.7 表格单元把组合 CHECK 写成 `(execution_status IN ('queued','running')) = (result_state='candidate')`
--       的双向形式，与同稿 §4.7〔冻结·B3〕「queued/running ⇒ candidate；current ⇒ succeeded；failed ⇒ 非 current」
--       以及 §7.2「succeeded 时结果落 candidate」相矛盾——双向式禁止 succeeded+candidate，采纳制无法成立。
--       本迁移按冻结条款 §4.7 的三个单向不变式落实（T-05 同时断言 succeeded+candidate 合法）。
--   (b) §3.14 的 per-run 唯一键里「source 逻辑容器」是三列 COALESCE 表达式；SQLite 的部分唯一索引
--       不能建在该表达式上，故增 STORED 生成列 source_container_id 承载（不新增业务语义，仍由 exactly-one CHECK 保证取值）。
--   (c) §3.8 尾注「thought_item 同构复用此 CHECK」指的是 evidence 组合（§3.9 原文），事件时间五元组
--       在 Spec §3.1/§3.9 的 ThoughtItem 字段集与 §3.18 override 白名单里都不存在，故时间相容 CHECK 只落 episode。
--   (d) §3.14 把 K-19 写成 `intensity IS NOT NULL ⇒ intensity_source='user'` 的等值形式；该形式在
--       intensity_source 为 NULL 时整体取 NULL，而 SQLite 的 CHECK 对 NULL 判定为「通过」——
--       「有强度、无来源」正好漏网。本迁移改用 NULL 安全的 IS 比较，并把该不变式补成双向绑定
--       （来源有值而强度为空同样无意义）。语义只紧不松，验收报告同步披露。

-- ── §3.6 云端发送授权：绑定具体 revision + 实际载荷哈希 + 脱敏文本哈希 + 策略版本 + 确认时刻 ──
-- 复用规则（K-17）由 UNIQUE(record_revision_id, payload_sha256, policy_version) 在库里固化：
-- 同一 revision 上「内容相同且策略相同」才可能存在第二条授权，内容或策略一变即不适用。
CREATE TABLE cloud_send_grant (
  id TEXT PRIMARY KEY,
  record_revision_id TEXT NOT NULL,
  redacted_sha256 TEXT NOT NULL CHECK (
    length(redacted_sha256) = 64 AND redacted_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  policy_version TEXT NOT NULL CHECK (length(policy_version) >= 1),
  confirmed_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(confirmed_at_utc, 1, 19)) IS NOT NULL
    AND confirmed_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'csg_*'),
  UNIQUE (record_revision_id, payload_sha256, policy_version),
  FOREIGN KEY (record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE
) STRICT;

-- ── §3.7 解析运行（双态）──────────────────────────────────────────────
-- manifest 字段集合封闭（九项，T-33 锁定）：prompt/schema/model/provider/params/redaction/redactionMap/resolver/validation。
-- redactionMap 只本地存储、永不上传（§7.6）；pipeline_fingerprint 是除 redactionMap 外八项的规范化哈希（ADR-011）。
CREATE TABLE parse_run (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL,
  pipeline_manifest TEXT NOT NULL CHECK (
    json_valid(pipeline_manifest)
    AND json_type(pipeline_manifest, '$.prompt') IS NOT NULL
    AND json_type(pipeline_manifest, '$.schema') IS NOT NULL
    AND json_type(pipeline_manifest, '$.model') IS NOT NULL
    AND json_type(pipeline_manifest, '$.provider') IS NOT NULL
    AND json_type(pipeline_manifest, '$.params') IS NOT NULL
    AND json_type(pipeline_manifest, '$.redaction') IS NOT NULL
    AND json_type(pipeline_manifest, '$.redactionMap') IS NOT NULL
    AND json_type(pipeline_manifest, '$.resolver') IS NOT NULL
    AND json_type(pipeline_manifest, '$.validation') IS NOT NULL
  ),
  pipeline_fingerprint TEXT NOT NULL CHECK (
    length(pipeline_fingerprint) = 64 AND pipeline_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) >= 1),
  execution_status TEXT NOT NULL DEFAULT 'queued' CHECK (
    execution_status IN ('queued', 'running', 'succeeded', 'failed')
  ),
  result_state TEXT NOT NULL DEFAULT 'candidate' CHECK (
    result_state IN ('candidate', 'current', 'superseded')
  ),
  error_kind TEXT CHECK (
    error_kind IS NULL
    OR error_kind IN (
      'network',
      'timeout',
      'invalid_json',
      'business_validation',
      'provider_schema',
      'cancelled',
      'evidence_unmapped'
    )
  ),
  started_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(started_at_utc, 1, 19)) IS NOT NULL
    AND started_at_utc LIKE '%Z'
  ),
  finished_at_utc TEXT CHECK (
    finished_at_utc IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%S', substr(finished_at_utc, 1, 19)) IS NOT NULL
      AND finished_at_utc LIKE '%Z'
    )
  ),
  CHECK (id GLOB 'run_*'),
  -- §4.7 组合不变式（见头注偏差 (a)）
  CHECK (
    NOT (execution_status IN ('queued', 'running') AND result_state <> 'candidate')
  ),
  CHECK (NOT (result_state = 'current' AND execution_status <> 'succeeded')),
  CHECK (NOT (execution_status = 'failed' AND result_state = 'current')),
  FOREIGN KEY (source_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE
) STRICT;

-- 同一 Revision 同时至多一个当前有效解析结果（P16）。
CREATE UNIQUE INDEX ux_run_current ON parse_run (source_revision_id) WHERE result_state = 'current';
-- 同一逻辑解析（revision + 指纹）至多一个未定案/现行 run：重试复用、重跑需新指纹或先弃旧候选。
CREATE UNIQUE INDEX ux_run_live ON parse_run (source_revision_id, pipeline_fingerprint)
WHERE
  result_state IN ('candidate', 'current');
CREATE INDEX ix_parse_run_revision ON parse_run (source_revision_id);

-- ── §3.8 经历 ──────────────────────────────────────────────────────
-- 来源规则（K-02/K-22）：AI 行必同时锚定 revision 与 run；user_created（含 §3.20 detach）两者皆空，
-- 因此 detach 对象不会被记录级 CASCADE 波及，也不属于任何 run 的结果集。
CREATE TABLE episode (
  id TEXT PRIMARY KEY,
  source_record_revision_id TEXT,
  parse_run_id TEXT,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('ai_generated', 'user_created')),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'superseded')
  ),
  summary TEXT NOT NULL CHECK (length(summary) >= 1),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (
    origin_type <> 'ai_generated' OR length(evidence_text) >= 1
  ),
  -- 偏移单位 = JavaScript UTF-16 code unit，坐标一律属于其来源 revision 的 raw_text 原文（K-23/B9）。
  -- 脱敏文本中的偏移永不得写入本表：入库前必须已经映射回原文坐标并通过逐字核验（§7.6）。
  evidence_start INTEGER,
  evidence_end INTEGER,
  event_time_raw TEXT,
  event_time_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (
    event_time_precision IN ('year', 'month', 'day', 'unknown')
  ),
  event_time_certainty TEXT NOT NULL DEFAULT 'unknown' CHECK (
    event_time_certainty IN ('explicit', 'approximate', 'unknown')
  ),
  event_time_start TEXT,
  event_time_end TEXT,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'ep_*'),
  CHECK (
    (
      origin_type = 'ai_generated'
      AND source_record_revision_id IS NOT NULL
      AND parse_run_id IS NOT NULL
    )
    OR (
      origin_type = 'user_created'
      AND source_record_revision_id IS NULL
      AND parse_run_id IS NULL
    )
  ),
  CHECK (
    evidence_start IS NULL
    OR (evidence_start >= 0 AND evidence_end IS NOT NULL AND evidence_end >= evidence_start)
  ),
  CHECK (origin_type <> 'ai_generated' OR evidence_start IS NOT NULL),
  -- §3.8 / B8 / P14：unknown ⇒ 起止皆空且 certainty=unknown；year/month/day ⇒ 起止齐全且精确覆盖完整年度/自然月/单日。
  CHECK (
    (
      event_time_precision = 'unknown'
      AND event_time_certainty = 'unknown'
      AND event_time_start IS NULL
      AND event_time_end IS NULL
    )
    OR (
      event_time_precision IN ('year', 'month', 'day')
      AND event_time_certainty IN ('explicit', 'approximate')
      AND event_time_start IS NOT NULL
      AND event_time_end IS NOT NULL
      AND event_time_start <= event_time_end
      AND (
        event_time_precision != 'year'
        OR (
          strftime('%m-%d', event_time_start) = '01-01'
          AND strftime('%m-%d', event_time_end) = '12-31'
        )
      )
      AND (
        event_time_precision != 'month'
        OR (
          strftime('%d', event_time_start) = '01'
          AND date(event_time_start, '+1 month', '-1 day') = event_time_end
        )
      )
      AND (event_time_precision != 'day' OR event_time_start = event_time_end)
      AND event_time_raw IS NOT NULL
    )
  ),
  FOREIGN KEY (source_record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE,
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX ix_episode_revision ON episode (source_record_revision_id);
CREATE INDEX ix_episode_run ON episode (parse_run_id);

-- ── §3.9 念头 ──────────────────────────────────────────────────────
-- 数据库层面永无 source-less ThoughtItem（B4/K-22）：手工创建路径由服务层同事务先建记录与版本再挂接。
CREATE TABLE thought_item (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(text) >= 1),
  source_record_revision_id TEXT,
  source_episode_id TEXT,
  parse_run_id TEXT,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('ai_generated', 'user_created')),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'superseded')
  ),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (
    origin_type <> 'ai_generated' OR length(evidence_text) >= 1
  ),
  evidence_start INTEGER,
  evidence_end INTEGER,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'thought_*'),
  -- 恰好一个来源（revision 或 episode）。
  CHECK (
    (source_record_revision_id IS NOT NULL) + (source_episode_id IS NOT NULL) = 1
  ),
  CHECK (
    (origin_type = 'ai_generated' AND parse_run_id IS NOT NULL)
    OR (origin_type = 'user_created' AND parse_run_id IS NULL)
  ),
  CHECK (
    evidence_start IS NULL
    OR (evidence_start >= 0 AND evidence_end IS NOT NULL AND evidence_end >= evidence_start)
  ),
  CHECK (origin_type <> 'ai_generated' OR evidence_start IS NOT NULL),
  FOREIGN KEY (source_record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE,
  FOREIGN KEY (source_episode_id) REFERENCES episode (id) ON DELETE CASCADE,
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX ix_thought_revision ON thought_item (source_record_revision_id);
CREATE INDEX ix_thought_episode ON thought_item (source_episode_id);
CREATE INDEX ix_thought_run ON thought_item (parse_run_id);

-- ── §3.10 概念 ─────────────────────────────────────────────────────
-- 播种例外：种子概念用确定性 ID concept_seed_<sha256(NFC 标准名) 前 12 位>（K-15/Spec §9.3），与 uuidv7 共用 concept_ 前缀。
-- 同名不双概念：UNIQUE(concept_type, canonical_name)，与 §3.11 的分域别名一致。
CREATE TABLE concept (
  id TEXT PRIMARY KEY,
  concept_type TEXT NOT NULL CHECK (concept_type IN ('emotion', 'topic')),
  canonical_name TEXT NOT NULL CHECK (length(canonical_name) >= 1),
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('system_seed', 'user_created', 'user_confirmed_suggestion')
  ),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'merged', 'archived')
  ),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'concept_*'),
  UNIQUE (concept_type, canonical_name)
) STRICT;

-- ── §3.11 概念别名（分域唯一）────────────────────────────────────────
-- domain 是冗余列，必须由触发器与所属概念的 concept_type 一致（SQLite 无表达式 FK，P4b 形态）。
-- mode=auto 只有词表播种器可写（K-14）：分层约定由服务层与 T-22 断言共同守门。
CREATE TABLE concept_alias (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL CHECK (length(alias) >= 1),
  concept_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('emotion', 'topic')),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'suggest')),
  source TEXT NOT NULL CHECK (source IN ('seed', 'user_confirmed')),
  confirmed_at_utc TEXT CHECK (
    confirmed_at_utc IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%S', substr(confirmed_at_utc, 1, 19)) IS NOT NULL
      AND confirmed_at_utc LIKE '%Z'
    )
  ),
  CHECK (id GLOB 'ca_*'),
  FOREIGN KEY (concept_id) REFERENCES concept (id) ON DELETE CASCADE
) STRICT;

-- 同一概念域内一个有效别名只能指向一个标准概念；情绪别名与主题别名允许同名（P15）。
CREATE UNIQUE INDEX ux_concept_alias ON concept_alias (domain, alias);

CREATE TRIGGER concept_alias_domain_bi BEFORE INSERT ON concept_alias BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT concept_type FROM concept WHERE id = NEW.concept_id), '<缺>') <> NEW.domain THEN RAISE(
      ABORT,
      'concept_alias.domain 必须等于所属概念的 concept_type（概念不存在同样拒绝）'
    )
  END;
END;

CREATE TRIGGER concept_alias_domain_bu BEFORE UPDATE ON concept_alias BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT concept_type FROM concept WHERE id = NEW.concept_id), '<缺>') <> NEW.domain THEN RAISE(
      ABORT,
      'concept_alias.domain 必须等于所属概念的 concept_type'
    )
  END;
END;

-- ── §3.12 实体 ─────────────────────────────────────────────────────
-- canonical（本地敏感真名）/ display（展示名）/ 脱敏标识（在映射里，不落本表）三者分离（K-21）。
-- 不设名称 UNIQUE：同名不同人是常态（B5）。provisional 不进入默认可视图谱（Spec §3.3）。
CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'person',
      'organization',
      'place',
      'work',
      'product',
      'game',
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

-- ── §3.13 实体别名 ─────────────────────────────────────────────────
-- 仅实体内唯一（复合主键即该 UNIQUE）；不做跨实体全局唯一——同名人物合法并存，解析返回候选、绝不自动合并（B5/K-12）。
CREATE TABLE entity_alias (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL CHECK (length(alias) >= 1),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  PRIMARY KEY (entity_id, alias),
  FOREIGN KEY (entity_id) REFERENCES entity (id) ON DELETE RESTRICT
) STRICT;

-- ── §3.14 三类 Mention（对称结构，各自成表）──────────────────────────
-- 共同不变量：来源 exactly-one（K-04/P3）；basis⊥origin 的两种非法组合被拒（K-05+I2）；
-- ai_generated ⇒ 必挂 run 且必可回锚原文；user_created ⇒ 永不挂 run（用户自述不是模型结论）。
CREATE TABLE emotion_mention (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL,
  source_record_revision_id TEXT,
  source_episode_id TEXT,
  source_thought_id TEXT,
  source_container_id TEXT GENERATED ALWAYS AS (
    COALESCE(source_record_revision_id, source_episode_id, source_thought_id)
  ) STORED,
  label_said TEXT NOT NULL CHECK (length(label_said) >= 1),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (
    origin_type <> 'ai_generated' OR length(evidence_text) >= 1
  ),
  evidence_start INTEGER,
  evidence_end INTEGER,
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('ai_generated', 'user_created', 'user_confirmed_suggestion')
  ),
  basis TEXT NOT NULL CHECK (basis IN ('explicit', 'inferred')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected')),
  parse_run_id TEXT,
  intensity INTEGER CHECK (intensity IS NULL OR (intensity BETWEEN 1 AND 5)),
  intensity_source TEXT CHECK (intensity_source IS NULL OR intensity_source = 'user'),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'em_*'),
  CHECK (
    (source_record_revision_id IS NOT NULL)
    + (source_episode_id IS NOT NULL)
    + (source_thought_id IS NOT NULL) = 1
  ),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'ai_generated')),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'user_created')),
  CHECK (
    (origin_type = 'ai_generated' AND parse_run_id IS NOT NULL)
    OR (origin_type <> 'ai_generated' AND parse_run_id IS NULL)
  ),
  CHECK (
    evidence_start IS NULL
    OR (evidence_start >= 0 AND evidence_end IS NOT NULL AND evidence_end >= evidence_start)
  ),
  CHECK (origin_type <> 'ai_generated' OR evidence_start IS NOT NULL),
  -- K-19：强度只可能来自用户，且只有用户填写时才有值（双向绑定）。
  -- 写成 IS 而不是 =：SQLite 的 CHECK 把 NULL 视为通过，`intensity_source = 'user'` 在来源为 NULL 时得 NULL，
  -- 「有强度、无来源」这一最典型的非法形态反而从三值逻辑的缝里漏掉（M2 契约测试实测）。
  CHECK (
    (intensity IS NULL AND intensity_source IS NULL)
    OR (intensity IS NOT NULL AND intensity_source IS 'user')
  ),
  FOREIGN KEY (concept_id) REFERENCES concept (id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE,
  FOREIGN KEY (source_episode_id) REFERENCES episode (id) ON DELETE CASCADE,
  FOREIGN KEY (source_thought_id) REFERENCES thought_item (id) ON DELETE CASCADE,
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

-- 同一 run 内同一 (容器, 目标, 原词, 证据起点) 只能落一条（P5/P10 形态；候选行同样受约，杜绝半写重放）。
CREATE UNIQUE INDEX ux_emotion_mention_run ON emotion_mention (
  parse_run_id,
  source_container_id,
  concept_id,
  label_said,
  evidence_start
)
WHERE
  parse_run_id IS NOT NULL;
CREATE INDEX ix_emotion_mention_concept ON emotion_mention (concept_id, status);
CREATE INDEX ix_emotion_mention_container ON emotion_mention (source_container_id, status);

CREATE TABLE topic_mention (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL,
  source_record_revision_id TEXT,
  source_episode_id TEXT,
  source_thought_id TEXT,
  source_container_id TEXT GENERATED ALWAYS AS (
    COALESCE(source_record_revision_id, source_episode_id, source_thought_id)
  ) STORED,
  label_said TEXT NOT NULL CHECK (length(label_said) >= 1),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (
    origin_type <> 'ai_generated' OR length(evidence_text) >= 1
  ),
  evidence_start INTEGER,
  evidence_end INTEGER,
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('ai_generated', 'user_created', 'user_confirmed_suggestion')
  ),
  basis TEXT NOT NULL CHECK (basis IN ('explicit', 'inferred')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected')),
  parse_run_id TEXT,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'tm_*'),
  CHECK (
    (source_record_revision_id IS NOT NULL)
    + (source_episode_id IS NOT NULL)
    + (source_thought_id IS NOT NULL) = 1
  ),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'ai_generated')),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'user_created')),
  CHECK (
    (origin_type = 'ai_generated' AND parse_run_id IS NOT NULL)
    OR (origin_type <> 'ai_generated' AND parse_run_id IS NULL)
  ),
  CHECK (
    evidence_start IS NULL
    OR (evidence_start >= 0 AND evidence_end IS NOT NULL AND evidence_end >= evidence_start)
  ),
  CHECK (origin_type <> 'ai_generated' OR evidence_start IS NOT NULL),
  FOREIGN KEY (concept_id) REFERENCES concept (id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE,
  FOREIGN KEY (source_episode_id) REFERENCES episode (id) ON DELETE CASCADE,
  FOREIGN KEY (source_thought_id) REFERENCES thought_item (id) ON DELETE CASCADE,
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX ux_topic_mention_run ON topic_mention (
  parse_run_id,
  source_container_id,
  concept_id,
  label_said,
  evidence_start
)
WHERE
  parse_run_id IS NOT NULL;
CREATE INDEX ix_topic_mention_concept ON topic_mention (concept_id, status);
CREATE INDEX ix_topic_mention_container ON topic_mention (source_container_id, status);

CREATE TABLE entity_mention (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  source_record_revision_id TEXT,
  source_episode_id TEXT,
  source_thought_id TEXT,
  source_container_id TEXT GENERATED ALWAYS AS (
    COALESCE(source_record_revision_id, source_episode_id, source_thought_id)
  ) STORED,
  label_said TEXT NOT NULL CHECK (length(label_said) >= 1),
  evidence_text TEXT NOT NULL DEFAULT '' CHECK (
    origin_type <> 'ai_generated' OR length(evidence_text) >= 1
  ),
  evidence_start INTEGER,
  evidence_end INTEGER,
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('ai_generated', 'user_created', 'user_confirmed_suggestion')
  ),
  basis TEXT NOT NULL CHECK (basis IN ('explicit', 'inferred')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected')),
  parse_run_id TEXT,
  -- B2/I5：role 是可空自由文本属性，不参与关系类型、不生成边；只守长度与空白形态，不建封闭枚举。
  role TEXT CHECK (
    role IS NULL
    OR (
      length(role) BETWEEN 1 AND 200
      AND trim(role) <> ''
      AND role = trim(role)
    )
  ),
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'enm_*'),
  CHECK (
    (source_record_revision_id IS NOT NULL)
    + (source_episode_id IS NOT NULL)
    + (source_thought_id IS NOT NULL) = 1
  ),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'ai_generated')),
  CHECK (NOT (basis = 'inferred' AND origin_type = 'user_created')),
  CHECK (
    (origin_type = 'ai_generated' AND parse_run_id IS NOT NULL)
    OR (origin_type <> 'ai_generated' AND parse_run_id IS NULL)
  ),
  CHECK (
    evidence_start IS NULL
    OR (evidence_start >= 0 AND evidence_end IS NOT NULL AND evidence_end >= evidence_start)
  ),
  CHECK (origin_type <> 'ai_generated' OR evidence_start IS NOT NULL),
  FOREIGN KEY (entity_id) REFERENCES entity (id) ON DELETE RESTRICT,
  FOREIGN KEY (source_record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE,
  FOREIGN KEY (source_episode_id) REFERENCES episode (id) ON DELETE CASCADE,
  FOREIGN KEY (source_thought_id) REFERENCES thought_item (id) ON DELETE CASCADE,
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX ux_entity_mention_run ON entity_mention (
  parse_run_id,
  source_container_id,
  entity_id,
  label_said,
  evidence_start
)
WHERE
  parse_run_id IS NOT NULL;
CREATE INDEX ix_entity_mention_entity ON entity_mention (entity_id, status);
CREATE INDEX ix_entity_mention_container ON entity_mention (source_container_id, status);

-- ── §3.17 建议（支持无既存目标的候选）──────────────────────────────
-- 端点列一律 NOT NULL DEFAULT ''：P5 实测 UNIQUE 含 NULL 不去重，禁可空键列（四.3/P18）。
-- relation_type 与 kind 绑定，无关系类候选必为空串哨兵——避免「同一候选因 NULL 而重复成立」。
CREATE TABLE suggestion (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'emotion_candidate',
      'alias',
      'new_concept',
      'possibly_related',
      'possibly_same_as',
      'evidence_repair'
    )
  ),
  relation_type TEXT NOT NULL DEFAULT '' CHECK (
    (kind = 'possibly_related' AND relation_type = 'possibly_related')
    OR (kind = 'possibly_same_as' AND relation_type = 'possibly_same_as')
    OR (kind NOT IN ('possibly_related', 'possibly_same_as') AND relation_type = '')
  ),
  endpoint_a TEXT NOT NULL DEFAULT '',
  endpoint_b TEXT NOT NULL DEFAULT '',
  subject_term TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'ignored', 'withdrawn')
  ),
  -- 撤回/忽略原因只用封闭代码，绝不含敏感原文（B6/T-11）。
  reason_code TEXT NOT NULL DEFAULT '' CHECK (
    reason_code IN ('', 'basis_lost', 'superseded_by_user', 'user_ignored')
  ),
  evidence TEXT,
  display_note TEXT,
  parse_run_id TEXT,
  result_id TEXT,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  updated_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(updated_at_utc, 1, 19)) IS NOT NULL
    AND updated_at_utc LIKE '%Z'
  ),
  CHECK (id GLOB 'sug_*'),
  -- 端点矩阵：两类成对建议是 (a,b) 且无向对按字典序归一；其余 kind 只有 endpoint_a（+ 词面）。
  CHECK (
    (
      kind IN ('possibly_related', 'possibly_same_as')
      AND endpoint_a <> ''
      AND endpoint_b <> ''
      AND endpoint_a <= endpoint_b
    )
    OR (kind NOT IN ('possibly_related', 'possibly_same_as') AND endpoint_b = '')
  ),
  -- parse_run_id 可空：管线产出的建议带来源 run（CASCADE 随 run 一起消失），
  -- 用户手工登记的候选（如 M3 的手动"可能相关"）本就不属于任何一次解析。
  UNIQUE (kind, relation_type, endpoint_a, endpoint_b),
  FOREIGN KEY (parse_run_id) REFERENCES parse_run (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX ux_sug_term ON suggestion (kind, endpoint_a, subject_term)
WHERE
  subject_term <> '';

CREATE INDEX ix_suggestion_status ON suggestion (kind, status);

-- ── §3.15 独立关系边 ───────────────────────────────────────────────
-- 只有 GraphEdge 承载的三类关系在此（has_emotion/on_topic/about 由 Mention 投影，possibly_same_as/triggered_by 不入表）。
-- 无 directed 列（四.2/P19）：无向类型（possibly_related、same_as）只存一个字典序方向；有向 merged_into 允许两向语义。
CREATE TABLE graph_edge (
  id TEXT PRIMARY KEY,
  relation_type TEXT NOT NULL CHECK (
    relation_type IN ('possibly_related', 'same_as', 'merged_into')
  ),
  src_kind TEXT NOT NULL CHECK (src_kind IN ('episode', 'entity', 'concept')),
  dst_kind TEXT NOT NULL CHECK (dst_kind IN ('episode', 'entity', 'concept')),
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'superseded')
  ),
  -- K-18/enums ai_may_never_create：所有边的写入动作都源自用户（直接创建或确认建议）。
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'user_confirmed_suggestion')),
  origin_suggestion_id TEXT,
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
  CHECK (
    (relation_type = 'possibly_related' AND src_kind = 'episode' AND dst_kind = 'episode')
    OR (relation_type = 'same_as' AND src_kind = 'entity' AND dst_kind = 'entity')
    OR (relation_type = 'merged_into' AND src_kind = 'concept' AND dst_kind = 'concept')
  ),
  CHECK (relation_type = 'merged_into' OR src_id <= dst_id),
  UNIQUE (relation_type, src_id, dst_id),
  FOREIGN KEY (origin_suggestion_id) REFERENCES suggestion (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX ix_graph_edge_src ON graph_edge (src_kind, src_id);
CREATE INDEX ix_graph_edge_dst ON graph_edge (dst_kind, dst_id);

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
