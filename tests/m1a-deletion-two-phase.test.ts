import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";
import { migrate, getMeta, setMeta } from "../src/server/db/migrator.ts";
import { RecordService, STORAGE_MAINTENANCE_KEY } from "../src/server/records/service.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

/**
 * 删除两阶段五项断言（M1 开发规格·约束二，2026-10-12 用户补充约束）。
 * 编号 D1–D5 与原文 ①–⑤ 一一对应，每项独立成测，不合并、不弱化。
 */

let sandbox: Sandbox;
let db: ReturnType<typeof openSandboxDb>;

function makeService(options?: { storageMaintenance?: () => void }): RecordService {
  return new RecordService(db, {
    timezoneId: "Asia/Shanghai",
    now: () => new Date("2026-10-12T06:30:00Z"),
    ...(options?.storageMaintenance === undefined
      ? undefined
      : { storageMaintenance: () => options.storageMaintenance!() }),
  });
}

function seedRecord(text: string): { id: string; revisionId: string } {
  const { record, revision } = makeService().createRecord(text);
  return { id: record.id, revisionId: revision.id };
}

async function testPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法取得空闲端口"));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/** 开发服务可能占着模板默认端口；测试固定改用一次性空闲端口。 */
function setBootPort(dataDir: string, port: number): void {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  sandbox = makeSandbox("tb-m1a-delete-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

function count(table: string): number {
  return (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
}

/** JSON 响应形状断言用宽类型收口在读取边界（与 m1a-api 的 api() 同一手法）。 */
async function jsonOf(res: Response): Promise<any> {
  return (await res.json()) as any;
}

describe("约束二·D1 业务删除事务成功提交与否可独立判定", () => {
  it("成功路径：phaseA.committed 独立成立，审计与实际删除行数一致", () => {
    const { id } = seedRecord("会被删除的记录");
    makeService().editRecord(id, "会被删除的记录（第二版）");
    const result = makeService().deleteRecord(id);
    expect(result.phaseA).toEqual({ committed: true, revisionsRemoved: 2 });
    expect(count("deletion_audit")).toBe(1);
  });

  it("失败注入（提交前 RAISE 中止）：整体回滚，无半删数据、无不一致审计、索引无残留", () => {
    const { id, revisionId } = seedRecord("注入失败测试原文");
    db.exec("create trigger sabotage before delete on capture_record begin select raise(abort,'注入的删除失败'); end;");
    try {
      expect(() => makeService().deleteRecord(id)).toThrow(/注入的删除失败/);
    } finally {
      db.exec("drop trigger sabotage");
    }
    // 阶段 A 未提交 ⇒ 记录、版本、索引、审计四处保持原状，且没有 phaseB 被触发。
    expect(count("capture_record")).toBe(1);
    expect(count("record_revision")).toBe(1);
    expect(count("deletion_audit")).toBe(0);
    const fts = db.prepare("select count(*) as n from record_fts where record_fts match '注入'").get() as { n: number };
    expect(fts.n).toBe(1);
    expect(makeService().searchRecords("注入").hits.map((h) => h.id)).toEqual([revisionId]);
    // 失败后可重试成功（事务失败不粘滞）。
    expect(makeService().deleteRecord(id).phaseA.committed).toBe(true);
  });
});

describe("约束二·D2 Phase B 存储清理的成功/失败有明确状态", () => {
  it("成功：phaseB.status = ok", () => {
    const { id } = seedRecord("正常清理");
    expect(makeService().deleteRecord(id).phaseB).toEqual({ status: "ok" });
  });

  it("失败：phaseB.status = pending 并携带失败细节，而非异常或回滚", () => {
    const { id } = seedRecord("清理失败场景");
    const service = makeService({
      storageMaintenance: () => {
        throw new Error("checkpoint 被占用");
      },
    });
    const result = service.deleteRecord(id);
    expect(result.phaseB).toEqual({ status: "pending", detail: "checkpoint 被占用" });
  });
});

describe("约束二·D3 清理失败的持久化记录、用户提示与重试入口被测试覆盖，绝不报告为整体回滚", () => {
  it("pending 任务持久化到 app_meta，含操作/对象/失败步骤/时间四要素", () => {
    const { id } = seedRecord("需要持久化待清理状态");
    const failing = makeService({
      storageMaintenance: () => {
        throw new Error("磁盘忙");
      },
    });
    failing.deleteRecord(id);
    const raw = getMeta(db, "storage_maintenance_pending");
    expect(raw).toBeDefined();
    const tasks = JSON.parse(raw!) as Record<string, string>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ operation: "delete", object_id: id, failed_step: "wal_checkpoint_truncate" });
    expect(typeof tasks[0]!.ts).toBe("string");
  });

  it("API 呈现：删除成功响应不误报回滚；pending 任务经状态端点提示、经重试入口清除", async () => {
    let booted: BootResult | undefined;
    try {
      setBootPort(sandbox.root, await testPort());
      booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
      const port = booted.loaded.config.server.port;
      const base = `http://127.0.0.1:${port}`;
      const created = await jsonOf(
        await fetch(`${base}/api/records`, {
          method: "POST",
          body: JSON.stringify({ text: "从 API 删除并观察两段状态" }),
        }),
      );
      const removed = await jsonOf(
        await fetch(`${base}/api/records/${created.record.id as string}`, { method: "DELETE" }),
      );
      // 成功路径两段状态都必须是明确的成功值，而不是省略或含糊。
      expect(removed.phaseA.committed).toBe(true);
      expect(removed.phaseB).toEqual({ status: "ok" });

      // 模拟一条 Phase B 失败的持久化任务（与 D3 第一用例同一存储结构），
      // 验证用户提示端点与重试入口都真实可用。
      const pendingTask = {
        operation: "delete" as const,
        object_id: created.record.id as string,
        failed_step: "wal_checkpoint_truncate",
        ts: "2026-10-12T06:30:00.000Z",
      };
      setMeta(db, STORAGE_MAINTENANCE_KEY, JSON.stringify([pendingTask]));

      const shown = await jsonOf(await fetch(`${base}/api/storage-maintenance`));
      expect(shown.pending).toEqual([pendingTask]);
      const retried = await jsonOf(
        await fetch(`${base}/api/storage-maintenance/retry`, { method: "POST" }),
      );
      expect(retried).toMatchObject({ ok: true, resolvedTasks: 1 });
      const cleared = await jsonOf(await fetch(`${base}/api/storage-maintenance`));
      expect(cleared).toEqual({ pending: [] });
    } finally {
      if (booted !== undefined) await shutdown(booted);
    }
  });
});

describe("约束二·D4 重试幂等", () => {
  it("清理仍失败时重试不叠加副作用；成功后任务清空，再重试为无害空操作", () => {
    const { id } = seedRecord("重试幂等场景");
    let checkpointCalls = 0;
    const failing = makeService({
      storageMaintenance: () => {
        checkpointCalls += 1;
        throw new Error("仍然被占用");
      },
    });
    failing.deleteRecord(id);
    const auditAfterDelete = count("deletion_audit");

    const firstRetry = failing.retryStorageMaintenance();
    expect(firstRetry.ok).toBe(false);
    expect(failing.getMaintenanceTasks()).toHaveLength(1);

    // 换成能成功的维护路径（新服务实例共享同一库连接），任务被清、计数正确。
    const healthy = makeService();
    const okRetry = healthy.retryStorageMaintenance();
    expect(okRetry).toEqual({ ok: true, resolvedTasks: 1 });
    expect(healthy.getMaintenanceTasks()).toHaveLength(0);

    const noop = healthy.retryStorageMaintenance();
    expect(noop).toEqual({ ok: true, resolvedTasks: 0 });
    // 副作用核查：重试从不产生新审计、从不复活数据。
    expect(count("deletion_audit")).toBe(auditAfterDelete);
    expect(count("capture_record")).toBe(0);
    expect(checkpointCalls).toBe(2);
  });
});

describe("约束二·D5 应用重启后待清理任务可被恢复检测", () => {
  it("带 pending 任务重启：boot 检出并走同一幂等重试路径清空任务", async () => {
    setBootPort(sandbox.root, await testPort());
    const { id } = seedRecord("崩溃残留的待清理场景");
    const failing = makeService({
      storageMaintenance: () => {
        throw new Error("模拟崩溃前未完成清理");
      },
    });
    failing.deleteRecord(id);
    expect(failing.getMaintenanceTasks()).toHaveLength(1);
    db.close(); // 模拟进程终止（afterEach 的 close 走 force 路径）

    const logs: string[] = [];
    let booted: BootResult | undefined;
    try {
      booted = await boot({
        env: { TB_DATA_DIR: sandbox.root },
        log: (line) => logs.push(line),
      });
      expect(logs.some((line) => line.includes("检测到 1 项待清理存储维护任务"))).toBe(true);
      expect(logs.some((line) => line.includes("重试完成，清理 1 项"))).toBe(true);
      expect(booted.records.getMaintenanceTasks()).toHaveLength(0);
    } finally {
      if (booted !== undefined) await shutdown(booted);
      db = openSandboxDb(sandbox.layout);
    }
  });
});
