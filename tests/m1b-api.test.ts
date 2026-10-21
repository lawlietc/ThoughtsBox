import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { BACKUP_FILE_PATTERN } from "../src/server/backup/backupService.ts";
import { HEAD_SCHEMA_VERSION, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * 数据管理 API 的端到端验收（M1b §10.1）：一律真实 boot、真实 fetch，
 * 不 mock——备份/导入/恢复的效果都从 HTTP 面重新读回来验证。
 */

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;

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
      probe.close(() => resolve(address.port));
    });
  });
}

function bootLayout(dataDir: string, port: number): DataLayout {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return layout;
}

async function startApp(): Promise<{ base: string; layout: DataLayout }> {
  sandbox = makeSandbox("tb-m1b-api-");
  const port = await testPort();
  const layout = bootLayout(sandbox.root, port);
  booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
  return { base: `http://127.0.0.1:${port}`, layout };
}

async function stopApp(): Promise<void> {
  if (booted) {
    await shutdown(booted);
    booted = undefined;
  }
  if (sandbox) {
    sandbox.cleanup();
    sandbox = undefined;
  }
}

afterEach(stopApp);

async function createRecordViaApi(base: string, text: string): Promise<{ record: { id: string } }> {
  const res = await fetch(`${base}/api/records`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { record: { id: string } };
}

describe("备份 API", () => {
  it("创建 → 列表 → 校验 → 删除的完整闭环，全部经 HTTP 面观察", async () => {
    const { base } = await startApp();
    await createRecordViaApi(base, "备份闭环演练");

    const created = await fetch(`${base}/api/backups`, { method: "POST" });
    expect(created.status).toBe(201);
    const { backup } = (await created.json()) as { backup: { name: string; sizeBytes: number; verification: { status: string } | null } };
    expect(backup.name).toMatch(BACKUP_FILE_PATTERN);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.verification?.status).toMatch(/^ok/);

    const listed = await (await fetch(`${base}/api/backups`)).json() as {
      backups: unknown[];
      totalBytes: number;
      lastBackupUtc: string | null;
      lastSuccessUtc: string | null;
      disk: { available: boolean };
    };
    expect(listed.backups).toHaveLength(1);
    expect(listed.totalBytes).toBe(backup.sizeBytes);
    expect(listed.lastBackupUtc).not.toBeNull();
    expect(listed.lastSuccessUtc).not.toBeNull();
    // 磁盘容量：可得就报实值，不可得如实受限——不许把「读不到」伪装成充足。
    expect(typeof listed.disk.available).toBe("boolean");

    const verified = await (await fetch(`${base}/api/backups/${backup.name}/verify`, { method: "POST" })).json() as {
      verification: { status: string };
    };
    expect(verified.verification.status).toBe("ok");

    const deleted = await fetch(`${base}/api/backups/${backup.name}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const afterDelete = await (await fetch(`${base}/api/backups`)).json() as { backups: unknown[] };
    expect(afterDelete.backups).toHaveLength(0);

    // 删后再删：不存在就是 404，而不是假装成功。
    const again = await fetch(`${base}/api/backups/${backup.name}`, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: string }).error).toBe("backup_not_found");
  });

  it("路径穿越与无关文件名一律 404，绝不落到文件系统层", async () => {
    const { base } = await startApp();
    for (const name of ["..%2F..%2Foutside.sqlite", "evil.sqlite", "snapshot-20261013T000000Z-00000000-0000-0000-0000-000000000000.sqlite"]) {
      const res = await fetch(`${base}/api/backups/${name}/verify`, { method: "POST" });
      expect(res.status).toBe(404);
    }
  });

  it("对不存在的合法快照名校验：如实返回 failed 结论而不是 500", async () => {
    const { base } = await startApp();
    const res = await fetch(
      `${base}/api/backups/snapshot-20261013T000000Z-018f3c2e-9d4a-7c1b-8a2f-1e6d5c4b3a29.sqlite/verify`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verification: { status: string; detail: string } };
    expect(body.verification.status).toBe("failed");
    expect(body.verification.detail).toMatch(/无法打开|校验异常/);
  });
});

describe("导出/导入 API", () => {
  it("导出：ndjson + 附件名 + meta 首行 + 行数与内容一致", async () => {
    const { base } = await startApp();
    const a = await createRecordViaApi(base, "导出演练甲");
    await fetch(`${base}/api/records/${a.record.id}`, { method: "PUT", body: JSON.stringify({ text: "导出演练甲（第二版）" }) });
    await createRecordViaApi(base, "导出演练乙");

    const res = await fetch(`${base}/api/export/jsonl`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("x-ndjson");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="thoughtsbox-export-\d{8}T\d{6}Z\.jsonl"/);
    const text = await res.text();
    const lines = text.trimEnd().split("\n");
    const meta = JSON.parse(lines[0]!) as { line: string; object_types: string[]; excluded_types: string[]; export_schema_version: number };
    expect(meta.line).toBe("meta");
    expect(meta.export_schema_version).toBe(1);
    expect(meta.object_types).toEqual(["capture_record", "record_revision"]);
    expect(meta.excluded_types).toContain("deletion_audit");
    // 2 条记录 + 3 个版本 = 5 行数据行
    expect(lines).toHaveLength(6);
  });

  it("导入非空库被 409 拒之门外，一个字节都不写", async () => {
    const { base } = await startApp();
    const kept = await createRecordViaApi(base, "导入门槛演练");
    const exportText = await (await fetch(`${base}/api/export/jsonl`)).text();

    const res = await fetch(`${base}/api/import/jsonl`, { method: "POST", body: exportText });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("target_not_empty");
    const list = await (await fetch(`${base}/api/records`)).json() as { records: { id: string }[] };
    expect(list.records.map((r) => r.id)).toEqual([kept.record.id]);
  });

  it("坏导入 400 带逐行问题清单；导出文本经 HTTP 往返可完整落回空库", async () => {
    const { base, layout } = await startApp();
    await createRecordViaApi(base, "往返演练：源头");
    const exportText = await (await fetch(`${base}/api/export/jsonl`)).text();

    // 换一台「空机器」：同目录删库重启（迁移重建空 schema）。
    // 空库门槛先过，坏行才可能触达逐行校验面——顺序本身也是契约的一部分。
    await shutdown(booted!);
    booted = undefined;
    rmSync(layout.dbFile, { force: true });
    rmSync(`${layout.dbFile}-wal`, { force: true });
    rmSync(`${layout.dbFile}-shm`, { force: true });
    booted = await boot({ env: { TB_DATA_DIR: sandbox!.root }, log: () => {} });

    const bad = await fetch(`${base}/api/import/jsonl`, { method: "POST", body: "这不是JSONL\n" });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; issues: string[] };
    expect(badBody.error).toBe("invalid_import");
    expect(badBody.issues[0]).toMatch(/第 1 行/);

    const imported = await fetch(`${base}/api/import/jsonl`, { method: "POST", body: exportText });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ records: 1, revisions: 1 });

    const list = (await (await fetch(`${base}/api/records`)).json()) as { records: { id: string }[] };
    expect(list.records).toHaveLength(1);
    const hits = (await (await fetch(`${base}/api/search?q=往返`)).json()) as { hits: unknown[] };
    expect(hits.hits).toHaveLength(1);
  });
});

describe("恢复与自检 API", () => {
  it("恢复要显式 confirm；成功后现库回到备份时刻，后续写入走新句柄", async () => {
    const { base } = await startApp();
    const a = await createRecordViaApi(base, "恢复演练：备份内状态");
    const { backup } = (await (await fetch(`${base}/api/backups`, { method: "POST" })).json()) as { backup: { name: string } };
    await createRecordViaApi(base, "恢复后会消失的记录");

    const noConfirm = await fetch(`${base}/api/restore`, {
      method: "POST",
      body: JSON.stringify({ file: backup.name }),
    });
    expect(noConfirm.status).toBe(400);
    expect(((await noConfirm.json()) as { error: string }).error).toBe("confirm_required");
    // 未确认 = 零动作：库还是库，快照一条没多
    const listBefore = (await (await fetch(`${base}/api/records`)).json()) as { total: number };
    expect(listBefore.total).toBe(2);

    const restored = await fetch(`${base}/api/restore`, {
      method: "POST",
      body: JSON.stringify({ file: backup.name, confirm: true }),
    });
    expect(restored.status).toBe(200);
    const result = (await restored.json()) as { restoredFrom: string; safetyBackupName: string; records: number };
    expect(result.restoredFrom).toBe(backup.name);
    expect(result.safetyBackupName).toMatch(/^prerestore-/);
    expect(result.records).toBe(1);

    const list = (await (await fetch(`${base}/api/records`)).json()) as { records: { id: string }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.records[0]!.id).toBe(a.record.id);
    const revived = (await (await fetch(`${base}/api/records/${a.record.id}`)).json()) as {
      current: { raw_text: string };
    };
    expect(revived.current.raw_text).toBe("恢复演练：备份内状态");

    // 换血后的服务照常可用
    const after = await createRecordViaApi(base, "恢复后继续记录");
    expect(after.record.id).toMatch(/^rec_/);
  });

  it("恢复不存在的备份：拒绝且带得出拒绝原因（校验发生在动库之前）", async () => {
    const { base } = await startApp();
    const res = await fetch(`${base}/api/restore`, {
      method: "POST",
      body: JSON.stringify({ file: "snapshot-20261013T000000Z-018f3c2e-9d4a-7c1b-8a2f-1e6d5c4b3a29.sqlite", confirm: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("restore_rejected");
    expect(body.detail).toMatch(/恢复被拒绝/);
  });

  it("数据面自检端点：健康库报六项通过", async () => {
    const { base } = await startApp();
    await createRecordViaApi(base, "自检端点演练");
    const report = (await (await fetch(`${base}/api/data-check`)).json()) as {
      ok: boolean;
      schemaVersion: number;
      passedSteps: string[];
      searchIndexRebuilt: boolean;
    };
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
    expect(report.passedSteps).toHaveLength(6);
    expect(report.searchIndexRebuilt).toBe(false);
  });

  it("方法错误 405、未知子路径 404：数据管理命名空间内的边界清晰", async () => {
    const { base } = await startApp();
    const wrongMethod = await fetch(`${base}/api/restore`);
    expect(wrongMethod.status).toBe(405);
    const unknownPath = await fetch(`${base}/api/backups/a/b/c`);
    expect(unknownPath.status).toBe(404);
    expect(((await unknownPath.json()) as { error: string }).error).toBe("not_found");
  });
});
