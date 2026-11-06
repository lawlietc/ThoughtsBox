import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR, migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { hasPrefix } from "../src/shared/contracts/ids.ts";
import {
  GRANT_SEND_CONTENT_MODES,
  GrantService,
  PolicyVersionError,
  CloudSendAuthorizationRequiredError,
  grantPolicyVersionFor,
  outboundRequestText,
  type CloudSendGrantRow,
  type GrantSendContentMode,
  type SendPreview,
} from "../src/server/privacy/grantService.ts";
import {
  RAW_SEND_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  redact,
  redactedRangeToOriginal,
  sha256OfText,
} from "../src/server/privacy/redaction.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M6-0D 原文发送授权（`cloud_send_grant.send_content_mode` + `raw-v1`）的验收。
 *
 * 契约正文：`docs/dev-specs/2026-10-23-M6-0D-原文发送授权表设计草案.md` §二/§三/§四/§五/§六/§七。
 *
 * 分工边界：
 *  - 授权表在 HEAD 的**静态形状**（列集合、前缀 CHECK、64hex、UNIQUE 报错面）由
 *    `m2-schema-contract` 的 T-23/K-17 钉住；脱敏轨道的**服务面**由 `m2-privacy` 钉住。
 *  - 本文件钉的是 0D 新增的那部分：**0008→0009 的真升级**（存量行回填）、**两条轨道互不命中**、
 *    **复用口径**（无消费状态）、**原文预览不调 redact()**、以及 §三 的「raw-v1 与任何脱敏策略
 *    版本互不命中」。
 *  - 升级一律用真的 migrator（`migrate`），不手搓 SQL 近似——回填 `'redacted'` 是这条迁移对用户的
 *    唯一承诺，只有真跑一遍才算数。
 */

const NOW = "2026-10-25T07:00:00.000Z";
const HEX64 = "0123456789abcdef".repeat(4);
const OTHER64 = "fedcba9876543210".repeat(4);

/** 含脱敏源：证明原文路径真的一个占位符都没产生（§五「不得调用 redact()」的可查对象）。 */
const RAW_PII = "👍张三说打 13800138000 给 laowang@example.com 或老周";
/** 不含任何规则/实体命中面：两轨载荷哈希天然相同，「模式腿是否真的在起作用」只能在这种记录上问。 */
const RAW_CLEAN = "今天天气不错，适合写点东西。";

/** 0008 及更早的迁移清单：停在 0008 的库就是 0D 的升级现场。 */
const PRE_0009 = [
  "0001_bootstrap.sql",
  "0002_records_and_search.sql",
  "0003_derived_layer.sql",
  "0004_correction_layer.sql",
  "0005_override_value_gate.sql",
  "0006_entity_types_v2.sql",
  "0007_schema_backfill_m2_debt.sql",
  "0008_three_axis_contract.sql",
];
const MIG_0009 = "0009_send_content_mode.sql";
/** 0009 正文去掉行注释后的净 SQL：文件头把「不引入 consumed_at_utc」写在散文里，扫全文会误判。 */
const MIGRATION_0009_SQL = readFileSync(join(MIGRATIONS_DIR, MIG_0009), "utf8").replace(/--[^\n]*/g, "");

let sandbox: Sandbox;
let db: Database;
let records: RecordService;
let grants: GrantService;
let recordId: string;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m6-0d-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  grants = new GrantService(db, { now: () => new Date(NOW) });
  const created = records.createRecord(RAW_PII, "cloud_raw");
  recordId = created.record.id;
  revisionId = created.revision.id;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具 ────────────────────────────────────────────────────────────

/** 探完即回滚的拒绝断言：夹具现场不被污染（手法与 m2-privacy / m2-schema-contract 一致）。 */
function expectRejected(statement: () => void, pattern: RegExp): void {
  let thrown: Error | undefined;
  db.exec("begin immediate");
  try {
    statement();
  } catch (cause) {
    thrown = cause as Error;
  } finally {
    db.exec("rollback");
  }
  if (thrown === undefined) throw new Error(`期望被 ${pattern} 拒绝，但写入成功了`);
  expect(thrown.message).toMatch(pattern);
}

