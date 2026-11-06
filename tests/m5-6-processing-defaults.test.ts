import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { boot, shutdown, type BootResult } from "../src/server/runtime/bootstrap.ts";
import {
  effectiveProcessingDefaults,
  ensureConfigFile,
  loadConfigFromPath,
  parseAppConfig,
  TEMPLATE_CONFIG_PATH,
  writeConfigFile,
  type AppConfig,
} from "../src/server/config/config.ts";
import { resolveDataLayout } from "../src/server/config/paths.ts";
import type { DataLayout } from "../src/server/config/paths.ts";
import {
  crossesIntoCloud,
  isModeAvailable,
  processingPatchForScope,
  resolveEntryMode,
} from "../src/web/modeDefaults.ts";
import { makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

/**
 * M5-6 任务 1「处理默认方式」专项验收（规划 §七「整理方式」断言逐条对应）。
 *
 * 三层各钉各的：
 * - 配置层：旧配置读取期归一化（不升 schema_version）、兼容镜像写盘、strict 拒外来字段。
 * - HTTP 层：GET 新 DTO；PATCH 部分更新、全空体 400、写盘后内存视图同步、不标重启。
 * - 入口层：`modeDefaults.ts` 纯函数（回退 manual_only、作用域隔离）+ fakeApi 同契约。
 */

function minimalAppConfig(processing: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    server: { host: "127.0.0.1", port: 8737 },
    processing,
    model: {
      enabled: false,
      provider: "openai_compatible",
      base_url: "https://example.invalid/v1",
      api_key_env: "TB_MODEL_API_KEY",
      cloud_redacted_enabled: false,
      request_timeout_ms: 30000,
    },
  };
}

/* ── A. 配置兼容与归一化 ─────────────────────────────────────────── */

describe("M5-6 · processing 配置兼容", () => {
  it("旧配置只有 default_mode：两个默认回退旧值，记忆关闭，镜像同值", () => {
    const parsed = parseAppConfig(
      minimalAppConfig({ default_mode: "local_model" }),
      "test://legacy",
    ) as AppConfig;
    expect(parsed.processing).toEqual({
      default_mode: "local_model",
      record_default_mode: "local_model",
      sleep_default_mode: "local_model",
      remember_last_mode: false,
    });
  });

  it("新字段齐时各取各值；default_mode 只是镜像，读取期以 record 为准", () => {
    const parsed = parseAppConfig(
      minimalAppConfig({
        default_mode: "manual_only",
        record_default_mode: "cloud_redacted",
        sleep_default_mode: "manual_only",
        remember_last_mode: true,
      }),
      "test://full",
    ) as AppConfig;
    const defaults = effectiveProcessingDefaults(parsed.processing);
    expect(defaults.default_mode).toBe("cloud_redacted");
    expect(defaults.record_default_mode).toBe("cloud_redacted");
    expect(defaults.sleep_default_mode).toBe("manual_only");
    expect(defaults.remember_last_mode).toBe(true);
  });

  it("取值仍受封闭三档约束，外来字段被 strict 拒绝", () => {
    expect(() =>
      parseAppConfig(minimalAppConfig({ default_mode: "manual_only", record_default_mode: "cloud_always" }), "test://bad-mode"),
    ).toThrow();
    expect(() =>
      parseAppConfig(
        minimalAppConfig({ default_mode: "manual_only", extra_mode: "manual_only" }),
        "test://extra",
      ),
    ).toThrow();
  });

  it("写盘保留全部四字段且镜像恒等于 record（旧文件升级不落第二份真相）", () => {
    const sandbox = makeSandbox("tb-m56-cfg-");
    try {
      const file = ensureConfigFile(sandbox.layout);
      const loaded = loadConfigFromPath(file, {});
      const next: AppConfig = {
        ...loaded.config,
        processing: effectiveProcessingDefaults({
          ...loaded.config.processing,
          record_default_mode: "local_model",
          sleep_default_mode: "manual_only",
          remember_last_mode: true,
        }) as AppConfig["processing"],
      };
      writeConfigFile(file, next);
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(onDisk.processing).toEqual({
        default_mode: "local_model",
        record_default_mode: "local_model",
        sleep_default_mode: "manual_only",
        remember_last_mode: true,
      });
      expect((onDisk as { schema_version: number }).schema_version).toBe(1);
    } finally {
      sandbox.cleanup();
    }
  });
});

/* ── B. HTTP 契约（真实 boot + 真实 fetch） ──────────────────────── */

let sandbox: Sandbox | undefined;
let booted: BootResult | undefined;
let base = "";

async function testPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new Error("无法取得空闲端口"));
        return;
      }
      const port = address.port;
      probe.close(() => resolvePromise(port));
    });
  });
}

