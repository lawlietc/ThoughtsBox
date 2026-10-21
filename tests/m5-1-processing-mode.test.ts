import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { countRows, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M5-1：处理模式写端点与界面接通的服务端验收（任务书 §五 门2/门3 全部断言）。
 * 每个用例独立沙箱 + 独立 boot，走真实 HTTP，绝不碰真实数据目录。
 *
 * 状态边逐字取自 §4.8 冻结转换表与主 Agent 裁定（2026-10-18）：
 * captured+cloud→awaiting_privacy_review；awaiting 离开 cloud→not_processed；
 * 在途 preprocessing/processing 拒绝 409；parsed/needs_reparse 只改 mode 不动状态。
 */

let sandbox: Sandbox;
let booted: BootResult | undefined;
let base = "";

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

function layoutAt(dataDir: string, port: number): DataLayout {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return layout;
}

beforeEach(async () => {
  sandbox = makeSandbox("tb-m5-1-");
  const port = await testPort();
  layoutAt(sandbox.root, port);
  booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (booted !== undefined) {
    await shutdown(booted);
    booted = undefined;
  }
  sandbox.cleanup();
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? undefined : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

async function createRecord(text: string, mode?: string): Promise<string> {
  const created = await api("POST", "/api/records", { text, processing_mode: mode });
  expect(created.status).toBe(201);
  return created.json.record.id as string;
}

async function getRow(id: string): Promise<{ processing_mode: string; processing_status: string }> {
  const detail = await api("GET", `/api/records/${id}`);
  expect(detail.status).toBe(200);
  return {
    processing_mode: detail.json.record.processing_mode,
    processing_status: detail.json.record.processing_status,
  };
}

async function pendingIds(): Promise<string[]> {
  const pending = await api("GET", "/api/ingest/pending?limit=200");
  expect(pending.status).toBe(200);
  return (pending.json.records as { recordId: string }[]).map((r) => r.recordId);
}

/** §4.8 之外的态只能在测试里直接落库伪造（迁移与运行时都不给这条通路）。 */
function forceStatus(id: string, status: string): void {
  if (booted === undefined) throw new Error("未 boot");
  booted.workspace.db
    .prepare("update capture_record set processing_status = ? where id = ?")
    .run(status, id);
}

describe("M5-1 · 400/404：非法模式与不存在的记录", () => {
  it("① 非法 mode → 400，issues 只含字段名，不回显无关内容，mode/status 均不变", async () => {
    const id = await createRecord("改成不存在的档位试试", "local_model");
    const bad = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_direct" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");
    expect(bad.json.issues).toEqual(["processing_mode"]);
    expect(JSON.stringify(bad.json), "错误响应不得回显原文").not.toContain("改成不存在的档位试试");
    expect(await getRow(id)).toEqual({ processing_mode: "local_model", processing_status: "captured" });
  });

  it("⑪ 记录不存在 → 404（复用既有 not_found 语义）", async () => {
    const missing = await api("PATCH", "/api/records/rec_不存在的记录/mode", { processing_mode: "cloud_redacted" });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("建记录传非法 mode → 400，什么都不会写进库", async () => {
    const bad = await api("POST", "/api/records", { text: "非法档位建记录", processing_mode: "auto" });
    expect(bad.status).toBe(400);
    expect(bad.json.issues).toEqual(["processing_mode"]);
    expect(await pendingIds()).toHaveLength(0);
  });
});

describe("M5-1 · 幂等与缺省", () => {
  it("② 同一 mode 重复设置 → 200 changed:false，状态不动", async () => {
    const id = await createRecord("本来就这档", "cloud_redacted");
    expect(await getRow(id)).toEqual({
      processing_mode: "cloud_redacted",
      processing_status: "awaiting_privacy_review",
    });
    const again = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_redacted" });
    expect(again.status).toBe(200);
    expect(again.json.changed).toBe(false);
    expect(again.json.record.processing_mode).toBe("cloud_redacted");
    expect(await getRow(id)).toEqual({
      processing_mode: "cloud_redacted",
      processing_status: "awaiting_privacy_review",
    });
  });

  it("③ 缺省建记录 → manual_only + captured，与扩参前逐字一致（零回归）", async () => {
    const created = await api("POST", "/api/records", { text: "缺省路径的老行为" });
    expect(created.status).toBe(201);
    expect(created.json.record.processing_mode).toBe("manual_only");
    expect(created.json.record.processing_status).toBe("captured");
    expect(created.json.revision.revision_number).toBe(1);
    // manual_only 不计入待整理（enums.processing_rules.manual_only_not_pending）。
    expect(await pendingIds()).not.toContain(created.json.record.id);
  });
});

describe("M5-1 · 建记录即选模式（§4.8 初始态）", () => {
  it("④ 显式 cloud 建记录 → awaiting_privacy_review，出现在待整理", async () => {
    const id = await createRecord("下笔就选云端", "cloud_redacted");
    expect(await getRow(id)).toEqual({
      processing_mode: "cloud_redacted",
      processing_status: "awaiting_privacy_review",
    });
    expect(await pendingIds()).toContain(id);
  });

  it("⑤ 显式 local 建记录 → captured，同样出现在待整理", async () => {
    const id = await createRecord("下笔就选本地", "local_model");
    expect(await getRow(id)).toEqual({ processing_mode: "local_model", processing_status: "captured" });
    expect(await pendingIds()).toContain(id);
  });
});

describe("M5-1 · 改模式的状态边（只走 §4.8 已登记的边）", () => {
  it("⑥ captured 的 local 记录改 cloud → awaiting_privacy_review，进入待整理", async () => {
    const id = await createRecord("先本地后改云端", "local_model");
    const res = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_redacted" });
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(true);
    expect(res.json.record.processing_status).toBe("awaiting_privacy_review");
    expect(await getRow(id)).toEqual({
      processing_mode: "cloud_redacted",
      processing_status: "awaiting_privacy_review",
    });
    expect(await pendingIds()).toContain(id);
  });

  it("⑦ cloud 的 awaiting 记录改 manual → not_processed（冻结表没有 awaiting→captured），随后从待整理消失", async () => {
    const id = await createRecord("云端回退到只自己看", "cloud_redacted");
    expect(await pendingIds()).toContain(id);
    const res = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "manual_only" });
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(true);
    expect(await getRow(id)).toEqual({ processing_mode: "manual_only", processing_status: "not_processed" });
    expect(await pendingIds()).not.toContain(id);
  });

  it("⑧ 选路径 ≠ 授权 ≠ 已解析：改完 cloud 进待整理，但 parse_run 与 cloud_send_grant 计数仍为 0", async () => {
    if (booted === undefined) throw new Error("未 boot");
    const id = await createRecord("改模式不该自动跑任何东西", "local_model");
    await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_redacted" });
    expect(await pendingIds()).toContain(id);
    expect(countRows(booted.workspace.db, "parse_run")).toBe(0);
    expect(countRows(booted.workspace.db, "cloud_send_grant")).toBe(0);
    // 反向改回也不签发、不解析。
    await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "manual_only" });
    expect(countRows(booted.workspace.db, "parse_run")).toBe(0);
    expect(countRows(booted.workspace.db, "cloud_send_grant")).toBe(0);
  });

  it("⑨ 在途 preprocessing / processing 改 mode → 409 state_conflict，mode 不变", async () => {
    for (const status of ["preprocessing", "processing"] as const) {
      const id = await createRecord(`在途态拒绝改模式 ${status}`, "local_model");
      forceStatus(id, status);
      const res = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_redacted" });
      expect(res.status, status).toBe(409);
      expect(res.json.error, status).toBe("state_conflict");
      expect(await getRow(id), status).toEqual({ processing_mode: "local_model", processing_status: status });
    }
  });

  it("⑩ parsed / needs_reparse 改 mode 不动 processing_status；parsed 不因改 mode 被打回 needs_reparse", async () => {
    for (const status of ["parsed", "needs_reparse"] as const) {
      const id = await createRecord(`终态改模式只动 mode ${status}`, "manual_only");
      forceStatus(id, status);
      const res = await api("PATCH", `/api/records/${id}/mode`, { processing_mode: "cloud_redacted" });
      expect(res.status, status).toBe(200);
      expect(res.json.changed, status).toBe(true);
      expect(await getRow(id), status).toEqual({ processing_mode: "cloud_redacted", processing_status: status });
    }
    // not_processed 同样只改 mode 不动状态。
    const back = await createRecord("回退态再选云端", "cloud_redacted");
    await api("PATCH", `/api/records/${back}/mode`, { processing_mode: "manual_only" });
    const res = await api("PATCH", `/api/records/${back}/mode`, { processing_mode: "cloud_redacted" });
    expect(res.status).toBe(200);
    expect(await getRow(back)).toEqual({
      processing_mode: "cloud_redacted",
      processing_status: "not_processed",
    });
  });
});
