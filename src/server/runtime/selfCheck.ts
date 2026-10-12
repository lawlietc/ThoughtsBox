import { randomUUIDv7 } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContracts } from "../../shared/contracts/load.ts";
import { applyPragmas, openDatabase, sqliteVersion, type Database } from "../db/adapter.ts";
import { migrate } from "../db/migrator.ts";

export class SelfCheckFailure extends Error {
  readonly capability: string;
  constructor(capability: string, detail: string) {
    super(`启动自检失败，缺失能力【${capability}】：${detail}`);
    this.name = "SelfCheckFailure";
    this.capability = capability;
  }
}

export type CheckOutcome = { ok: true } | { ok: false; capability: string; detail: string };

export interface SelfCheckContext {
  readonly tmpRoot: string;
  /** 受检能力可注入，让"某能力缺失"成为可测分支，而不是写在文档里的假设。 */
  readonly uuidv7?: (() => string) | undefined;
}

export interface SelfCheckStep {
  readonly id: string;
  readonly capability: string;
  run(context: SelfCheckContext): CheckOutcome;
}

function isolated(tmpRoot: string, body: (db: Database) => CheckOutcome, capability: string): CheckOutcome {
  const dir = mkdtempSync(join(tmpRoot, "tb-selfcheck-"));
  let db: Database | undefined;
  try {
    db = openDatabase(join(dir, "selfcheck.sqlite"));
    return body(db);
  } catch (cause) {
    return { ok: false, capability, detail: (cause as Error).message };
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SELF_CHECK_STEPS: readonly SelfCheckStep[] = [
  {
    id: "sqlite",
    capability: "node:sqlite 数据库构造器",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          db.exec("create table probe(x integer); insert into probe values (1);");
          const row = db.prepare("select x from probe").get() as { x: number };
          return row.x === 1
            ? { ok: true }
            : { ok: false, capability: "node:sqlite 数据库构造器", detail: "写入后读回不为 1" };
        },
        "node:sqlite 数据库构造器",
      ),
  },
  {
    id: "fts5",
    capability: "FTS5 虚拟表",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          db.exec("create virtual table t using fts5(x); insert into t values ('难堪');");
          const row = db.prepare("select count(*) as n from t where t match '难堪'").get() as { n: number };
          return row.n === 1
            ? { ok: true }
            : { ok: false, capability: "FTS5 虚拟表", detail: "MATCH 未命中已写入内容" };
        },
        "FTS5 虚拟表",
      ),
  },
  {
    id: "ecosystem-fts5",
    capability: "external-content FTS5 与删除触发器",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          // 规格 §7.2 硬约束：独立 FTS5 的影子表不受 secure_delete 覆盖，索引必须是 external-content 形态。
          db.exec(`create table doc(id integer primary key, body text);
                   create virtual table doc_fts using fts5(body, content='doc', content_rowid='id');
                   create trigger doc_ai after insert on doc begin
                     insert into doc_fts(rowid, body) values (new.id, new.body);
                   end;
                   create trigger doc_ad after delete on doc begin
                     insert into doc_fts(doc_fts, rowid, body) values('delete', old.id, old.body);
                   end;
                   insert into doc(id, body) values (1, '删除我');`);
          db.exec("delete from doc where id = 1;");
          const row = db.prepare("select count(*) as n from doc_fts where doc_fts match '删除'").get() as { n: number };
          return row.n === 0
            ? { ok: true }
            : {
                ok: false,
                capability: "external-content FTS5 与删除触发器",
                detail: "删除后索引仍命中，说明删除路径没有同步到索引",
              };
        },
        "external-content FTS5 与删除触发器",
      ),
  },
  {
    id: "secure-delete",
    capability: "PRAGMA secure_delete",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          applyPragmas(db);
          // 实测：secure_delete 是**每连接**设置，重开连接即回到 0（WAL 才是文件头持久化）。
          // 所以它的读回值必须显式检查，否则删除保护会在某个连接上静默失效。
          const row = db.prepare("pragma secure_delete").get() as { secure_delete: number };
          return row.secure_delete === 1
            ? { ok: true }
            : { ok: false, capability: "PRAGMA secure_delete", detail: `设置后读回为 ${row.secure_delete}` };
        },
        "PRAGMA secure_delete",
      ),
  },
  {
    id: "vacuum-into",
    capability: "VACUUM INTO 与 integrity_check",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          db.exec("create table m(x text); insert into m values ('a');");
          const target = join(ctx.tmpRoot, `snapshot-${randomUUIDv7()}.sqlite`);
          db.prepare("vacuum into ?").run(target);
          const snap = openDatabase(target);
          try {
            const row = snap.prepare("pragma integrity_check").get() as { integrity_check: string };
            return row.integrity_check === "ok"
              ? { ok: true }
              : {
                  ok: false,
                  capability: "VACUUM INTO 与 integrity_check",
                  detail: `integrity_check = ${row.integrity_check}`,
                };
          } finally {
            snap.close();
            rmSync(target, { force: true });
          }
        },
        "VACUUM INTO 与 integrity_check",
      ),
  },
  {
    id: "uuidv7",
    capability: "crypto.randomUUIDv7",
    run: (ctx) => {
      const generate = ctx.uuidv7;
      if (typeof generate !== "function") {
        return {
          ok: false,
          capability: "crypto.randomUUIDv7",
          detail: "运行时不提供该函数（需 Node >= 24.16.0）。不降级、不自实现。",
        };
      }
      const sample = generate();
      const versionNibble = sample.charAt(14);
      return versionNibble === "7"
        ? { ok: true }
        : {
            ok: false,
            capability: "crypto.randomUUIDv7",
            detail: `生成值的版本位是 ${versionNibble}，期望 7：${sample}`,
          };
    },
  },
  {
    id: "migrations",
    capability: "迁移机制（可执行且可重放）",
    run: (ctx) =>
      isolated(
        ctx.tmpRoot,
        (db) => {
          applyPragmas(db);
          const first = migrate(db);
          const second = migrate(db);
          return first.schemaVersion >= 1 && second.applied.length === 0
            ? { ok: true }
            : {
                ok: false,
                capability: "迁移机制（可执行且可重放）",
                detail: `首轮版本 ${first.schemaVersion}，重放又执行了 ${second.applied.length} 份`,
              };
        },
        "迁移机制（可执行且可重放）",
      ),
  },
  {
    id: "contracts",
    capability: "词表与枚举数据契约",
    run: () => {
      try {
        loadContracts();
        return { ok: true };
      } catch (cause) {
        return { ok: false, capability: "词表与枚举数据契约", detail: (cause as Error).message };
      }
    },
  },
];

