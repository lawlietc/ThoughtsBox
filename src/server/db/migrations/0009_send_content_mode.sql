-- 0009_send_content_mode.sql —— M6-0D：原文发送授权落进 cloud_send_grant（草案 §二/§四/§六）
-- 冻结来源：docs/dev-specs/2026-10-23-M6-0D-原文发送授权表设计草案.md
--   · §一 三个缺口：redacted_sha256 是 NOT NULL（原文发送没有脱敏文本）；策略版本会串（原文授权沿用
--     rules-v1 会被规则升版一起失效）；缺「这条授权针对哪种内容」这一腿。
--   · §二 目标结构：新增 send_content_mode（两值 redacted|raw）+ redacted_sha256 改可空 +
--     UNIQUE 四元组 (record_revision_id, send_content_mode, payload_sha256, policy_version)。
--   · §四 复用口径（2026-10-24 定）：**不引入 consumed_at_utc、不新增 consumeGrant**。原文授权与脱敏
--     授权同构：命中四元组即放行，重复发送不重新确认。一次性消费已改判，本文件不得再留消费状态。
--   · §八之二-1（0C 草案）：send_content_mode 有两个定义域——记录轴三值（0008），授权表列两值。
--     本文件只落授权表那一域，**不得**引用 enums 的记录轴清单，否则出现「三值 CHECK 里塞两值」的漂移。
--
-- ── 为什么是整表重建（与 0005/0008 同一形态，不是可选项）────────────────────
--   1. 0003 已提交 → 受 sha256 漂移守护，不得就地改（执行准则 §八 + E-04）。
--   2. SQLite 不支持 `ALTER TABLE` 改 NOT NULL：本次要把 redacted_sha256 从 NOT NULL 改成可空，
--      ALTER ADD COLUMN 只能约束新列、无法回改既有列定义 —— 只能重建。
--   3. 同一次重建还要换 UNIQUE 键（三元组 → 四元组）并加一条组合 CHECK；SQLite 不支持增删表级约束。
--
-- ── 为什么本次不需要 0008 那套「事务外关外键」──────────────────────────────
-- 0008 必须 `PRAGMA foreign_keys = OFF` 是因为它重建的 capture_record 是**父表**，而入向外键
-- record_revision.record_id → capture_record(id) 是 ON DELETE CASCADE：`DROP TABLE` 前的隐式
-- `DELETE FROM` 会照着 CASCADE 逐行删子表——没有守卫表就静默删光用户的版本行（0008 文件头实测）。
-- cloud_send_grant 是**叶子子表**：
--   · 入向外键：**无**（grep 0001–0008：没有任何表 REFERENCES cloud_send_grant；0002:109 那处命中
--     是 deletion_audit.object_type 的 CHECK 取值字面量，是字符串常量，不是外键引用）。
--   · 出向外键：record_revision_id → record_revision(id) ON DELETE CASCADE（0003:47）。方向朝外，
--     DROP 本表不会波及任何别表；父表 record_revision 全程在场，拷贝步骤的 FK 求值照常可做。
--   · 触发器：挂在 cloud_send_grant 上的**无**；触发器**体**里引用它的也**无**（0002 的三个 FTS 触发器
--     挂在 record_revision 上，本次不动那张表）。故 0005 那条「RENAME 会因 body 引用而失败」的风险
--     在这里不存在，可以走 0005 的 建新名 → 拷贝 → DROP 旧 → RENAME 回原名 形态。
-- 因此本文件全程待在 migrator 的 BEGIN IMMEDIATE 里，不动任何 pragma：schema 变更与版本号记录
-- 在同一次提交内，不存在 0008 那种「崩溃落在两次提交之间、需要重跑安全」的原子性代价。
--
-- ── 重建必须逐项恢复 0003 的约束（草案 §二 清单，逐条对位）────────────────
--   PRIMARY KEY (id)                       ← 0003:32
--   CHECK (id GLOB 'csg_*')                ← 0003:45（m2-schema-contract 的静态前缀守门也读这一条）
--   redacted_sha256 的 64 位十六进制 CHECK   ← 0003:34-36，本次改写为 NULL 安全形态（见下）
--   payload_sha256 的 64 位十六进制 CHECK    ← 0003:37-39，逐字不动
--   policy_version 的 length >= 1 CHECK     ← 0003:40，逐字不动
--   confirmed_at_utc 的 UTC 格式 CHECK      ← 0003:41-44，逐字不动
--   FOREIGN KEY ... ON DELETE CASCADE       ← 0003:47，逐字不动
--   STRICT                                 ← 0003:48
--   （0003 没有建过 cloud_send_grant 的索引，故本次无索引需要重建。）
--
-- ── 两处语义变化，都是草案要求的──────
--   1. `redacted_sha256` 的含义**不变**：它仍然是「本次授权所依据的那份脱敏文本的哈希」，只是原文发送
--      压根没有脱敏文本，于是该列在 raw 行上为 NULL。既有含义与既有值一个都不动。
--   2. 64hex CHECK 改 NULL 安全：0003 的 `length(redacted_sha256) = 64 AND ...` 在值为 NULL 时整体求值
--      为 NULL，而 SQLite 的 CHECK 把 NULL 判为「通过」——单靠这一点「raw 带 NULL」确实进得来，但
--      「redacted 带 NULL」也会一起漏进来。所以本次显式写成 `IS NULL OR (64hex)` 的析取式，把
--      「有值必须是 64 位小写十六进制」这条钉死；「哪种 mode 必须有值」交给下面的组合 CHECK。
--      同 0003 头注偏差 (d) 的教训：不用三值逻辑的缝隙当约束。
--   3. 组合 CHECK（草案 §二逐字）：mode 与 redacted_sha256 的可空性绑死，两个方向都不给缝：
--      redacted ⇒ 必须有脱敏哈希；raw ⇒ 必须没有。send_content_mode 自身 NOT NULL 且被 CHECK 锁成
--      两值，所以这条 CASE 二分不会落进第三种取值。
--   4. UNIQUE 换四元组：草案 §四——「原文授权不能用于脱敏发送，反之亦然」在库里就是键不相等。
--
-- ── 存量行的回填（草案 §二 末段）───────────────────────────────────────
--   存量行一律回填 send_content_mode = 'redacted'，其余列原样拷贝，行为与迁移前逐字一致。
--   这不是猜的：迁移前这张表**只可能**存放过脱敏发送的授权（0008 之前没有原文外发路径，
--   redacted_sha256 又 NOT NULL）。回填后既有红字授权仍可读、仍是 redacted。
--   若存量行里有违反新组合 CHECK 的脏数据（redacted 却无脱敏哈希），拷贝步骤让整份迁移失败并回滚——
--   与 0005/0006 同一立场：宁可拒绝迁移，也不静默丢弃或篡改用户已确认过的授权。
--
-- 可逆性声明：前向迁移、无 down 脚本（schema 层历来如此）。本文件不删任何列、不改任何其它表，
-- 也不新增表：m0 的表集合断言因此不受影响。

