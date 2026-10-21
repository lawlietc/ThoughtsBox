import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { DataCheckFailure, missingDataPlaneObjects, runDataCheck } from "../src/server/runtime/dataCheck.ts";
import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";
import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import {
  HEAD_SCHEMA_VERSION,
  makeSandbox,
  openSandboxDb,
  type Sandbox,
} from "./helpers/sandbox.ts";
import { makeAdapter, OK_ENVELOPE, stubTransport, SYSTEM_PROMPT, validOutput, FIXTURE_NOW } from "./helpers/ingestFixtures.ts";

/**
 * M2-6 启动整合与数据面演进的验收（§13.2 / §十二 / dataCheck 分层）。
 *
 * 三条硬约束逐一钉死：
 *  1. T-13 时序不削弱：数据面自检仍在迁移+播种之后、对外服务之前；新服务（IngestService
 *     Provider 装配、CorrectionService、GrantService）在自检之后才装配，自检失败照样 fail-fast。
 *  2. dataCheck 分层不误伤也不放任：v2/v3 库不该被要求具备修正层对象；v4+ 缺对象必须点名失败。
 *  3. 默认 boot 无 Provider 装配 → 解析面显式拒绝（503），绝不拿半套配置假装能发送。
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
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function providerBundle() {
  const stub = stubTransport(OK_ENVELOPE(validOutput()));
  return {
    adapter: makeAdapter(),
    transport: stub.transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
  };
}

/** 用空闲端口写进配置，boot 前完成（避免与用户可能正在跑的默认端口实例相撞）。 */
function setBootPort(dataDir: string, port: number): void {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  if (booted !== undefined) {
    await shutdown(booted);
    booted = undefined;
  }
  if (sandbox !== undefined) {
    sandbox.cleanup();
    sandbox = undefined;
  }
});

describe("M2-6 启动整合（服务进入 boot + T-13 时序）", () => {
  it("注入 Provider 装配后 boot 成功：自检日志先于解析能力日志，锁正常释放", async () => {
    sandbox = makeSandbox("tb-m2-boot-order-");
    setBootPort(sandbox.root, await testPort());
    const lines: string[] = [];
    booted = await boot({
      env: { TB_DATA_DIR: sandbox.root },
      log: (l) => lines.push(l),
      ingestProvider: providerBundle(),
    });
    const dataCheckIdx = lines.findIndex((l) => l.includes("数据面自检通过"));
    const ingestIdx = lines.findIndex((l) => l.includes("解析能力就绪"));
    const healthIdx = lines.findIndex((l) => l.includes("/api/health"));
    expect(dataCheckIdx).toBeGreaterThanOrEqual(0);
    expect(ingestIdx).toBeGreaterThanOrEqual(0);
    // 自检在解析装配之前、对外服务之前——新服务不得绕过启动顺序。
    expect(dataCheckIdx).toBeLessThan(ingestIdx);
    expect(ingestIdx).toBeLessThan(healthIdx);
    expect(booted.workspace.ingestReady).toBe(true);
    expect(booted.workspace.corrections).toBeTruthy();
    expect(booted.workspace.grants).toBeTruthy();

    const released = await shutdown(booted);
    booted = undefined;
    expect(released.released).toBe(true);
    expect(existsSync(sandbox.layout.lockFile)).toBe(false);
    sandbox.cleanup();
    sandbox = undefined;
  });

  it("默认 boot 不装配 Provider：解析面显式拒绝（503），不假装能发", async () => {
    sandbox = makeSandbox("tb-m2-boot-noprov-");
    const port = await testPort();
    setBootPort(sandbox.root, port);
    booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
    expect(booted.workspace.ingestReady).toBe(false);

    // 建一条 local_model 记录（默认 manual_only，改模式仅为逼近真实解析意图）。
    const created = booted.workspace.records.createRecord("待解析但无 Provider 的记录");
    const recordId = created.record.id;
    booted.db.prepare("update capture_record set processing_mode = 'local_model' where id = ?").run(recordId);

    const res = await fetch(`http://127.0.0.1:${port}/api/ingest/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ingest_unavailable");
  });

  it("单实例锁在自检之前：第二实例进不了服务面", async () => {
    sandbox = makeSandbox("tb-m2-boot-single-");
    setBootPort(sandbox.root, await testPort());
    booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {}, ingestProvider: providerBundle() });
    await expect(boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} })).rejects.toBeTruthy();
  });
});

describe("dataCheck 修正层版本分层（不误伤 v2/v3，放任 v4+）", () => {
  it("v3 判据不点名修正层对象；v4 判据点名——同一物理库、不同版本结论不同", () => {
    sandbox = makeSandbox("tb-m2-dc-layer-");
    const db = openSandboxDb(sandbox.layout);
    migrate(db);
    seedVocabulary(db);
    try {
      // 抽掉修正层两张表（连同其上触发器一起消失）。
      db.exec("drop table user_scalar_override");
      db.exec("drop table user_collection_patch");

      // 关键：库仍是 v5，但用不同 schemaVersion 参数分别问「这个版本该有什么」。
      const atV3 = missingDataPlaneObjects(db, 3);
      expect(atV3).not.toContain("表 user_scalar_override");
      expect(atV3).not.toContain("表 user_collection_patch");

      const atV4 = missingDataPlaneObjects(db, 4);
      expect(atV4).toContain("表 user_scalar_override");
      expect(atV4).toContain("表 user_collection_patch");
    } finally {
      db.close();
    }
  });

  it("完整迁移库通过全部六步，修正层对象已就位", () => {
    sandbox = makeSandbox("tb-m2-dc-full-");
    const db = openSandboxDb(sandbox.layout);
    migrate(db);
    seedVocabulary(db);
    try {
      const report = runDataCheck(db);
      expect(report.schemaVersion).toBe(HEAD_SCHEMA_VERSION);
      expect(report.passedSteps).toHaveLength(6); // 步骤数不因新增对象而变——仍是同一套判据
      expect(missingDataPlaneObjects(db, HEAD_SCHEMA_VERSION)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("缺修正层对象时 boot fail-fast：自检点名表名、释放锁、不带坏现场开门", async () => {
    sandbox = makeSandbox("tb-m2-dc-block-");
    setBootPort(sandbox.root, await testPort());
    // 先正常 boot 建库，再关掉，离线抽掉修正层表，然后期望 boot 失败。
    const first = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
    first.workspace.records.createRecord("供自检的样本");
    const layout = first.layout;
    await shutdown(first);

    const offline = openSandboxDb(layout);
    offline.exec("drop table user_scalar_override");
    offline.close();

    let caught: unknown;
    try {
      await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(DataCheckFailure);
    expect((caught as DataCheckFailure).step).toBe("required-objects");
    expect((caught as DataCheckFailure).detail).toContain("表 user_scalar_override");
    expect(existsSync(layout.lockFile)).toBe(false);
    expect(existsSync(layout.dbFile)).toBe(true); // 失败不毁现场
  });
});
