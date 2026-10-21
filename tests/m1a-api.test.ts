import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigFile } from "../src/server/config/config.ts";
import { resolveDataLayout, type DataLayout } from "../src/server/config/paths.ts";
import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M1a 业务 API 的端到端验收（用户裁决⑤：M1a 必须有实际业务 API）。
 * 每个用例独立沙箱 + 独立 boot，走真实 HTTP，不碰真实数据目录。
 */

let sandbox: Sandbox;
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

function layoutAt(dataDir: string, port: number): DataLayout {
  const layout = resolveDataLayout({ TB_DATA_DIR: dataDir });
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return layout;
}

let base = "";

beforeEach(async () => {
  sandbox = makeSandbox("tb-m1a-api-");
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
    ...(body === undefined
      ? undefined
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}

describe("记录 API 闭环（创建/编辑/删除/列表/详情/搜索）", () => {
  it("POST→GET 列表→GET 详情→PUT 编辑→DELETE→搜索清理，全链路走 HTTP", async () => {
    const created = await api("POST", "/api/records", { text: "今天下午要开会，很尴尬" });
    expect(created.status).toBe(201);
    const recordId = created.json.record.id as string;
    expect(recordId).toMatch(/^rec_/);

    const list = await api("GET", "/api/records?limit=10&offset=0");
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.records[0].id).toBe(recordId);

    const detail = await api("GET", `/api/records/${recordId}`);
    expect(detail.json.current.raw_text).toBe("今天下午要开会，很尴尬");
    expect(detail.json.revisions).toHaveLength(1);

    const emptyDiff = await api("PUT", `/api/records/${recordId}`, { text: "今天下午要开会，很尴尬" });
    expect(emptyDiff.status).toBe(200);
    expect(emptyDiff.json.changed).toBe(false);
    expect(emptyDiff.json.revision.revision_number).toBe(1);

    const edited = await api("PUT", `/api/records/${recordId}`, { text: "今天下午要团建，很愉快" });
    expect(edited.json.changed).toBe(true);
    expect(edited.json.revision.revision_number).toBe(2);

    const search = await api("GET", "/api/search?q=尴尬");
    expect(search.status).toBe(200);
    expect(search.json.hits).toHaveLength(0);
    const search2 = await api("GET", "/api/search?q=团建");
    expect(search2.json.hits[0].record_id).toBe(recordId);

    const removed = await api("DELETE", `/api/records/${recordId}`);
    expect(removed.status).toBe(200);
    expect(removed.json.phaseA).toMatchObject({ committed: true, revisionsRemoved: 2 });
    // 默认 Phase B（checkpoint TRUNCATE）在本机应成功；断言结构而不是只看 DELETE 成功。
    expect(removed.json.phaseB.status).toBe("ok");

    expect((await api("GET", `/api/records/${recordId}`)).status).toBe(404);
    expect((await api("GET", "/api/search?q=团建")).json.hits).toHaveLength(0);
  });

  it("重建端点：rebuilt + 前后脱锚计数", async () => {
    await api("POST", "/api/records", { text: "重建前的记录" });
    const rebuilt = await api("POST", "/api/search/rebuild");
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.json).toMatchObject({ rebuilt: true, desyncAfter: { phantom: 0, missing: 0 } });
    expect((await api("GET", "/api/search?q=重建")).json.hits).toHaveLength(1);
  });

  it("存储维护状态端点初始为空", async () => {
    const status = await api("GET", "/api/storage-maintenance");
    expect(status.json).toEqual({ pending: [] });
  });

  it("输入校验与错误面：空文本 400、未知记录 404、坏 JSON 400、错误不回显原文", async () => {
    const bad = await api("POST", "/api/records", { text: "   " });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_request");

    expect((await api("GET", "/api/records/rec_不存在")).status).toBe(404);

    const raw = await fetch(`${base}/api/records`, { method: "POST", body: "{不是json" });
    expect(raw.status).toBe(400);

    const wrongType = await api("POST", "/api/records", { text: 123 });
    expect(wrongType.status).toBe(400);

    // 超过 1 MiB 上限的请求体：必须走到 BodyTooLarge → 413，而不是被 JSON 解析撑住。
    const huge = await fetch(`${base}/api/records`, {
      method: "POST",
      body: JSON.stringify({ text: "H".repeat(1024 * 1024 + 16) }),
    });
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: string }).error).toBe("body_too_large");

    const notFound = await fetch(`${base}/api/unknown`);
    expect(notFound.status).toBe(404);

    const wrongMethod = await fetch(`${base}/api/search/rebuild`);
    expect(wrongMethod.status).toBe(405);
  });
});