-- ── 第 1 步：现有行中转（建新名 → 具名列拷贝，列序变化不会静默错位）──────
CREATE TABLE cloud_send_grant_new (
  id TEXT PRIMARY KEY,
  record_revision_id TEXT NOT NULL,
  -- 本次新增的第四腿（草案 §二）：授权针对哪种内容。取值域是**授权表那一域**（两值），
  -- 不是 0008 记录轴的三值；'none'（不外发）在这里没有意义——不外发就没有授权行。
  send_content_mode TEXT NOT NULL CHECK (send_content_mode IN ('redacted', 'raw')),
  -- 由 NOT NULL 改可空（整表重建的唯一动因）：raw 行没有脱敏文本 ⇒ 没有脱敏哈希。
  redacted_sha256 TEXT CHECK (
    redacted_sha256 IS NULL
    OR (length(redacted_sha256) = 64 AND redacted_sha256 NOT GLOB '*[^0-9a-f]*')
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
  -- mode 与 redacted_sha256 的可空性绑死（草案 §二 的组合 CHECK，NULL 安全的析取式）。
  CHECK (
    (send_content_mode = 'redacted' AND redacted_sha256 IS NOT NULL)
    OR (send_content_mode = 'raw' AND redacted_sha256 IS NULL)
  ),
  -- 四元组（0003 是三元组）：多出的 send_content_mode 让「同一 revision + 同一载荷哈希」在
  -- redacted 与 raw 两条轨道上各自成立，互不顶掉、也互不通用。
  UNIQUE (record_revision_id, send_content_mode, payload_sha256, policy_version),
  FOREIGN KEY (record_revision_id) REFERENCES record_revision (id) ON DELETE CASCADE
) STRICT;

-- ── 第 2 步：存量行回填 'redacted'，其余列原样 ─────────────────────────
INSERT INTO cloud_send_grant_new (
  id,
  record_revision_id,
  send_content_mode,
  redacted_sha256,
  payload_sha256,
  policy_version,
  confirmed_at_utc
)
SELECT id,
  record_revision_id,
  'redacted',
  redacted_sha256,
  payload_sha256,
  policy_version,
  confirmed_at_utc
FROM cloud_send_grant;

-- ── 第 3 步：换名（先 DROP 旧表腾出名字，再 RENAME 回原名）──────────────
-- 顺序不能倒：新表必须先存在，拷贝与旧表才能在同一事务里对上账；DROP 与 RENAME 之间没有别的语句，
-- 窗口内不存在引用该名字的触发器（见文件头引用面清单），故 RENAME 的校验不会踩 0005 那个坑。
DROP TABLE cloud_send_grant;

ALTER TABLE cloud_send_grant_new RENAME TO cloud_send_grant;

-- ── 第 4 步：FK 面自检（把违规变成事务失败，而不是打印一行就过去）──────
-- 与 0006/0008 同一手法：pragma_foreign_key_check 只返回结果集、不报错，而 migrator 在 COMMIT
-- **之后**才跑它。这里用一条「有违规就必然违反 CHECK」的条件守门表让本事务在 COMMIT 前被顶掉并
-- 整份回滚，不留半迁移的库。守卫表随即删除，不进最终 schema（m0 的表集合断言因此不受影响）。
CREATE TABLE _fk_guard_after_rebuild (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

INSERT INTO _fk_guard_after_rebuild
SELECT count(*)
FROM pragma_foreign_key_check;

DROP TABLE _fk_guard_after_rebuild;
