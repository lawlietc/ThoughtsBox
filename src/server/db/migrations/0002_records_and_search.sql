-- 0002_records_and_search.sql —— M1a：原始记录、版本、搜索索引与删除审计（Schema 审查稿 V2 §3.1–§3.4 逐字落实）
-- 冻结来源：docs/dev-specs/M1-前置数据库Schema审查.md（V2）
--   · capture_record §3.1（B12：M1 不建 sleep_session_id；deferred 复合 FK 为 P2a/P2b 实测形态）
--   · record_revision §3.2（B13 空 diff：DB 不设 UNIQUE(record_id,content_sha256)，应用层拒绝 + T-31）
--   · record_fts §3.3（external-content + 三触发器；禁止一切引号形态 fts5 选项〔P12t〕，T-29 列集合契约）
--   · deletion_audit §3.4（四.1：object_id 无 FK；U-1 有条件批准：FTS5 secure_delete 表选项不受本构建支持，
--     安全机制 = PRAGMA secure_delete 每连接 + checkpoint(TRUNCATE) + 字节级残留测试）
-- 枚举字面量与 src/shared/constants/enums.json 逐项一致（E-07 / T-16）：
--   processing_statuses 8 值、processing_modes 3 值、privacy_levels 2 值。
-- deletion_audit.object_type 封闭集 17 值：§3 表清单中的业务对象表，
--   不含修正层补丁表（user_scalar_override / user_collection_patch，触发器随行清理）、虚表与审计表自身。

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
  processing_mode TEXT NOT NULL DEFAULT 'manual_only' CHECK (
    processing_mode IN ('manual_only', 'local_model', 'cloud_redacted')
  ),
  privacy_level TEXT NOT NULL DEFAULT 'normal' CHECK (
    privacy_level IN ('normal', 'sensitive')
  ),
  CHECK (id GLOB 'rec_*'),
  FOREIGN KEY (current_revision_id, id)
    REFERENCES record_revision (id, record_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX ix_capture_record_created_utc ON capture_record (created_at_utc);
CREATE INDEX ix_capture_record_local_date ON capture_record (created_local_date);

CREATE TABLE record_revision (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  raw_text TEXT NOT NULL CHECK (length(raw_text) >= 1),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  tokens TEXT NOT NULL,
  created_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_utc, 1, 19)) IS NOT NULL
    AND created_at_utc LIKE '%Z'
  ),
  created_at_local TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(created_at_local, 1, 19)) IS NOT NULL
    AND (created_at_local LIKE '%Z' OR substr(created_at_local, -6, 1) IN ('+', '-'))
  ),
  timezone_id TEXT NOT NULL CHECK (length(timezone_id) >= 1),
  UNIQUE (record_id, revision_number),
  CHECK (id GLOB 'rev_*'),
  FOREIGN KEY (record_id) REFERENCES capture_record (id) ON DELETE CASCADE
) STRICT;

-- capture_record 的复合 deferred FK 要求父键列 (id, record_id) 恰有一个唯一索引（P2a/P2b 形态）；
-- id 已是 PK，本索引不改变语义，只为让「current 指向别记录的 revision」被 FK 直接拒绝。
CREATE UNIQUE INDEX ux_record_revision_owner ON record_revision (id, record_id);

CREATE VIRTUAL TABLE record_fts USING fts5(
  tokens,
  content='record_revision',
  content_rowid='rowid'
);

CREATE TRIGGER record_ai AFTER INSERT ON record_revision BEGIN
  INSERT INTO record_fts (rowid, tokens) VALUES (new.rowid, new.tokens);
END;

CREATE TRIGGER record_ad AFTER DELETE ON record_revision BEGIN
  INSERT INTO record_fts (record_fts, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
END;

CREATE TRIGGER record_au AFTER UPDATE ON record_revision BEGIN
  INSERT INTO record_fts (record_fts, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
  INSERT INTO record_fts (rowid, tokens) VALUES (new.rowid, new.tokens);
END;

CREATE TABLE deletion_audit (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (
    object_type IN (
      'capture_record',
      'record_revision',
      'sleep_session',
      'cloud_send_grant',
      'parse_run',
      'episode',
      'thought_item',
      'concept',
      'concept_alias',
      'entity',
      'entity_alias',
      'emotion_mention',
      'topic_mention',
      'entity_mention',
      'graph_edge',
      'trigger_assertion',
      'suggestion'
    )
  ),
  object_id TEXT NOT NULL,
  deleted_at_utc TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%S', substr(deleted_at_utc, 1, 19)) IS NOT NULL
    AND deleted_at_utc LIKE '%Z'
  ),
  executor TEXT NOT NULL CHECK (executor = 'user'),
  -- 级联计数对象：键名集合封闭、由服务层白名单代码生成，禁放自由文本（§3.4〔提案〕，T-11 守护）。
  affected TEXT NOT NULL CHECK (json_valid(affected)),
  CHECK (id GLOB 'del_*')
) STRICT;
