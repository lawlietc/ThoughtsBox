import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { serializeTokens, tokenize } from "../src/shared/search/tokenizer.ts";
import {
  RecordNotFoundError,
  RecordService,
  RecordValidationError,
} from "../src/server/records/service.ts";
import { makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";

let sandbox: Sandbox;
let db: ReturnType<typeof openSandboxDb>;
let service: RecordService;

beforeEach(() => {
  sandbox = makeSandbox("tb-m1a-service-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  service = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date("2026-10-12T06:30:00Z") });
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

describe("记录与版本闭环（Spec §3.1、M1 验收断言）", () => {
  it("创建：记录+首版+索引同事务成立，时间四件套合法", () => {
    const { record, revision } = service.createRecord("今天下午要开会，很尴尬");
    expect(record.id).toMatch(/^rec_/);
    expect(revision.revision_number).toBe(1);
    expect(record.current_revision_id).toBe(revision.id);
    expect(record.created_at_utc).toBe("2026-10-12T06:30:00.000Z");
    expect(record.created_at_local).toBe("2026-10-12T14:30:00.000+08:00");
    expect(record.timezone_id).toBe("Asia/Shanghai");
    expect(record.created_local_date).toBe("2026-10-12");
    expect(record.processing_status).toBe("captured");
    expect(record.processing_mode).toBe("manual_only");
    expect(record.privacy_level).toBe("normal");
    expect(service.searchRecords("开会").hits.map((h) => h.id)).toContain(revision.id);
  });

  it("空 diff 编辑不建版（B13），文本变化才建版且历史原文不改写（K-01）", () => {
    const { revision: rev1 } = service.createRecord("第一段原文");
    const noChange = service.editRecord(rev1.record_id, "第一段原文");
    expect(noChange.changed).toBe(false);
    expect(noChange.revision.id).toBe(rev1.id);

    const changed = service.editRecord(rev1.record_id, "第一段原文（改过）");
    expect(changed.changed).toBe(true);
    expect(changed.revision.revision_number).toBe(2);

    const detail = service.getRecord(rev1.record_id);
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions[0]!.raw_text).toBe("第一段原文");
    expect(detail.current.id).toBe(changed.revision.id);
  });

  it("非法输入被应用层拒绝：空串、纯空白、非字符串（STRICT 不拦绑定 coercion）", () => {
    expect(() => service.createRecord("")).toThrow(RecordValidationError);
    expect(() => service.createRecord("   ")).toThrow(RecordValidationError);
    expect(() => service.createRecord(42 as unknown as string)).toThrow(RecordValidationError);
    expect(() => service.getRecord("rec_不存在")).toThrow(RecordNotFoundError);
  });

  it("列表：按创建时间倒序、分页参数非法被拒", () => {
    service.createRecord("第一条");
    service.createRecord("第二条");
    const page = service.listRecords(1, 0);
    expect(page.total).toBe(2);
    expect(page.records).toHaveLength(1);
    expect(() => service.listRecords(0, 0)).toThrow(RecordValidationError);
    expect(() => service.listRecords(1, -1)).toThrow(RecordValidationError);
  });
});

describe("搜索：external-content FTS5（Spec §7.2、M1a 指令 §5.3）", () => {
  it("双字中文词命中 + 真实中文句子用例（中英混合）", () => {
    const a = service.createRecord("开会讨论季度的预算问题");
    const b = service.createRecord("felt awkward 之后很难堪");
    expect(service.searchRecords("开会").hits.map((h) => h.id)).toEqual([a.revision.id]);
    const mixed = service.searchRecords("awkward 难堪");
    expect(mixed.hits.map((h) => h.id)).toEqual([b.revision.id]);
    const whole = service.searchRecords("很难堪");
    expect(whole.hits.map((h) => h.id)).toContain(b.revision.id);
  });

  it("编辑后检索跟随新内容；历史版本不再出现在搜索结果（经详情可达）", () => {
    const { record } = service.createRecord("初稿：明天开会");
    const edit = service.editRecord(record.id, "定稿：明天团建");
    const hits = service.searchRecords("团建").hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(edit.revision.id);
    expect(hits[0]!.raw_text).toBe("定稿：明天团建");
    // 检索语义=当前版本；旧版本原文不消失（历史可达），但不出现在搜索结果里。
    expect(service.searchRecords("初稿").hits).toHaveLength(0);
    expect(service.getRecord(record.id).revisions[0]!.raw_text).toContain("初稿");
  });

  it("删除后四处一致：主表、历史版本、FTS 索引、审计（M1 验收断言）", () => {
    const { record, revision } = service.createRecord("将被删除的尴尬记录");
    expect(service.searchRecords("尴尬").hits.map((h) => h.id)).toContain(revision.id);
    const result = service.deleteRecord(record.id);
    expect(result.phaseA.committed).toBe(true);
    expect(result.phaseA.revisionsRemoved).toBe(1);
    expect(service.searchRecords("尴尬").hits).toHaveLength(0);
    const ftsCount = db.prepare("select count(*) as n from record_fts").get() as { n: number };
    expect(ftsCount.n).toBe(0);
    const revisionCount = db.prepare("select count(*) as n from record_revision").get() as { n: number };
    expect(revisionCount.n).toBe(0);
    const audit = db
      .prepare("select object_type, object_id, executor, affected from deletion_audit")
      .all() as unknown as { object_type: string; object_id: string; executor: string; affected: string }[];
    expect(audit).toEqual([{ object_type: "capture_record", object_id: record.id, executor: "user", affected: '{"revisions":1}' }]);
  });

  it("全量重建前后搜索结果一致（可全量重建契约）", () => {
    service.createRecord("尴尬的第一条");
    service.createRecord("开会的第二条");
    const before = service.searchRecords("尴尬").hits.map((h) => h.id);
    service.rebuildSearchIndex();
    expect(service.searchRecords("尴尬").hits.map((h) => h.id)).toEqual(before);
    expect(service.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
  });

  it("绕过触发器改主表 ⇒ 脱锚可被检测、检索不泄露幻影、重建恢复一致", () => {
    const a = service.createRecord("幻影词 alpha");
    const b = service.createRecord("留存词 beta");
    // 模拟"绕过触发器直接修改索引源数据"：摘掉删除触发器后走 FK 级联，
    // record_revision 行消失而索引残留幻影条目。
    db.exec("drop trigger record_ad");
    db.prepare("delete from capture_record where id = ?").run(a.record.id);
    expect(service.detectIndexDesync().phantom).toBe(1);
    // 高风险不变量 1：检索读取永远经主表 join，幻影条目不可能作为事实源出现。
    expect(service.searchRecords("alpha").hits).toHaveLength(0);
    service.rebuildSearchIndex();
    expect(service.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
    expect(service.searchRecords("beta").hits.map((h) => h.id)).toEqual([b.revision.id]);
    // 恢复触发器，后续用例不受本模拟影响。
    db.exec(`create trigger record_ad after delete on record_revision begin
      insert into record_fts(record_fts, rowid, tokens) values ('delete', old.rowid, old.tokens);
    end;`);
  });

  it("T-14：绕过触发器直改 tokens ⇒ 索引滞后；实测 integrity-check 检不出（偏差入档），rebuild 恢复一致", () => {
    const { revision } = service.createRecord("原始词元内容测试");
    // 服务层从不 UPDATE 既有版本行（K-01 只增不改写）；摘掉 au 触发器模拟带外改写。
    db.exec("drop trigger record_au");
    db
      .prepare("update record_revision set tokens = ? where id = ?")
      .run(serializeTokens(tokenize("篡改后的词元内容")), revision.id);
    // 症状：新文本查不到——索引仍是旧词元，与内容表脱锚。
    expect(service.searchRecords("篡改").hits).toHaveLength(0);
    // 实测事实（2026-10-12）：external-content 的 integrity-check 对这类改写**不报异常**，
    // docsize 对照同样失明（行还在、只欠内容变化）。§10 T-14 的预期措辞按实测修正。
    expect(() => db.exec("insert into record_fts(record_fts) values('integrity-check')")).not.toThrow();
    // 恢复路径：rebuild 让索引重新跟随内容。
    service.rebuildSearchIndex();
    expect(service.searchRecords("篡改").hits.map((h) => h.id)).toContain(revision.id);
    expect(service.searchRecords("原始").hits).toHaveLength(0);
    expect(service.detectIndexDesync()).toEqual({ phantom: 0, missing: 0 });
    db.exec(`create trigger record_au after update on record_revision begin
      insert into record_fts(record_fts, rowid, tokens) values ('delete', old.rowid, old.tokens);
      insert into record_fts(rowid, tokens) values (new.rowid, new.tokens);
    end;`);
  });

  it("查询与索引共用同一 tokenizer：全角/大小写归一后仍可命中", () => {
    const { revision } = service.createRecord("Used ＡＰＰＬＥ 关键词");
    expect(service.searchRecords("apple").hits.map((h) => h.id)).toEqual([revision.id]);
  });

  it("纯停用词查询返回空结果而不是全表命中", () => {
    service.createRecord("我们的明天");
    expect(service.searchRecords("的")).toEqual({ hits: [] });
  });
});
