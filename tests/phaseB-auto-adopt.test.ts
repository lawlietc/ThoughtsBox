import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { seedVocabulary } from "../src/server/db/seed.ts";
import { IngestService } from "../src/server/ingest/ingestService.ts";
import { ApiError } from "../src/web/apiClient.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import { INGEST_STAGE_ACTION } from "../src/web/ingestStage.ts";
import { runQuickSave } from "../src/web/quickSave.ts";
import type { Database } from "../src/server/db/adapter.ts";
import {
  FIXTURE_NOW,
  LOCAL_RAW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
  validOutput,
} from "./helpers/ingestFixtures.ts";

let sandbox: Sandbox;
let db: Database;
let recordId: string;
let revisionId: string;
let service: IngestService;

beforeEach(() => {
  sandbox = makeSandbox("tb-phaseb-adopt-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  seedVocabulary(db);
  const created = createRecord(db, LOCAL_RAW, "local_model");
  recordId = created.recordId;
  revisionId = created.revisionId;
  service = new IngestService({
    db,
    adapter: makeAdapter(),
    transport: stubTransport(OK_ENVELOPE(validOutput())).transport,
    systemPrompt: SYSTEM_PROMPT,
    now: () => new Date(FIXTURE_NOW),
  });
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

function resultStateOf(runId: string): string {
  return (db.prepare("select result_state as s from parse_run where id = ?").get(runId) as { s: string }).s;
}

describe("Phase B · 首次整理自动生效（PD-1）", () => {
  it("该 revision 没有 current ⇒ 首次成功后直接 current，且 autoAdopted=true", async () => {
    const result = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    expect(result.succeeded).toBe(true);
    expect(result.autoAdopted).toBe(true);
    expect(resultStateOf(result.runId)).toBe("current");
    expect(service.currentView(revisionId).currentRunId).toBe(result.runId);
    expect(service.currentView(revisionId).episodes.length).toBeGreaterThan(0);
  });

  it("已有 current ⇒ 重新分析落 candidate，autoAdopted=false，旧 current 不动", async () => {
    const first = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    const second = await service.ingest({ recordRevisionId: revisionId, reanalysis: true, autoAdoptFirstResult: true });

    expect(second.succeeded).toBe(true);
    expect(second.autoAdopted).toBe(false);
    expect(resultStateOf(first.runId)).toBe("current");
    expect(resultStateOf(second.runId)).toBe("candidate");
    expect(service.currentView(revisionId).currentRunId).toBe(first.runId);
    expect(service.currentView(revisionId).candidates.map((c) => c.runId)).toContain(second.runId);
  });

  it("未撤销时再点整理 ⇒ 仍命中幂等重放，不重复开单", async () => {
    const first = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    const replay = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });

    expect(replay.replayed).toBe(true);
    expect(replay.runId).toBe(first.runId);
    expect(replay.autoAdopted).toBe(true);
    expect(countRows(db, "parse_run")).toBe(1);
  });

  it("撤销后重新整理 ⇒ 不复用 superseded 行，新一单再次自动生效", async () => {
    const first = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    service.undoCurrent(first.runId);

    const again = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });

    expect(again.succeeded).toBe(true);
    expect(again.replayed).toBe(false);
    expect(again.runId).not.toBe(first.runId);
    expect(again.autoAdopted).toBe(true);
    expect(resultStateOf(first.runId)).toBe("superseded");
    expect(resultStateOf(again.runId)).toBe("current");
    expect(service.currentView(revisionId).currentRunId).toBe(again.runId);
    expect(service.currentView(revisionId).episodes.length).toBeGreaterThan(0);
  });

  it("撤销当前生效结果 ⇒ current→superseded，派生行一起被取代，currentView 回到空", async () => {
    const first = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    expect(service.currentView(revisionId).episodes.length).toBeGreaterThan(0);

    service.undoCurrent(first.runId);

    expect(resultStateOf(first.runId)).toBe("superseded");
    expect(service.currentView(revisionId).currentRunId).toBeNull();
    expect(service.currentView(revisionId).episodes).toEqual([]);
    // 历史行仍在库里，只是不再参与当前视图。
    expect(countRows(db, "episode")).toBeGreaterThan(0);
  });

  it("撤销只接受 current：candidate 与已 superseded 都拒", async () => {
    const first = await service.ingest({ recordRevisionId: revisionId, autoAdoptFirstResult: true });
    const second = await service.ingest({
      recordRevisionId: revisionId,
      reanalysis: true,
      autoAdoptFirstResult: true,
    });

    expect(() => service.undoCurrent(second.runId)).toThrow(/只有 current 结果可以撤销/);
    service.undoCurrent(first.runId);
    expect(() => service.undoCurrent(first.runId)).toThrow(/只有 current 结果可以撤销/);
  });
});