export interface SelfCheckReport {
  readonly ok: true;
  readonly sqliteVersion: string;
  readonly passed: string[];
  readonly contractsFingerprint: string;
}

export interface SelfCheckOptions {
  readonly steps?: readonly SelfCheckStep[];
  readonly tmpRoot?: string;
  readonly uuidv7?: (() => string) | undefined;
}

/**
 * 启动自检（ADR-013、M0 交付物 3）：按顺序检查能力，缺失时抛 SelfCheckFailure 并带上**具体能力名**。
 * 全程只在临时目录内进行，绝不触碰用户数据目录；失败不降级、不猜测、不自实现替代 API。
 */
export function runSelfCheck(options: SelfCheckOptions = {}): SelfCheckReport {
  const steps = options.steps ?? SELF_CHECK_STEPS;
  const ownsTmp = options.tmpRoot === undefined;
  const tmpRoot = options.tmpRoot ?? mkdtempSync(join(tmpdir(), "tb-startup-"));
  const context: SelfCheckContext = {
    tmpRoot,
    // 用 in 判断：显式传 undefined 表示"这个能力不存在"，不传才用真实实现。
    uuidv7: "uuidv7" in options ? options.uuidv7 : randomUUIDv7,
  };
  try {
    const passed: string[] = [];
    for (const step of steps) {
      const outcome = step.run(context);
      if (!outcome.ok) throw new SelfCheckFailure(outcome.capability, outcome.detail);
      passed.push(step.capability);
    }
    const probeDir = mkdtempSync(join(tmpRoot, "tb-version-"));
    let version = "";
    try {
      const probe = openDatabase(join(probeDir, "version.sqlite"));
      try {
        version = sqliteVersion(probe);
      } finally {
        probe.close();
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
    return {
      ok: true,
      sqliteVersion: version,
      passed,
      contractsFingerprint: loadContracts().fingerprint,
    };
  } finally {
    if (ownsTmp) rmSync(tmpRoot, { recursive: true, force: true });
  }
}
