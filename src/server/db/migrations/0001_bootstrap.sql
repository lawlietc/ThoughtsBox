-- 0001_bootstrap.sql —— M0 引导层。
-- 只建迁移记录、应用元信息与词表播种水位；业务表（Episode / Mention / TriggerAssertion /
-- 修正层 / Concept 等）一律不在 M0 落地，须等规格修订与 Schema 审查通过后由后续迁移引入。

create table if not exists schema_migrations (
  version     integer primary key,
  name        text    not null unique,
  sha256      text    not null,
  applied_at  text    not null
);

create table if not exists app_meta (
  key        text primary key,
  value      text not null,
  updated_at text not null
);

-- 词表播种水位：记录词表文件声明过的每个确定性标识与其内容哈希。
-- 它不是 Concept 表的替代品，作用是让播种可验证、可幂等重放，
-- 并让「词表变了」这件事在数据层留下痕迹（M2 建 Concept 后据此回填）。
create table if not exists vocab_seed_watermark (
  watermark_key  text primary key,
  kind           text not null check (kind in ('emotion', 'topic')),
  entry_kind     text not null check (entry_kind in ('concept', 'alias')),
  concept_id     text not null,
  canonical_name text not null,
  alias          text,
  alias_mode     text check (alias_mode in ('auto', 'suggest') or alias_mode is null),
  content_sha256 text not null,
  seeded_at      text not null
);

create index if not exists vocab_seed_watermark_kind_idx
  on vocab_seed_watermark (kind, entry_kind);