describe("Phase B · 确认与整理合并（S4）", () => {
  it("needs-grant 的主按键动词改成「确认并整理」", () => {
    expect(INGEST_STAGE_ACTION["needs-grant"]).toBe("确认并整理");
  });

  it("确认发送之后立即走 ingestParse：不再让用户多点一次「发起整理」", () => {
    const source = readFileSync(join(process.cwd(), "src", "web", "IngestPanel.tsx"), "utf8");
    // 〔M11-B D-6〕签发 + 整理抽成唯一一个 `confirmAndOrganize(recordId)`：框外确认框与脱敏核对
    // 弹窗共用同一份实现，所以这一对调用现在写在该函数体内（参数名换成 `recordId`）。
    // 判据没有变宽：仍是「签完授权紧接着一次 ingestParse，中间不再插入别的动作」，
    // 而且现在只允许存在这一处——第二份写法会红。
    expect(source).toMatch(/confirmSendGrant\(recordId\)[\s\S]*?api\.ingestParse\(\{ recordId \}\)/);
    expect([...source.matchAll(/confirmSendGrant\(/g)].length).toBe(3);
    // raw 轨有专用确认文案（PD-3）；脱敏轨仍是通用文案。
    expect(source).toContain('track === "raw" ? "确认发送原文" : "确认本次发送内容"');
    expect(source).toContain('track === "raw" ? "确认原文并整理" : "确认并整理"');
  });

  it("「保存并整理」不再在本页报告整理结果：时序终于入队，回执由 QuickPanel 在全局提示位发", async () => {
    const sent: string[] = [];
    const outcome = await runQuickSave(
      {
        createRecord: async () => ({ record: { id: "rec_phase_b" } }),
        enqueueJob: async (recordId) => {
          sent.push(`enqueued:${recordId}`);
          return { id: "job_phase_b" };
        },
        onCreated: (recordId) => sent.push(`created:${recordId}`),
        onSaved: () => sent.push("saved"),
        onQueued: (recordId) => sent.push(`queued:${recordId}`),
      },
      "写一条",
      "local_model",
      true,
    );
    // 「结果已生效」这句话从前挂在这里（同步 ingestParse 的回执）。现在这一页只把活排进队列：
    // 整理在哪一拍真的生效，由「全部记录 / 待整理」那两页按真实状态说，写记录页不替队列抢先表态。
    expect(sent).toEqual([
      "created:rec_phase_b",
      "saved",
      "enqueued:rec_phase_b",
      "queued:rec_phase_b",
    ]);
    expect(outcome.kind).toBe("saved-queued");
  });

  it("入队没成功时不离开本页：`onQueued` 不被调用（那句「已生效」式的抢先回执同样不许出现）", async () => {
    const sent: string[] = [];
    const outcome = await runQuickSave(
      {
        createRecord: async () => ({ record: { id: "rec_phase_b" } }),
        enqueueJob: async () => {
          throw new ApiError(503, "ingest_unavailable", "解析能力未就绪：Provider 面未装配。", []);
        },
        onCreated: (recordId) => sent.push(`created:${recordId}`),
        onSaved: () => sent.push("saved"),
        onQueued: (recordId) => sent.push(`queued:${recordId}`),
      },
      "写一条",
      "local_model",
      true,
    );
    expect(sent).toEqual(["created:rec_phase_b", "saved"]);
    expect(outcome.kind).toBe("saved-organize-failed");
  });
});
