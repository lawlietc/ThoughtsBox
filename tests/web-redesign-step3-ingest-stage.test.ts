import { describe, expect, it } from "vitest";

import {
  INGEST_STAGE_ACTION,
  INGEST_STAGE_LABEL,
  ingestStageOf,
  stagePrimaryEnabled,
  stageShowsSendSettings,
  type IngestStageInput,
} from "../src/web/ingestStage.ts";

/**
 * web-redesign 第三步：待整理「操作」框的阶段判据。
 *
 * 这一框以前用四五个布尔在渲染里互相纠缠，「什么状态下显示哪颗键」只能靠读 JSX 推。
 * 收成 `ingestStageOf` 之后，六种阶段在这里逐态钉住 —— 版面怎么画是走查的事，
 * 但「这一刻该是哪一步」不该靠浏览器赌。
 */

const base: IngestStageInput = {
  parseReady: true,
  cloud: true,
  hasPreview: true,
  hasGrant: false,
  jobActive: false,
  lastFailed: false,
};

describe("ingestStageOf：六个阶段的判据", () => {
  it("没有本机解析能力 ⇒ blocked（其余条件一概不问）", () => {
    expect(ingestStageOf({ ...base, parseReady: false })).toBe("blocked");
    expect(ingestStageOf({ ...base, parseReady: false, hasPreview: true, hasGrant: true })).toBe("blocked");
  });

  it("后台在跑 ⇒ queued（不再同时开第二个决定）", () => {
    expect(ingestStageOf({ ...base, jobActive: true })).toBe("queued");
    expect(ingestStageOf({ ...base, jobActive: true, hasGrant: true })).toBe("queued");
  });

  it("云端两关：没预览 ⇒ needs-preview；有预览没授权 ⇒ needs-grant", () => {
    expect(ingestStageOf({ ...base, hasPreview: false, hasGrant: false })).toBe("loading");
    expect(ingestStageOf({ ...base, hasPreview: true, hasGrant: false })).toBe("needs-grant");
    expect(ingestStageOf({ ...base, hasPreview: true, hasGrant: true })).toBe("ready");
  });

  it("本机档永远不进那两个云端阶段", () => {
    expect(ingestStageOf({ ...base, cloud: false, hasPreview: false, hasGrant: false })).toBe("ready");
    expect(ingestStageOf({ ...base, cloud: false, hasPreview: false, lastFailed: true })).toBe("failed");
  });

  it("上次失败只在两关都过之后才说话", () => {
    expect(ingestStageOf({ ...base, lastFailed: true, hasGrant: false })).toBe("needs-grant");
    expect(ingestStageOf({ ...base, lastFailed: true, hasGrant: true })).toBe("failed");
  });

  it("每个阶段都有阶段名与主按键，且没有空串", () => {
    const stages = ["blocked", "queued", "loading", "needs-grant", "failed", "ready"] as const;
    for (const stage of stages) {
      expect(INGEST_STAGE_LABEL[stage].length, stage).toBeGreaterThan(0);
      expect(INGEST_STAGE_ACTION[stage].length, stage).toBeGreaterThan(0);
    }
    // `loading` 是在等本机，不是等用户：那一格按不动，所以它的动词只是占位。
    // 〔web-redesign 第三步 · 用户裁定〕原来那个「先看一眼」阶段已删 ——
    // 它没有信息可判断，唯一的选项就是点一下，等于把一次没有选择的点击伪装成一个阶段。
    expect(stagePrimaryEnabled("loading")).toBe(false);
    expect(stagePrimaryEnabled("queued")).toBe(false);
    expect(stagePrimaryEnabled("needs-grant")).toBe(true);
    expect(stagePrimaryEnabled("ready")).toBe(true);
    expect(INGEST_STAGE_ACTION["needs-grant"]).toBe("确认并整理");
  });

  it("只有过了两关才谈得上「发送方式」这一行", () => {
    expect(stageShowsSendSettings("loading")).toBe(false);
    expect(stageShowsSendSettings("needs-grant")).toBe(true);
    expect(stageShowsSendSettings("ready")).toBe(true);
  });
});
