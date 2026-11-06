-- 0012_narrow_run_live_index.sql —— M8-2：把 ux_run_live 的谓词从「结果态」收窄到「执行态」
-- 冻结来源：docs/dev-specs/2026-10-28-M8实体转正与重新分析任务拆分与执行准则.md M8-D-7
--
-- ── 0003 原本钉的是什么，为什么它挡住了重新分析 ──────────────────────────
--   `create unique index ux_run_live on parse_run (source_revision_id, pipeline_fingerprint)
--      where result_state in ('candidate', 'current')`                ← 0003:114-116
--   M8-D-4 的重新分析**刻意复用同一条管线**：幂等键追加尝试序号（`idem_<rev>_<fp>_a2`），
--   `pipeline_fingerprint` 一个字节都不变——「换指纹再跑」等于偷偷改管线定义，不是用户按的那个按钮。
--   M8-D-5 又要求旧 run 在用户采纳新候选之前继续留在 `current`：重新分析产出的仍是 candidate，
--   「旧 current + 新 candidate 同时存在」是这一条产品语义的物理形态，不是中间态泄漏。
--   于是旧谓词与本批断言正面冲突：旧行还在索引里占位，新 candidate 一插就撞
--   `UNIQUE constraint failed: parse_run.source_revision_id, parse_run.pipeline_fingerprint`
--   （`tests/m8-2-reanalysis.test.ts` 的 R2–R5 此前因此只能整组跳过）。
--
-- ── 真正要保的不变量是什么 ──────────────────────────────────────────────
--   「同一条逻辑管线为同一个版本至多有一份**在途** run」——同一时刻只有一份工作在飞，
--   重试复用、并发不长第二行。这跟「结果定没定案」无关：定案之后的行是历史，历史可以有很多份。
--   旧谓词把这两件事混在一列里，本次把它拆开：
--   · 在途互斥 → 本索引，谓词 `execution_status in ('queued', 'running')`（0003 的双态 CHECK
--     `NOT (execution_status IN ('queued','running') AND result_state <> 'candidate')` 保证
--     在途行的 result_state 恒为 candidate，所以新谓词是旧谓词在「在途」那一半上的等价物）；
--   · 现行唯一 → `ux_run_current`（0003:112，按 revision 局部唯一，**本迁移不动它**）。
--     旧谓词里 'current' 那一名目负责的是「current 与同指纹的新 candidate 也互斥」，
--     而不是「至多一个 current」——后者一直由 ux_run_current 独家守着，两条同 revision 的
--     current 无论指纹是否相同都先撞它。所以本迁移让路的那一半约束正是 M8-D-5 要推翻的那一半，
--     「现行唯一」与「在途唯一」两条不变量一条没少。
--
-- ── 本迁移不做的事 ──────────────────────────────────────────────────────
--   · 不动任何表、不改任何数据：只 drop/recreate 一条命名索引，`parse_run` 的列、CHECK、FK 逐字不变。
--   · 不新增表 ⇒ m0 的表集合断言只多一个迁移文件名，不多一张表。
--   · 不改 0003（sha256 漂移守护 + 禁区「已有 SQL 一字节不动」）：约束的演进只能靠往后叠一层。
--   · 不放宽 `ux_run_current`，也不新增任何索引。
--
-- ── 幂等与安全 ──────────────────────────────────────────────────────────
--   新谓词圈住的是旧谓词圈住行的**真子集**：0003 的组合 CHECK 保证 queued/running 的行恒为
--   candidate，而 candidate 在旧清单里。旧索引能容纳的库，任意两行同 (revision, 指纹) 至多一个
--   candidate/current ⇒ 在途那一半至多一个 ⇒ 按新谓词重建必然成功。
--   失败即整事务回滚（migrator 的 BEGIN IMMEDIATE），不留半迁移库。
--   `drop index ux_run_live` 不写 `if exists`：本文件只会被 migrator 按版本号执行一次，
--   索引缺席是一种真事故，该让 DROP 当场报错而不是静默跳过。
--
-- ── 下游账 ──────────────────────────────────────────────────────────────
--   · 索引名不变 ⇒ `src/server/runtime/dataCheck.ts` 的 REQUIRED_DERIVED 点名面照旧命中。
--   · 两条既有断言钉的是旧谓词，随本迁移一并收账（**只许更强**）：
--     `tests/m2-schema-contract.test.ts` 的 ux_run_live 用例、`tests/m2-ingest-service.test.ts` 的同名用例。
--   · 与 M8-D-8 的配合：单进程内 beginRun 全同步，「查在途」与「插入」同一 tick，
--     应用层在 reanalysis 时先查 queued/running 并拒绝（409），本索引则是这条不变量的物理底线。

-- 旧谓词的索引整体作废：连带它按 result_state 建立的全部键一起消失。
DROP INDEX ux_run_live;

-- 同一条管线（revision + 指纹）至多一份在途 run：queued/running 互斥，已定案的行不再占位。
CREATE UNIQUE INDEX ux_run_live ON parse_run (source_revision_id, pipeline_fingerprint)
WHERE
  execution_status IN ('queued', 'running');