function writePort(layout: DataLayout, port: number): void {
  mkdirSync(layout.dataDir, { recursive: true });
  const file = ensureConfigFile(layout);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  (raw.server as Record<string, unknown>).port = port;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
}

async function ensureBooted(): Promise<void> {
  if (booted !== undefined) return;
  const port = await testPort();
  sandbox = makeSandbox("tb-m56-api-");
  writePort(sandbox.layout, port);
  booted = await boot({ env: { TB_DATA_DIR: sandbox.root }, log: () => {} });
  base = `http://127.0.0.1:${port}`;
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

describe("M5-6 · GET/PATCH /api/ingest/config", () => {
  it("GET 带 processingDefaults 与 processingAvailability；模型未装配时只有 manual_only 可用", async () => {
    await ensureBooted();
    const r = await call("GET", "/api/ingest/config");
    expect(r.status).toBe(200);
    expect(r.json.processingDefaults).toEqual({
      recordDefaultMode: "manual_only",
      sleepDefaultMode: "manual_only",
      rememberLastMode: false,
    });
    expect(r.json.processingAvailability).toEqual({
      manual_only: true,
      local_model: false,
      cloud_redacted: false,
      // M6-0C 第 4 档：未装配可用端点，所以和另两档云端一样是 false——少这一个键就是可用性表漏档。
      cloud_raw: false,
    });
    // 旧消费方兼容面原样保留。
    expect(r.json.defaultMode).toBe("manual_only");
  });

  it("PATCH 部分更新只动给出的字段；返回完整 DTO；写盘含镜像且不需要重启", async () => {
    await ensureBooted();
    const r = await call("PATCH", "/api/ingest/config/processing", {
      recordDefaultMode: "local_model",
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      recordDefaultMode: "local_model",
      sleepDefaultMode: "manual_only",
      rememberLastMode: false,
    });
    const onDisk = JSON.parse(readFileSync(sandbox!.layout.configFile, "utf8")) as Record<string, unknown>;
    expect(onDisk.processing).toEqual({
      default_mode: "local_model",
      record_default_mode: "local_model",
      sleep_default_mode: "manual_only",
      remember_last_mode: false,
    });
    const after = await call("GET", "/api/ingest/config");
    expect(after.json.defaultMode).toBe("local_model");
    expect(after.json.restartRequired).toBe(false);
  });

  it("PATCH 睡前作用域不碰普通记录；记忆开关单独可改", async () => {
    await ensureBooted();
    await call("PATCH", "/api/ingest/config/processing", { sleepDefaultMode: "local_model" });
    const sleepOnly = await call("GET", "/api/ingest/config");
    expect(sleepOnly.json.processingDefaults).toEqual({
      recordDefaultMode: "manual_only",
      sleepDefaultMode: "local_model",
      rememberLastMode: false,
    });
    await call("PATCH", "/api/ingest/config/processing", { rememberLastMode: true });
    const withMemory = await call("GET", "/api/ingest/config");
    expect(withMemory.json.processingDefaults.rememberLastMode).toBe(true);
    expect(withMemory.json.processingDefaults.sleepDefaultMode).toBe("local_model");
    // 镜像语义：default_mode 只跟 record 走，与睡前无关。
    expect(withMemory.json.defaultMode).toBe("manual_only");
  });

  it("PATCH 全空体与档位外取值都 400，配置不落盘", async () => {
    await ensureBooted();
    const empty = await call("PATCH", "/api/ingest/config/processing", {});
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("invalid_request");
    const bogus = await call("PATCH", "/api/ingest/config/processing", { recordDefaultMode: "cloud_always" });
    expect(bogus.status).toBe(400);
    const onDisk = JSON.parse(readFileSync(sandbox!.layout.configFile, "utf8")) as {
      processing: Record<string, unknown>;
    };
    expect(onDisk.processing).toEqual({
      default_mode: "manual_only",
      record_default_mode: "manual_only",
      sleep_default_mode: "manual_only",
      remember_last_mode: false,
    });
  });

  it("不可用档位的默认可以被保存（配置 ≠ 装配）；可用性如实报 false", async () => {
    await ensureBooted();
    const r = await call("PATCH", "/api/ingest/config/processing", { recordDefaultMode: "cloud_redacted" });
    expect(r.status).toBe(200);
    const after = await call("GET", "/api/ingest/config");
    expect(after.json.processingDefaults.recordDefaultMode).toBe("cloud_redacted");
    expect(after.json.processingAvailability.cloud_redacted).toBe(false);
  });
});

/* ── C. 入口页纯逻辑（modeDefaults） ─────────────────────────────── */

describe("M5-6 · 入口页初始化与回退", () => {
  const unavailable = { manual_only: true as const, local_model: false, cloud_redacted: false, cloud_raw: false };
  const readyLocal = { manual_only: true as const, local_model: true, cloud_redacted: false, cloud_raw: false };

  it("默认不可用时本次回退 manual_only 并点名回退；可用时原样进入", () => {
    expect(resolveEntryMode("local_model", unavailable)).toEqual({ mode: "manual_only", fellBack: true });
    expect(resolveEntryMode("cloud_redacted", unavailable)).toEqual({ mode: "manual_only", fellBack: true });
    expect(resolveEntryMode("local_model", readyLocal)).toEqual({ mode: "local_model", fellBack: false });
  });

  it("manual_only 永远可用；档位外取值视为不可用；不知道可用性时不虚报禁用", () => {
    expect(isModeAvailable("manual_only", unavailable)).toBe(true);
    expect(isModeAvailable("cloud_always", unavailable)).toBe(false);
    expect(isModeAvailable("local_model", null)).toBe(true);
  });

  it("记忆写回按作用域拆分：两页各发各的字段，互不覆盖", () => {
    expect(processingPatchForScope("record", "local_model")).toEqual({ recordDefaultMode: "local_model" });
    expect(processingPatchForScope("sleep", "cloud_redacted")).toEqual({ sleepDefaultMode: "cloud_redacted" });
  });
});

/* ── D. fakeApi 同契约（dev 假数据入口） ─────────────────────────── */

describe("M5-6 · fakeApi 整理方式面", () => {
  // fakeApi 依赖 `window`（只该活在 DOM 侧程序），不能被根 tsconfig 的 node 程序 import——
  // 沿用本仓 UI 测试惯例做源码级断言：路由、DTO 字段与作用域语义都在。
  const fake = readFileSync(join(process.cwd(), "src", "web", "fakeApi.ts"), "utf8");

  it("GET 假 DTO 带默认与可用性；PATCH 路由只动给出字段并镜像 defaultMode", () => {
    expect(fake).toContain("processingDefaults");
    expect(fake).toContain("processingAvailability");
    expect(fake).toContain('path === "/api/ingest/config/processing"');
    expect(fake).toContain("saveProcessingBody");
    expect(fake).toContain("recordDefaultMode: parsed.recordDefaultMode ?? current.recordDefaultMode");
    expect(fake).toContain("sleepDefaultMode: parsed.sleepDefaultMode ?? current.sleepDefaultMode");
    expect(fake).toContain("defaultMode: next.recordDefaultMode");
    expect(fake).toContain('current.apiKeySource === "environment"');
    expect(fake).toContain('cloudModel.enabled && cloudModel.apiKeySource === "none"');
    // 至少一个字段 + 封闭取值的校验语义与真服务端同源。
    expect(fake).toContain("至少提供一个整理方式字段");
    expect(fake).toContain('modes.includes(mode)');
  });
});

/* ── E. 模板与装配说明 ───────────────────────────────────────────── */

describe("M5-6 · 配置模板", () => {
  it("模板逐字给出四字段默认（manual_only × 2 + 记忆关闭），schema_version 不升", () => {
    const raw = JSON.parse(readFileSync(TEMPLATE_CONFIG_PATH, "utf8")) as {
      schema_version: number;
      processing: Record<string, unknown>;
    };
    expect(raw.schema_version).toBe(1);
    expect(raw.processing).toEqual({
      default_mode: "manual_only",
      record_default_mode: "manual_only",
      sleep_default_mode: "manual_only",
      remember_last_mode: false,
    });
    const parsed = parseAppConfig(raw, TEMPLATE_CONFIG_PATH);
    expect(parsed.processing.remember_last_mode).toBe(false);
  });
});

/* ── F. 改档要不要确认（web-redesign 第二步 · 批 9 从详情页搬进这一层的纯判据）─── */

describe("M5-6 · 改档的确认只花在「非云端 → 云端」一个方向", () => {
  const MODES = ["manual_only", "local_model", "cloud_redacted", "cloud_raw"] as const;
  const CLOUD = new Set(["cloud_redacted", "cloud_raw"]);

  it("四档两两逐对：只有「从非云端到云端」为真", () => {
    for (const from of MODES) {
      for (const to of MODES) {
        const expected = CLOUD.has(to) && !CLOUD.has(from);
        expect(crossesIntoCloud(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it("同一档不动、朝反方向（离开云端）都不问", () => {
    for (const mode of MODES) expect(crossesIntoCloud(mode, mode)).toBe(false);
    expect(crossesIntoCloud("cloud_redacted", "manual_only")).toBe(false);
    expect(crossesIntoCloud("cloud_raw", "local_model")).toBe(false);
    // 云端两档之间横跳也不问：隐私边界没变，只是脱不脱敏。
    expect(crossesIntoCloud("cloud_redacted", "cloud_raw")).toBe(false);
  });
});