function insertGrantRow(
  id: string,
  revision: string,
  mode: GrantSendContentMode,
  redactedSha: string | null,
  payloadSha: string,
  policy: string,
): void {
  db.prepare(
    `insert into cloud_send_grant (id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, revision, mode, redactedSha, payloadSha, policy, NOW);
}

function grantRowOf(id: string): CloudSendGrantRow | undefined {
  return db.prepare("select * from cloud_send_grant where id = ?").get(id) as unknown as CloudSendGrantRow | undefined;
}

// ── A. 0008 → 0009 真升级（§六 断言 1）───────────────────────────────

describe("A. 停在 0008 的库升到 0009：存量授权一律回填 redacted 且仍然可读", () => {
  it("存量两行逐列不变，只多出 send_content_mode='redacted'；服务面照旧命中", () => {
    const staging = makeSandbox("tb-m6-0d-legacy-");
    const dir = mkdtempSync(join(tmpdir(), "tb-m6-0d-mig-"));
    const legacy = openSandboxDb(staging.layout);
    try {
      for (const file of PRE_0009) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
      expect(migrate(legacy, dir).schemaVersion).toBe(8);

      const legacyRecords = new RecordService(legacy, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
      const revA = legacyRecords.createRecord("旧库里的第一条，含 13800138000", "cloud_redacted").revision.id;
      const revB = legacyRecords.createRecord("旧库里的第二条", "cloud_redacted").revision.id;
      // 0008 现场：授权表还是 0003 的六列形状（redacted_sha256 NOT NULL，UNIQUE 三元组）。
      const colsBefore = (legacy.prepare("pragma table_info(cloud_send_grant)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(colsBefore).not.toContain("send_content_mode");
      legacy
        .prepare(
          `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
           values ('csg_legacy_a', ?, ?, ?, ?, ?), ('csg_legacy_b', ?, ?, ?, ?, ?)`,
        )
        .run(revA, HEX64, sha256OfText("载荷 A"), REDACTION_POLICY_VERSION, NOW, revB, OTHER64, sha256OfText("载荷 B"), "rules-v0", NOW);
      const before = legacy
        .prepare("select * from cloud_send_grant order by id")
        .all() as Array<Record<string, unknown>>;
      expect(before).toHaveLength(2);

      copyFileSync(join(MIGRATIONS_DIR, MIG_0009), join(dir, MIG_0009));
      const advanced = migrate(legacy, dir);
      expect(advanced.schemaVersion).toBe(9);
      expect(advanced.applied.map((f) => f.name)).toEqual(["send_content_mode"]);

      const after = legacy
        .prepare("select * from cloud_send_grant order by id")
        .all() as Array<Record<string, unknown>>;
      expect(after.map((r) => r["send_content_mode"])).toEqual(["redacted", "redacted"]);
      // 除新增列外逐列相等：回填不得改写用户已确认过的任何一个字节。
      const strip = (rows: Array<Record<string, unknown>>) =>
        rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "send_content_mode")));
      expect(strip(after)).toEqual(before);

      // 服务面同样可读：旧授权在新键上照常命中，不因为重建而变成「未确认」。
      const legacyGrants = new GrantService(legacy, { now: () => new Date(NOW) });
      const found = legacyGrants.findApplicableGrant(revA, sha256OfText("载荷 A"), REDACTION_POLICY_VERSION, "redacted");
      expect(found?.id).toBe("csg_legacy_a");
      expect(legacyGrants.findApplicableGrant(revA, sha256OfText("载荷 A"), REDACTION_POLICY_VERSION, "raw")).toBeNull();

      // 重建没把外键面弄丢：整库 pragma_foreign_key_check 干净（0009 第 4 步的守门表同款判据）。
      expect(legacy.prepare("select * from pragma_foreign_key_check").all()).toEqual([]);
      expect(countRows(legacy, "cloud_send_grant")).toBe(2);
    } finally {
      legacy.close();
      rmSync(dir, { recursive: true, force: true });
      staging.cleanup();
    }
  });

  it("整表重建逐项恢复了 0003 的约束：前缀、64hex、UTC、STRICT、FK CASCADE 全在", () => {
    const rev = records.createRecord(RAW_CLEAN).revision.id;
    expectRejected(
      () => insertGrantRow("grant_bad_prefix", rev, "redacted", HEX64, sha256OfText("x"), REDACTION_POLICY_VERSION),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertGrantRow("csg_bad_hex", rev, "redacted", "a".repeat(63), sha256OfText("x"), REDACTION_POLICY_VERSION),
      /CHECK constraint failed/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            `insert into cloud_send_grant (id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
             values ('csg_local_time', ?, 'redacted', ?, ?, 'rules-v1', '2026-10-25T15:00:00+08:00')`,
          )
          .run(rev, HEX64, sha256OfText("x")),
      /CHECK constraint failed/,
    );
    // STRICT：BLOB 塞进 TEXT 列被拒——这条报错只有 STRICT 表才会出现，重建后表仍是 STRICT 的证据。
    // （整数进 TEXT 列不算证据：STRICT 允许无损转换，SQLite 照收。）
    expectRejected(
      () =>
        db
          .prepare(
            `insert into cloud_send_grant (id, record_revision_id, send_content_mode, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
             values ('csg_strict', ?, 'redacted', X'0102', ?, 'rules-v1', ?)`,
          )
          .run(rev, sha256OfText("x"), NOW),
      /cannot store BLOB value in TEXT column/,
    );
    // FK CASCADE 仍然生效：删版本行带走授权行，回滚则一行不少。
    insertGrantRow("csg_cascade_0d", rev, "redacted", HEX64, sha256OfText("载荷"), REDACTION_POLICY_VERSION);
    db.exec("begin immediate");
    db.prepare("delete from record_revision where id = ?").run(rev);
    expect(grantRowOf("csg_cascade_0d")).toBeUndefined();
    db.exec("rollback");
    expect(grantRowOf("csg_cascade_0d")).toBeDefined();
  });
});

// ── B. 原文授权行的形状（§六 断言 2）─────────────────────────────────

describe("B. raw 行没有脱敏哈希，组合 CHECK 两个方向都不给缝", () => {
  it("服务签发的原文授权：redacted_sha256 IS NULL，载荷哈希就是 sha256(原文)，策略是 raw-v1", () => {
    const preview = grants.prepareRawPreview(revisionId);
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });

    expect(hasPrefix(grant.id, "cloudSendGrant")).toBe(true);
    expect(grant.send_content_mode).toBe("raw");
    expect(grant.redacted_sha256).toBeNull();
    expect(grant.payload_sha256).toBe(sha256OfText(RAW_PII));
    expect(grant.policy_version).toBe(RAW_SEND_POLICY_VERSION);

    const stored = grantRowOf(grant.id)!;
    expect(stored.redacted_sha256).toBeNull();
    expect(stored.send_content_mode).toBe("raw");
    // 库里那一行存的就是「原文 + raw-v1」，没有第二份内容本体（授权表从不存文本）。
    expect(Object.keys(stored).sort()).toEqual(
      [
        "confirmed_at_utc",
        "id",
        "payload_sha256",
        "policy_version",
        "record_revision_id",
        "redacted_sha256",
        "send_content_mode",
      ].sort(),
    );
  });

  it("raw 带脱敏哈希被拒；redacted 缺脱敏哈希同样被拒；mode 取值越界被拒", () => {
    const rev = records.createRecord(RAW_CLEAN).revision.id;
    expectRejected(
      () => insertGrantRow("csg_raw_with_hash", rev, "raw", HEX64, sha256OfText("x"), RAW_SEND_POLICY_VERSION),
      /CHECK constraint failed/,
    );
    expectRejected(
      () => insertGrantRow("csg_redacted_no_hash", rev, "redacted", null, sha256OfText("x"), REDACTION_POLICY_VERSION),
      /CHECK constraint failed/,
    );
    // 授权表那一域只有两值：记录轴的 'none'（不外发）在这里不是合法取值。
    expectRejected(
      () => insertGrantRow("csg_none_mode", rev, "none" as GrantSendContentMode, null, sha256OfText("x"), RAW_SEND_POLICY_VERSION),
      /CHECK constraint failed/,
    );
    // 缺 send_content_mode 直接失败——本迁移刻意不给 DEFAULT：一行必须自己说清属于哪条轨道。
    expectRejected(
      () =>
        db
          .prepare(
            `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
             values ('csg_no_mode', ?, ?, ?, ?, ?)`,
          )
          .run(rev, HEX64, sha256OfText("x"), REDACTION_POLICY_VERSION, NOW),
      /NOT NULL constraint failed: cloud_send_grant.send_content_mode/,
    );
    expect(countRows(db, "cloud_send_grant")).toBe(0);
  });

  it("同一 (revision, payload, policy) 三元组上只有内容轴能区分两轨：各模式只命中自己那条", () => {
    // 手造两行：三腿全等，只差 send_content_mode 与那列 redacted_sha256（不在 UNIQUE 里）。
    // 这一条钉的是「第四腿真的在起作用」，而不是「两轨恰好哈希不同」。
    const rev = records.createRecord(RAW_CLEAN).revision.id;
    const payload = sha256OfText("两轨共用的同一份载荷");
    const shared = "shared-v1";
    insertGrantRow("csg_mode_raw", rev, "raw", null, payload, shared);
    insertGrantRow("csg_mode_redacted", rev, "redacted", HEX64, payload, shared);

    expect(grants.findApplicableGrant(rev, payload, shared, "raw")?.id).toBe("csg_mode_raw");
    expect(grants.findApplicableGrant(rev, payload, shared, "redacted")?.id).toBe("csg_mode_redacted");
    // 库里四元组允许这两行共存（草案 §二：多出的第四腿让两轨各自成立，互不顶掉）。
    expect(countRows(db, "cloud_send_grant")).toBe(2);
  });
});

// ── C. 两轨互不通用（§六 断言 3，双向）───────────────────────────────

describe("C. 原文授权不能用于脱敏发送，反之亦然", () => {
  it("无脱敏源记录上两轨载荷哈希相同：点头只对本轨有效", () => {
    const clean = records.createRecord(RAW_CLEAN).revision.id;
    const rawPreview = grants.prepareRawPreview(clean);
    const redactedPreview = grants.preparePreview(clean);
    // 前提：这条记录的脱敏文本与原文逐字相同 ⇒ payload_sha256 那一腿分不出两轨。
    expect(redactedPreview.redactedText).toBe(RAW_CLEAN);
    expect(rawPreview.payloadSha256).toBe(redactedPreview.payloadSha256);

    grants.issueGrant(rawPreview, { confirmedAtUtc: NOW });
    // 方向一：为原文的点头，不能被脱敏发送借用。
    expect(grants.grantForPreview(redactedPreview)).toBeNull();
    expect(() =>
      grants.requireApplicableGrant(
        redactedPreview.recordRevisionId,
        redactedPreview.payloadSha256,
        redactedPreview.policyVersion,
        "redacted",
      ),
    ).toThrow(CloudSendAuthorizationRequiredError);
    expect(grants.grantForPreview(rawPreview)?.send_content_mode).toBe("raw");

    grants.issueGrant(redactedPreview, { confirmedAtUtc: NOW });
    // 方向二：为脱敏的点头，同样不能反过来把原文发出去（授权行两轨各一条，互不覆盖）。
    expect(countRows(db, "cloud_send_grant")).toBe(2);
    expect(grants.grantForPreview(rawPreview)?.policy_version).toBe(RAW_SEND_POLICY_VERSION);
    expect(grants.grantForPreview(redactedPreview)?.policy_version).toBe(REDACTION_POLICY_VERSION);

    // 只签过脱敏的那条记录上，原文闸门依旧抛——「已确认过内容」不等于「已确认发原文」。
    const redOnly = records.createRecord(RAW_CLEAN).revision.id;
    const redOnlyPreview = grants.preparePreview(redOnly);
    grants.issueGrant(redOnlyPreview, { confirmedAtUtc: NOW });
    const rawOnlyPreview = grants.prepareRawPreview(redOnly);
    expect(rawOnlyPreview.payloadSha256).toBe(redOnlyPreview.payloadSha256);
    expect(grants.grantForPreview(rawOnlyPreview)).toBeNull();
    expect(() => grants.requireApplicableGrant(redOnly, rawOnlyPreview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw")).toThrow(
      CloudSendAuthorizationRequiredError,
    );
  });

  it("跨轨签发被拒：模式与策略版本不配对时 issueGrant 拿不到落库机会", () => {
    const rawPreview = grants.prepareRawPreview(revisionId);
    const redactedPreview = grants.preparePreview(revisionId);
    expect(() => grants.issueGrant({ ...rawPreview, sendContentMode: "redacted" })).toThrow(PolicyVersionError);
    expect(() => grants.issueGrant({ ...redactedPreview, sendContentMode: "raw" })).toThrow(PolicyVersionError);
    // 两轨各自正常签发才成行；上面两次被拒没有留下任何行。
    expect(countRows(db, "cloud_send_grant")).toBe(0);
    grants.issueGrant(rawPreview);
    grants.issueGrant(redactedPreview);
    expect(countRows(db, "cloud_send_grant")).toBe(2);
  });
});

// ── D. 复用口径（§六 断言 4 + §四/§七 裁决）──────────────────────────

describe("D. 原文授权与脱敏授权同构复用：没有消费状态", () => {
  it("同一 (revision, raw, payload, raw-v1) 重复发送直接放行，不需重新确认", () => {
    const preview = grants.prepareRawPreview(revisionId);
    const first = grants.issueGrant(preview, { confirmedAtUtc: NOW });

    // 三次「发送前闸门」全部放行，且没有任何一步需要用户再点头。
    for (const _attempt of [1, 2, 3]) {
      expect(grants.requireApplicableGrant(preview.recordRevisionId, preview.payloadSha256, preview.policyVersion, "raw").id).toBe(
        first.id,
      );
    }
    // 重复确认命中 K-17 复用：同一行、首次 confirmed_at 保持、库里仍一行。
    const again = grants.issueGrant(preview);
    expect(again.id).toBe(first.id);
    expect(again.confirmed_at_utc).toBe(NOW);
    expect(countRows(db, "cloud_send_grant")).toBe(1);
    expect(grantRowOf(first.id)?.confirmed_at_utc).toBe(NOW);
  });

  it("复用口径的落点：库里没有 consumed_at_utc 列，服务面没有 consumeGrant，闸门不写回授权行", () => {
    const cols = (db.prepare("pragma table_info(cloud_send_grant)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("consumed_at_utc");
    expect(MIGRATION_0009_SQL).not.toMatch(/consumed_at/i);
    const surface = Object.getOwnPropertyNames(GrantService.prototype);
    expect(surface.some((name) => /consume/i.test(name))).toBe(false);
    for (const name of ["findApplicableGrant", "requireApplicableGrant", "grantForPreview"]) {
      expect(surface).toContain(name);
    }

    // 行为面才是这条裁决的正文：连过三次闸门之后，授权行逐字还是那一行——没有「已消费」状态可言。
    const preview = grants.prepareRawPreview(revisionId);
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });
    const before = grantRowOf(grant.id)!;
    grants.requireApplicableGrant(revisionId, preview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw");
    grants.requireApplicableGrant(revisionId, preview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw");
    expect(grantRowOf(grant.id)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(cols.sort());
  });
});

// ── E. 失效面（§六 断言 5/6/7）───────────────────────────────────────

describe("E. 原文授权的失效条件：改原文即失效，规则升版不失效", () => {
  it("改一个字 ⇒ 新 revision + 新载荷哈希 ⇒ 旧原文授权对新版本不适用", () => {
    const preview = grants.prepareRawPreview(revisionId);
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });

    const edited = records.editRecord(recordId, `${RAW_PII}（又改了一个字）`);
    expect(edited.revision.id).not.toBe(revisionId);
    const nextPreview = grants.prepareRawPreview(edited.revision.id);
    expect(nextPreview.payloadSha256).not.toBe(preview.payloadSha256);

    // 旧行仍在库里可追溯，但它绑的是旧 revision，不构成对新版本的许可。
    expect(grants.findApplicableGrant(edited.revision.id, nextPreview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw")).toBeNull();
    expect(() =>
      grants.requireApplicableGrant(edited.revision.id, nextPreview.payloadSha256, nextPreview.policyVersion, "raw"),
    ).toThrow(CloudSendAuthorizationRequiredError);
    // 同一份原文哈希拿去问新版本：也是 null——载荷那一腿同样咬合（断言 5 与 6 的两个侧面）。
    expect(grants.findApplicableGrant(edited.revision.id, preview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw")).toBeNull();
    // 新版本自己签才有授权，且旧行不被覆盖。
    const fresh = grants.issueGrant(nextPreview, { confirmedAtUtc: NOW });
    expect(fresh.id).not.toBe(grant.id);
    expect(countRows(db, "cloud_send_grant")).toBe(2);
  });

  it("编辑为空 diff（文本未变）不建版：同一次确认仍然命中", () => {
    const preview = grants.prepareRawPreview(revisionId);
    grants.issueGrant(preview, { confirmedAtUtc: NOW });
    const same = records.editRecord(recordId, RAW_PII);
    expect(same.changed).toBe(false);
    expect(same.revision.id).toBe(revisionId);
    expect(grants.grantForPreview(preview)?.confirmed_at_utc).toBe(NOW);
  });

  it("规则集升版 ⇒ 脱敏授权不再适用，原文授权在 raw-v1 上仍然命中", () => {
    const rawPreview = grants.prepareRawPreview(revisionId);
    const redactedPreview = grants.preparePreview(revisionId);
    const rawGrant = grants.issueGrant(rawPreview, { confirmedAtUtc: NOW });
    const redactedGrant = grants.issueGrant(redactedPreview, { confirmedAtUtc: NOW });

    // 脱敏轨道：规则集一升版，同一份载荷就查不到旧授权（K-17「策略变化即旧授权不适用」）。
    expect(grants.findApplicableGrant(revisionId, redactedPreview.payloadSha256, "rules-v3", "redacted")).toBeNull();
    expect(() => grants.requireApplicableGrant(revisionId, redactedPreview.payloadSha256, "rules-v3", "redacted")).toThrow(
      CloudSendAuthorizationRequiredError,
    );
    insertGrantRow("csg_rules_v2", revisionId, "redacted", redactedPreview.redactedSha256, redactedPreview.payloadSha256, "rules-v3");
    expect(grants.findApplicableGrant(revisionId, redactedPreview.payloadSha256, "rules-v3", "redacted")?.id).toBe("csg_rules_v2");

    // 原文轨道：键里没有规则版本号，升版与它无关。
    expect(grants.findApplicableGrant(revisionId, rawPreview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw")?.id).toBe(rawGrant.id);
    expect(grants.grantForPreview(rawPreview)?.id).toBe(rawGrant.id);
    expect(redactedGrant.policy_version).toBe(REDACTION_POLICY_VERSION);
    // 升版后原文授权仍然一次就过闸门——不需要用户重新确认。
    expect(() =>
      grants.requireApplicableGrant(revisionId, rawPreview.payloadSha256, RAW_SEND_POLICY_VERSION, "raw"),
    ).not.toThrow();
  });
});

// ── F. 原文预览（§五 + §六 断言 8）──────────────────────────────────

describe("F. 原文预览不调 redact()：载荷逐字是原文，映射是恒等空映射", () => {
  it("outboundRequestText(preview) === raw_text，逐字含脱敏源，redactedSha256 为 null", () => {
    const preview = grants.prepareRawPreview(revisionId);

    expect(outboundRequestText(preview)).toBe(RAW_PII);
    expect(preview.payloadText).toBe(RAW_PII);
    expect(preview.redactedText).toBe(RAW_PII);
    expect(preview.redactedSha256).toBeNull();
    expect(preview.payloadSha256).toBe(sha256OfText(RAW_PII));
    expect(preview.sendContentMode).toBe("raw");
    expect(preview.policyVersion).toBe(RAW_SEND_POLICY_VERSION);
    expect(preview.recordId).toBe(recordId);
    expect(preview.revisionNumber).toBe(1);

    // 一个占位符都没产生：脱敏源的字面形式仍在其位。
    expect(preview.payloadText).toContain("张三");
    expect(preview.payloadText).toContain("13800138000");
    expect(preview.payloadText).toContain("laowang@example.com");
    expect(preview.map.spans).toEqual([]);
    expect(preview.map.policyVersion).toBe(RAW_SEND_POLICY_VERSION);
  });

  it("恒等映射对既有投影函数返回原偏移；不产生 nonce，也不读写 app_meta 缓存键", () => {
    const preview = grants.prepareRawPreview(revisionId);
    const metaBefore = countRows(db, "app_meta");
    const previewKeys = () =>
      (db.prepare("select key from app_meta where key LIKE 'preview%'").all() as Array<{ key: string }>).map((r) => r.key);

    // 原文预览全程不碰脱敏缓存：草案 §五「不落 nonce」的落点选了「零 app_meta 读写」那一支。
    expect(previewKeys()).toEqual([]);
    expect(countRows(db, "app_meta")).toBe(metaBefore);
    grants.issueGrant(preview, { confirmedAtUtc: NOW });
    expect(previewKeys()).toEqual([]);
    expect(countRows(db, "app_meta")).toBe(metaBefore);

    // 空 spans ⇒ 脱敏坐标就是原文坐标（K-23 的 UTF-16 code unit 偏移不必另走一条分支）。
    const identity = redactedRangeToOriginal(preview.map, 0, preview.payloadText.length);
    expect(identity).toEqual({ start: 0, end: preview.payloadText.length });
    const mid = Math.floor(RAW_PII.length / 2);
    expect(redactedRangeToOriginal(preview.map, mid, RAW_PII.length)).toEqual({ start: mid, end: RAW_PII.length });
    // nonce 只活在内存里这份 map 上：既不落盘，也不进库里任何一列。
    expect(preview.map.nonce).toBe("");
  });

  it("原文预览不产生脱敏文本：与 redact() 的输出在两轨上互不冒充", () => {
    const preview = grants.prepareRawPreview(revisionId);
    const redacted = redact(RAW_PII);
    expect(redacted.redactedText).not.toBe(preview.payloadText);
    expect(redacted.map.policyVersion).not.toBe(RAW_SEND_POLICY_VERSION);
    expect(redacted.map.spans.length).toBeGreaterThan(0);
    // 恒等映射与真映射的哈希面：raw 侧压根没有脱敏哈希。
    expect(preview.redactedSha256).toBeNull();
  });
});

// ── G. 契约对账（§三 + 0009 与 TS 的同源）────────────────────────────

describe("G. 常量与迁移字面量同源，raw-v1 与脱敏策略版本互不命中", () => {
  it("raw-v1 不等于任何脱敏策略版本，也不出现在 redact() 的产出里", () => {
    expect(RAW_SEND_POLICY_VERSION).toBe("raw-v1");
    expect(RAW_SEND_POLICY_VERSION).not.toBe(REDACTION_POLICY_VERSION);
    expect(RAW_SEND_POLICY_VERSION).not.toMatch(/^rules-/);
    // 与「任何」脱敏策略版本互不命中：现有实现只有一支，但判据写成了规则清单的形状。
    const ruleVersions = [REDACTION_POLICY_VERSION, "rules-v3", "rules-v99"];
    for (const version of ruleVersions) expect(version).not.toBe(RAW_SEND_POLICY_VERSION);
    expect(grantPolicyVersionFor("raw")).toBe(RAW_SEND_POLICY_VERSION);
    expect(grantPolicyVersionFor("redacted")).toBe(REDACTION_POLICY_VERSION);
  });

  it("0009 的 send_content_mode CHECK 清单 = GRANT_SEND_CONTENT_MODES，且不掺记录轴的 'none'", () => {
    const declared = /send_content_mode TEXT NOT NULL CHECK \(send_content_mode IN \(([^)]*)\)\)/.exec(MIGRATION_0009_SQL);
    expect(declared, "0009 里的 mode CHECK 字面量清单必须能被这条对账抓到").not.toBeNull();
    const fromSql = declared![1]!
      .split(",")
      .map((token) => token.trim().replace(/^'|'$/g, ""))
      .filter((token) => token !== "");
    expect(fromSql).toEqual([...GRANT_SEND_CONTENT_MODES]);
    // 两个定义域不得混用（0C 草案 §八之二-1）：记录轴有 'none'，授权表没有。
    const recordAxis = JSON.parse(readFileSync("src/shared/constants/enums.json", "utf8")) as {
      send_content_modes: string[];
    };
    expect(recordAxis.send_content_modes).toContain("none");
    const grantModes: readonly string[] = GRANT_SEND_CONTENT_MODES;
    expect(recordAxis.send_content_modes).toContain("none");
    expect(grantModes).not.toContain("none");
    expect([...grantModes].sort()).toEqual(recordAxis.send_content_modes.filter((m) => m !== "none").sort());
    // UNIQUE 四元组在迁移里就那一处，顺序与 findApplicableGrant 的四腿一致。
    expect(MIGRATION_0009_SQL).toMatch(
      /UNIQUE \(record_revision_id, send_content_mode, payload_sha256, policy_version\)/,
    );
    const previewShape: SendPreview = grants.prepareRawPreview(revisionId);
    expect(grantModes).toContain(previewShape.sendContentMode);
  });
});
