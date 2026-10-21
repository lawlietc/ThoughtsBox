import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { RecordService } from "../src/server/records/service.ts";
import { exportJsonl } from "../src/server/backup/jsonl.ts";
import { hasPrefix } from "../src/shared/contracts/ids.ts";
import {
  CloudSendAuthorizationRequiredError,
  GrantService,
  outboundRequestText,
  type CloudSendGrantRow,
} from "../src/server/privacy/grantService.ts";
import {
  PIPELINE_FINGERPRINT_FIELDS,
  PIPELINE_MANIFEST_FIELDS,
  buildPipelineManifest,
  canonicalJson,
  manifestWithoutRedactionMap,
  parsePipelineManifest,
  pipelineFingerprint,
  pipelineManifestLocalJson,
  type JsonObject,
  type PipelineManifest,
} from "../src/server/privacy/manifest.ts";
import {
  REDACTION_KINDS,
  REDACTION_POLICY_VERSION,
  collectKnownEntities,
  originalRangeToRedacted,
  projectOriginalSlice,
  redact,
  redactionMapJsonValue,
  redactedRangeToOriginal,
  resolveEvidenceToOriginal,
  sha256OfText,
  type KnownEntity,
  type RedactionMap,
} from "../src/server/privacy/redaction.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * M2-3 隐私面契约测试（D7 + D8）：脱敏、原文↔脱敏区间映射、CloudSendGrant。
 *
 * 契约取值：Spec §5.2/§6.2、指令 §7.2–§7.5/§8.1/§8.4/§11.2、
 * Schema §3.6/§3.7/§7.3〔K-17〕/§7.6〔冻结·B9〕/K-23。
 *
 * 分工边界：数据库自己守不守得住（前缀 CHECK、六列形状、UNIQUE 复用键、FK CASCADE）
 * 已由 `m2-schema-contract` 的 T-23/K-17 钉住；本文件钉的是**服务面**——
 * 偏移算术的逐字正确性、映射不进指纹/不进导出/不进发送文本、授权的适用性判定。
 * 两条禁区（脱敏文本不回写原文、grant 不跨记录）在此显式成测。
 */

const MIGRATION_0003 = "src/server/db/migrations/0003_derived_layer.sql";
const NOW = "2026-10-13T07:00:00.000Z";
const NONCE = "a1b2c3";
const HEX64 = "0123456789abcdef".repeat(4);

/** 夹具文本：代理对 + 中文名 + 手机号 + 邮箱 + 别名，四类偏移源一次凑齐。 */
const RAW = "👍张三说打 13800138000 给 laowang@example.com 或老周";
const ENTITY_ZHANG: KnownEntity = { entityId: "entity_zhang", entityType: "person", terms: ["张三"] };
const ENTITY_LAOZHOU: KnownEntity = {
  entityId: "entity_laozhou",
  entityType: "person",
  terms: ["老周", "周哥"],
};
const ENTITY_STORE: KnownEntity = {
  entityId: "entity_store",
  entityType: "organization",
  terms: ["蓝山咖啡馆"],
};

let sandbox: Sandbox;
let db: Database;
let records: RecordService;
let grants: GrantService;
let recordId: string;
let revisionId: string;

beforeEach(() => {
  sandbox = makeSandbox("tb-m2-privacy-");
  db = openSandboxDb(sandbox.layout);
  migrate(db);
  records = new RecordService(db, { timezoneId: "Asia/Shanghai", now: () => new Date(NOW) });
  grants = new GrantService(db, { now: () => new Date(NOW) });
  const created = records.createRecord(RAW);
  recordId = created.record.id;
  revisionId = created.revision.id;
});

afterEach(() => {
  db.close();
  sandbox.cleanup();
});

// ── 夹具写入器 ───────────────────────────────────────────────────────

function insertEntity(id: string, entityType: string, canonicalName: string, displayName = canonicalName): void {
  db.prepare(
    `insert into entity (id, entity_type, canonical_name, display_name, lifecycle_status, privacy_level, origin_type, created_at_utc)
     values (?, ?, ?, ?, 'active', 'normal', 'user_created', ?)`,
  ).run(id, entityType, canonicalName, displayName, NOW);
}

function insertAlias(entityId: string, alias: string): void {
  db
    .prepare("insert into entity_alias (entity_id, alias, created_at_utc) values (?, ?, ?)")
    .run(entityId, alias, NOW);
}

function run(Statement: string, params: readonly unknown[] = []): void {
  db.prepare(Statement).run(...(params as never[]));
}

function insertGrantRow(
  id: string,
  revision: string,
  payloadSha: string,
  policy: string,
  redactedSha = HEX64,
): void {
  run(
    `insert into cloud_send_grant (id, record_revision_id, redacted_sha256, payload_sha256, policy_version, confirmed_at_utc)
     values (?, ?, ?, ?, ?, ?)`,
    [id, revision, redactedSha, payloadSha, policy, NOW],
  );
}

/** 探完即回滚的拒绝断言：夹具现场不被污染（手法与 m2-schema-contract 一致）。 */
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

function expectAccepted(statement: () => void): void {
  db.exec("begin immediate");
  try {
    statement();
    db.exec("rollback");
  } catch (cause) {
    db.exec("rollback");
    throw cause;
  }
}

function expectThrown(builder: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    builder();
  } catch (cause) {
    thrown = cause;
  }
  if (thrown === undefined) throw new Error(`期望抛出 ${pattern}，但没有抛出`);
  expect((thrown as Error).message).toMatch(pattern);
}

/** 脱敏映射夹具：真实跑一次 redact，映射的形态与被测路径完全同源。 */
function fixtureMap(rawText: string = RAW, entities: readonly KnownEntity[] = []): {
  readonly redactedText: string;
  readonly map: RedactionMap;
} {
  return redact(rawText, entities, { nonce: NONCE });
}

function manifestWith(overrides: Partial<Record<(typeof PIPELINE_MANIFEST_FIELDS)[number], unknown>> = {}): PipelineManifest {
  const base: JsonObject = {
    prompt: "m2-prompt-v1",
    schema: "m2-output-v1",
    model: "qwen2.5:7b",
    provider: "openai_compatible",
    params: { temperature: 0 },
    redaction: REDACTION_POLICY_VERSION,
    redactionMap: redactionMapJsonValue(fixtureMap().map),
    resolver: "resolver-v1",
    validation: "validation-v1",
  };
  return buildPipelineManifest({ ...base, ...overrides });
}

/** 整表逐字段快照：禁区断言用它证明「原文面一个字节都没动」。 */
function snapshot(tables: readonly string[]): string {
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    dump[table] = db.prepare(`select * from ${table} order by rowid`).all() as unknown[];
  }
  return JSON.stringify(dump);
}

const RECORD_TABLES = ["capture_record", "record_revision", "record_fts", "deletion_audit"];

// ── T-33（manifest 侧）：字段集合封闭 ────────────────────────────────

describe("T-33：pipeline_manifest 字段集合封闭（对账 0003 的 CHECK）", () => {
  /** 从迁移 SQL 的 CHECK 体里提出 json_type 路径集合——不硬编码第二份清单（T-16 手法）。 */
  function manifestFieldsFromMigration(): string[] {
    const sql = readFileSync(MIGRATION_0003, "utf8");
    const block = /pipeline_manifest TEXT NOT NULL CHECK \(([\s\S]*?)\n  \),/.exec(sql);
    if (block === null) throw new Error("未能在 0003 里定位 pipeline_manifest 的 CHECK 体");
    return [...block[1]!.matchAll(/json_type\(pipeline_manifest,\s*'\$\.([a-zA-Z_]+)'\)/g)].map((m) => m[1]!);
  }

  it("服务侧字段清单与迁移 CHECK 的路径集合逐项相等且同序", () => {
    expect([...PIPELINE_MANIFEST_FIELDS]).toEqual(manifestFieldsFromMigration());
    expect(PIPELINE_MANIFEST_FIELDS.length).toBe(9);
  });

  it("指纹字段集合 == 九项减 redactionMap（这条差集就是 T-33 要钉的关系）", () => {
    expect([...PIPELINE_FINGERPRINT_FIELDS].sort()).toEqual(
      PIPELINE_MANIFEST_FIELDS.filter((f) => f !== "redactionMap").sort(),
    );
    expect(PIPELINE_FINGERPRINT_FIELDS).not.toContain("redactionMap");
  });

  it("缺任一项被构造门拒；多一项契约外字段也被拒（封闭性的另一半在服务侧）", () => {
    for (const field of PIPELINE_MANIFEST_FIELDS) {
      const base = manifestWith() as unknown as JsonObject;
      delete base[field];
      expectThrown(() => buildPipelineManifest(base), new RegExp(`缺字段：${field}`));
    }
    expectThrown(
      () => buildPipelineManifest({ ...manifestWith(), extraField: "自作主张" }),
      /契约外字段：extraField/,
    );
  });

  it("数据库面：九项缺一即 CHECK 拒（物理地板，redactionMap 缺席同样拒）", () => {
    for (const field of ["redactionMap", "prompt", "validation"] as const) {
      const stripped = { ...manifestWith() } as unknown as JsonObject;
      delete stripped[field];
      const manifest = JSON.stringify(stripped);
      expectRejected(
        () =>
          run(
            `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
             values (?, ?, ?, ?, ?, 'queued', 'candidate', ?)`,
            [`run_no_${field}`, revisionId, manifest, HEX64, `k-no-${field}`, NOW],
          ),
        /CHECK constraint failed/,
      );
    }
  });

  it("九项齐备的映射可落库并解析回同一对象（run 行是映射唯一的存放处）", () => {
    const manifest = manifestWith();
    const localJson = pipelineManifestLocalJson(manifest);
    db.prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
       values ('run_map_home', ?, ?, ?, 'k-map-home', 'queued', 'candidate', ?)`,
    ).run(revisionId, localJson, pipelineFingerprint(manifest), NOW);

    const stored = db
      .prepare("select pipeline_manifest as m from parse_run where id = 'run_map_home'")
      .get() as { m: string };
    const parsed = parsePipelineManifest(stored.m);
    expect((parsed.redactionMap as { nonce?: string }).nonce).toBe(NONCE);
    expect(canonicalJson(parsed as unknown as JsonObject)).toBe(localJson);
    expectThrown(() => parsePipelineManifest(JSON.stringify({ ...manifest, tenth: 1 })), /契约外字段：tenth/);
  });
});

// ── T-33（关系侧）：指纹不含映射 ─────────────────────────────────────

describe("T-33：fingerprint 与 redactionMap 的关系成立", () => {
  it("同一八项 + 不同的脱敏映射 ⇒ 同一指纹（一次性随机量不决定去重键）", () => {
    const first = manifestWith();
    const second = manifestWith({
      redactionMap: redactionMapJsonValue(fixtureMap(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU]).map),
    });
    const third = manifestWith({ redactionMap: redactionMapJsonValue(fixtureMap("完全没有敏感内容的文本", []).map) });
    expect(pipelineFingerprint(second)).toBe(pipelineFingerprint(first));
    expect(pipelineFingerprint(third)).toBe(pipelineFingerprint(first));
    // 映射本身确实不同——否则这条相等是空转
    expect(canonicalJson(second.redactionMap as unknown as JsonObject)).not.toBe(
      canonicalJson(first.redactionMap as unknown as JsonObject),
    );
  });

  it("八项任一变化 ⇒ 指纹变化（改脱敏策略同样算换管线，ADR-011）", () => {
    const base = pipelineFingerprint(manifestWith());
    const probes: Record<string, unknown> = {
      prompt: "m2-prompt-v2",
      schema: "m2-output-v2",
      model: "qwen2.5:14b",
      provider: "manual_only",
      params: { temperature: 1 },
      redaction: "rules-v2",
      resolver: "resolver-v2",
      validation: "validation-v2",
    };
    for (const field of PIPELINE_FINGERPRINT_FIELDS) {
      expect(pipelineFingerprint(manifestWith({ [field]: probes[field] }))).not.toBe(base);
    }
  });

  it("键顺序与序列化空白差异不改变指纹，也不改变本地规范化文本", () => {
    const ordered = buildPipelineManifest({
      validation: "validation-v1",
      resolver: "resolver-v1",
      redactionMap: redactionMapJsonValue(fixtureMap().map),
      redaction: REDACTION_POLICY_VERSION,
      params: { temperature: 0 },
      provider: "openai_compatible",
      model: "qwen2.5:7b",
      schema: "m2-output-v1",
      prompt: "m2-prompt-v1",
    });
    const reference = manifestWith();
    expect(pipelineFingerprint(ordered)).toBe(pipelineFingerprint(reference));
    expect(pipelineManifestLocalJson(ordered)).toBe(pipelineManifestLocalJson(reference));
    // 嵌套对象同样规范化（params 的键序不参与语义）
    expect(
      pipelineFingerprint(manifestWith({ params: { top_p: 1, temperature: 0 } })),
    ).not.toBe(pipelineFingerprint(reference));
    expect(canonicalJson({ b: 1, a: 2 } as unknown as JsonObject)).toBe('{"a":2,"b":1}');
  });

  it("指纹输入面里没有映射的任何痕迹", () => {
    const manifest = manifestWith({ redactionMap: redactionMapJsonValue(fixtureMap(RAW, [ENTITY_ZHANG]).map) });
    const projection = canonicalJson(manifestWithoutRedactionMap(manifest));
    expect(projection).not.toContain("redactionMap");
    expect(projection).not.toContain(NONCE);
    expect(projection).not.toContain("person_1");
    expect(projection).not.toContain("spans");
    expect(Object.keys(manifestWithoutRedactionMap(manifest)).sort()).toEqual(
      [...PIPELINE_FINGERPRINT_FIELDS].sort(),
    );
  });

  it("指纹与持久化 run 行一致：读回后重算等于列值", () => {
    const manifest = manifestWith({ redactionMap: redactionMapJsonValue(fixtureMap(RAW, [ENTITY_ZHANG, ENTITY_STORE]).map) });
    const localJson = pipelineManifestLocalJson(manifest);
    db.prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
       values ('run_fp_persist', ?, ?, ?, 'k-fp-persist', 'succeeded', 'candidate', ?)`,
    ).run(revisionId, localJson, pipelineFingerprint(manifest), NOW);
    const row = db
      .prepare("select pipeline_manifest as m, pipeline_fingerprint as f from parse_run where id = 'run_fp_persist'")
      .get() as { m: string; f: string };
    expect(pipelineFingerprint(parsePipelineManifest(row.m))).toBe(row.f);
    expect(row.f).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── K-23 / B9：区间映射算术 ─────────────────────────────────────────

describe("K-23/B9：偏移锚定 raw_text，单位是 UTF-16 code unit", () => {
  it("代理对计 2：夹具里「张」的 code unit 下标是 2，码点下标是 1", () => {
    expect(RAW.length).toBe(44);
    expect([...RAW].length).toBe(43);
    expect(RAW.indexOf("张")).toBe(2);
    const { map } = fixtureMap(RAW, [ENTITY_ZHANG]);
    expect(map.spans[0]!.originalStart).toBe(2);
    expect(map.spans[0]!.originalEnd).toBe(4);
    expect(RAW.slice(map.spans[0]!.originalStart, map.spans[0]!.originalEnd)).toBe("张三");
  });

  it("替换改变长度：映射两侧坐标各自成立，未替换区段逐字不变", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU]);
    expect(redactedText.length).not.toBe(RAW.length);
    expect(map.spans.length).toBe(4); // 张三 / phone / email / 老周
    const placeholder = map.spans[0]!.placeholder;
    expect(redactedText.slice(map.spans[0]!.redactedStart, map.spans[0]!.redactedEnd)).toBe(placeholder);

    // 每一段未替换的间隙，两侧文本必须逐字相同
    let originalCursor = 0;
    let redactedCursor = 0;
    for (const span of [...map.spans, { originalStart: RAW.length, originalEnd: RAW.length, redactedStart: redactedText.length, redactedEnd: redactedText.length, kind: "x", placeholder: "x" }]) {
      expect(redactedText.slice(redactedCursor, span.redactedStart)).toBe(RAW.slice(originalCursor, span.originalStart));
      originalCursor = span.originalEnd;
      redactedCursor = span.redactedEnd;
    }

    // 反向：每个脱敏区间都能换回原文区间，且切片就是那个真实词面
    for (const span of map.spans) {
      expect(redactedRangeToOriginal(map, span.redactedStart, span.redactedEnd)).toEqual({
        start: span.originalStart,
        end: span.originalEnd,
      });
      expect(RAW.slice(span.originalStart, span.originalEnd)).not.toBe(span.placeholder);
    }
  });

  it("往返恒等（穷举原文全部区间）：不切占位符者正→反回到自身", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU, ENTITY_STORE]);
    let checked = 0;
    let visited = 0;
    for (let start = 0; start <= RAW.length; start += 1) {
      for (let end = start; end <= RAW.length; end += 1) {
        visited += 1;
        const forward = originalRangeToRedacted(map, start, end);
        if (forward === null) {
          // 被拒的必须确实是切坏了某个区间的
          expect(map.spans.some((s) => (start > s.originalStart && start < s.originalEnd) || (end > s.originalStart && end < s.originalEnd))).toBe(true);
          continue;
        }
        checked += 1;
        expect(redactedText.slice(forward.start, forward.end)).toBe(projectOriginalSlice(map, RAW, start, end));
        if (start !== end) expect(redactedRangeToOriginal(map, forward.start, forward.end)).toEqual({ start, end });
      }
    }
    // 循环真的走遍了全部区间，且合法样本足够多——否则这条恒等是空转
    expect(visited).toBe(((RAW.length + 1) * (RAW.length + 2)) / 2);
    expect(checked).toBeGreaterThan(100);
  });

  it("反向核验（穷举脱敏文本全部区间）：合法者逐字闭合，切坏者一律 null", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG, ENTITY_LAOZHOU, ENTITY_STORE]);
    let resolved = 0;
    let rejected = 0;
    let visited = 0;
    for (let start = 0; start <= redactedText.length; start += 1) {
      for (let end = start + 1; end <= redactedText.length; end += 1) {
        visited += 1;
        const mapped = resolveEvidenceToOriginal(map, RAW, redactedText, start, end);
        const slices = map.spans.some((s) => (start > s.redactedStart && start < s.redactedEnd) || (end > s.redactedStart && end < s.redactedEnd));
        if (slices) {
          expect(mapped).toBeNull();
          rejected += 1;
          continue;
        }
        expect(mapped).not.toBeNull();
        resolved += 1;
        expect(RAW.slice(mapped!.originalStart, mapped!.originalEnd)).toBe(mapped!.originalText);
        expect(projectOriginalSlice(map, RAW, mapped!.originalStart, mapped!.originalEnd)).toBe(
          redactedText.slice(start, end),
        );
      }
    }
    expect(visited).toBe(((redactedText.length + 1) * redactedText.length) / 2);
    expect(resolved).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(0);
  });

  it("证据引用整个占位符时反解回真实词面；切进占位符内部则不可映射（宁缺不伪）", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG]);
    const span = map.spans[0]!;
    const cited = resolveEvidenceToOriginal(map, RAW, redactedText, span.redactedStart, span.redactedEnd);
    expect(cited).not.toBeNull();
    expect(cited!.originalText).toBe("张三");
    expect(cited!.redactedSlice).toBe(span.placeholder);
    expect(cited!.originalStart).toBe(span.originalStart);

    const half = span.redactedStart + 2;
    expect(resolveEvidenceToOriginal(map, RAW, redactedText, half, span.redactedEnd)).toBeNull();
    expect(redactedRangeToOriginal(map, span.redactedStart + 1, span.redactedEnd - 1)).toBeNull();
  });

  it("非法偏移（负数、倒置、非整数）一律 null，不接受静默夹取", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG]);
    for (const [start, end] of [
      [-1, 3],
      [3, 2],
      [0.5, 2],
      [1, 2.5],
      [Number.NaN, 3],
      [Number.POSITIVE_INFINITY, 3],
    ] as const) {
      expect(redactedRangeToOriginal(map, start, end)).toBeNull();
      expect(resolveEvidenceToOriginal(map, RAW, redactedText, start, end)).toBeNull();
      expect(originalRangeToRedacted(map, start, end)).toBeNull();
    }
  });

  /**
   * 越界分两层：纯偏移算术（两个 range 函数）手里没有文本，长度不归它判；
   * 持有文本的 resolveEvidenceToOriginal 才是边界闸门。这条分工是显式设计，
   * 不是漏洞——所以这里同时断言「纯算术不夹取」与「核验入口必拒」。
   */
  it("越界：核验入口拒；纯算术函数不夹取（它手里没有文本）", () => {
    const { redactedText, map } = fixtureMap(RAW, [ENTITY_ZHANG]);
    const beyond = redactedText.length + 5;
    expect(resolveEvidenceToOriginal(map, RAW, redactedText, 0, beyond)).toBeNull();
    expect(resolveEvidenceToOriginal(map, RAW, redactedText, beyond - 1, beyond)).toBeNull();
    expect(resolveEvidenceToOriginal(map, RAW, redactedText, redactedText.length, redactedText.length + 1)).toBeNull();
    expect(redactedRangeToOriginal(map, 0, beyond)).not.toBeNull();
    expect(projectOriginalSlice(map, RAW, 0, beyond)).toBeNull();
    expect(originalRangeToRedacted(map, 0, RAW.length + 1)).not.toBeNull();
    expect(resolveEvidenceToOriginal({ ...map, spans: [] }, RAW, redactedText, 0, 1)).not.toBeNull();
  });

  it("单次请求占位符：同一请求内同一实体共用标识，跨请求标识不稳定", () => {
    const text = "张三说张三对，老周也说张三对";
    const once = fixtureMap(text, [ENTITY_ZHANG, ENTITY_LAOZHOU]);
    expect(once.map.spans.length).toBe(4);
    const tokens = new Set(once.map.spans.map((s) => s.placeholder));
    expect(tokens.size).toBe(2);
    expect(once.redactedText.match(/\[person_1_/g)!.length).toBe(3);

    const twice = redact(text, [ENTITY_ZHANG, ENTITY_LAOZHOU]);
    const placeholdersOf = (m: RedactionMap): string[] => m.spans.map((s) => s.placeholder);
    expect(new Set(placeholdersOf(twice.map))).not.toEqual(new Set(placeholdersOf(once.map)));
    expect(placeholdersOf(twice.map)[0]).not.toBe(placeholdersOf(once.map)[0]);
  });

  it("别名一起替换、左起最长优先：张三丰不被张三截断", () => {
    const text = "张三丰和张三以及周哥在同一家蓝山咖啡馆";
    const { redactedText, map } = fixtureMap(text, [
      ENTITY_ZHANG,
      { ...ENTITY_ZHANG, entityId: "entity_zhangsanfeng", terms: ["张三丰"] },
      ENTITY_LAOZHOU,
      ENTITY_STORE,
    ]);
    expect(map.spans.map((s) => text.slice(s.originalStart, s.originalEnd))).toEqual([
      "张三丰",
      "张三",
      "周哥",
      "蓝山咖啡馆",
    ]);
    expect(redactedText).not.toContain("张三");
    expect(redactedText).not.toContain("蓝山咖啡馆");
    // 同一位置上更长的「张三丰」先胜出，「张三」在 [0,2) 的命中被跳过——不会被截成占位符＋残字
    expect(map.spans[0]!.originalEnd).toBe(3);
  });

  it("规则脱敏覆盖手机号与邮箱；未知人名不承诺自动识别（Spec §6.2）", () => {
    const { redactedText, map } = fixtureMap(RAW, []);
    expect(map.spans.map((s) => s.kind)).toEqual(["phone", "email"]);
    expect(redactedText).not.toContain("13800138000");
    expect(redactedText).not.toContain("laowang@example.com");
    // 无已知实体清单时，人名按契约原样保留——不假装「已匿名」
    expect(redactedText).toContain("张三");
    expect(redactedText).toContain("老周");
    // 11 位以外的数字串不误伤
    expect(fixtureMap("2026 年 1380013800 与 138001380001").map.spans).toEqual([]);
    // 改向〔M3-DB-1，用户裁定 Q3〕：实体类 kind 直接取 enums.json 的 `entity_types`，
    // 8 类落地后清单随之换面（game → activity / event）。钉的是「kind == phone/email + 现行 8 值」。
    expect(REDACTION_KINDS).toEqual([
      "phone",
      "email",
      "person",
      "organization",
      "place",
      "work",
      "product",
      "activity",
      "event",
      "other",
    ]);
  });

  it("已知实体清单来自 entity + entity_alias，而不是调用方手抄", () => {
    insertEntity("entity_zhang", "person", "张三", "张三");
    insertAlias("entity_zhang", "张三生");
    insertEntity("entity_store", "organization", "蓝山咖啡馆", "蓝山");
    const entities = collectKnownEntities(db);
    expect(entities).toEqual([
      { entityId: "entity_store", entityType: "organization", terms: ["蓝山咖啡馆", "蓝山"] },
      { entityId: "entity_zhang", entityType: "person", terms: ["张三", "张三生"] },
    ]);
    const { redactedText } = redact(RAW, entities);
    expect(redactedText).not.toContain("张三");
  });
});

// ── K-17：签发 / 复用 / 不适用 ──────────────────────────────────────

describe("CloudSendGrant 签发、复用与不适用（K-17）", () => {
  it("签发：绑定 revision + 两份哈希 + 策略版本 + 确认时刻，且哈希逐字对应待发送内容", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG, ENTITY_LAOZHOU], nonce: NONCE });
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });

    expect(hasPrefix(grant.id, "cloudSendGrant")).toBe(true);
    expect(grant.record_revision_id).toBe(revisionId);
    expect(grant.policy_version).toBe(REDACTION_POLICY_VERSION);
    expect(grant.payload_sha256).toBe(sha256OfText(preview.payloadText));
    expect(grant.redacted_sha256).toBe(sha256OfText(preview.redactedText));
    expect(grant.confirmed_at_utc).toBe(NOW);
    expect(grant.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(countRows(db, "cloud_send_grant")).toBe(1);
  });

  it("预览即待发：未手工替换时 payload 文本与脱敏文本逐字相同（§7.2 第 4–6 步）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    expect(preview.payloadText).toBe(preview.redactedText);
    expect(preview.payloadSha256).toBe(preview.redactedSha256);
    expect(preview.revisionNumber).toBe(1);
    expect(preview.recordId).toBe(recordId);
    // 按记录取当前版本（§7.2 第 1 步）与按版本取预览是同一条路径
    expect(grants.preparePreviewForRecord(recordId, { entities: [ENTITY_ZHANG], nonce: NONCE })).toEqual(preview);
    // 准备预览不产生任何授权：确认之前库里必须干净
    expect(countRows(db, "cloud_send_grant")).toBe(0);
    let gate: unknown;
    try {
      grants.requireApplicableGrant(preview.recordRevisionId, preview.payloadSha256, preview.policyVersion);
    } catch (cause) {
      gate = cause;
    }
    // 闸门抛的是可分型的错误：调用方据此拒绝发出请求，而不是靠读消息文本
    expect(gate).toBeInstanceOf(CloudSendAuthorizationRequiredError);
    expect((gate as CloudSendAuthorizationRequiredError).recordRevisionId).toBe(revisionId);
    expect((gate as Error).message).not.toContain("张三");
    expect((gate as Error).message).not.toContain(RAW);
  });

  it("复用：同 revision + 同载荷 + 同策略再次签发返回原授权，确认时刻不被刷新", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const first = grants.issueGrant(preview, { confirmedAtUtc: "2026-10-13T07:00:00.000Z" });
    grants = new GrantService(db, { now: () => new Date("2026-10-14T09:00:00.000Z") });
    const again = grants.issueGrant(preview);

    expect(again.id).toBe(first.id);
    expect(again.confirmed_at_utc).toBe("2026-10-13T07:00:00.000Z");
    expect(countRows(db, "cloud_send_grant")).toBe(1);
    expect(grants.grantForPreview(preview)?.id).toBe(first.id);
  });

  it("不适用一：原文编辑产生新 revision，旧授权对新内容不适用（Spec §5.2）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });

    const edited = records.editRecord(preview.recordId, "👍张三说打 13900139000 给 laowang@example.com 或老周");
    expect(edited.changed).toBe(true);
    const nextPreview = grants.preparePreview(edited.revision.id, { entities: [ENTITY_ZHANG], nonce: NONCE });
    expect(nextPreview.recordRevisionId).not.toBe(revisionId);

    expectThrown(
      () => grants.requireApplicableGrant(edited.revision.id, nextPreview.payloadSha256, nextPreview.policyVersion),
      /没有适用授权/,
    );
    // 旧行仍在库里可追溯，但它绑的是旧 revision，不构成对新版本的许可
    expect(grants.findApplicableGrant(edited.revision.id, nextPreview.payloadSha256, nextPreview.policyVersion)).toBeNull();
    expect(grants.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion).id).toBe(grant.id);
    // 新版本自己签发才有授权
    const fresh = grants.issueGrant(nextPreview);
    expect(fresh.record_revision_id).toBe(edited.revision.id);
    expect(countRows(db, "cloud_send_grant")).toBe(2);
  });

  it("不适用一之二：同版本内容哈希不同也不适用（载荷变化 ⇒ 换键）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    grants.issueGrant(preview, { confirmedAtUtc: NOW });
    expectThrown(
      () => grants.requireApplicableGrant(revisionId, sha256OfText("换了别的载荷"), preview.policyVersion),
      /没有适用授权/,
    );
  });

  it("不适用二：脱敏策略版本变化 ⇒ 同一载荷也不再适用（K-17）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });
    expectThrown(
      () => grants.requireApplicableGrant(revisionId, preview.payloadSha256, "rules-v2"),
      /没有适用授权/,
    );
    // 策略升版后另建一行是合法的（复用键含 policy_version）
    insertGrantRow("csg_policy_v2", revisionId, preview.payloadSha256, "rules-v2");
    expect(grants.requireApplicableGrant(revisionId, preview.payloadSha256, "rules-v2").policy_version).toBe("rules-v2");
    expect(grants.findApplicableGrant(revisionId, preview.payloadSha256, REDACTION_POLICY_VERSION)?.id).toBe(grant.id);
  });

  it("不适用三：记录硬删除后授权随行消失，闸门依旧抛（FK CASCADE 的服务面）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    grants.issueGrant(preview, { confirmedAtUtc: NOW });
    records.deleteRecord(preview.recordId);
    expect(countRows(db, "cloud_send_grant")).toBe(0);
    expectThrown(
      () => grants.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion),
      /没有适用授权/,
    );
    expectThrown(() => grants.preparePreview(revisionId), /记录版本不存在/);
  });

  it("手工替换的载荷绑定替换后文本，且映射不覆盖替换区段 ⇒ 证据核验失败也不回写伪证据", () => {
    const base = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    // 手工替换改的是「准备发送的那份文本」，动的是占位符本体（原文词面此时已不在载荷里）
    const editedText = base.redactedText.replace(base.map.spans[0]!.placeholder, "某人");
    const preview = grants.preparePreview(revisionId, {
      entities: [ENTITY_ZHANG],
      nonce: NONCE,
      payloadText: editedText,
    });
    expect(preview.payloadText).toBe(editedText);
    expect(preview.payloadSha256).not.toBe(preview.redactedSha256);

    const grant = grants.issueGrant(preview, { confirmedAtUtc: NOW });
    expect(grant.payload_sha256).toBe(sha256OfText(editedText));
    // 未替换的那份载荷没有授权：先签替换版，再拿原版去要
    expectThrown(
      () => grants.requireApplicableGrant(revisionId, base.payloadSha256, base.policyVersion),
      /没有适用授权/,
    );
    // 替换掉的位置仍在映射里，但实际发送文本已与之不符 ⇒ 核验不通过，返回 null
    const span = preview.map.spans[0]!;
    expect(resolveEvidenceToOriginal(preview.map, RAW, preview.payloadText, span.redactedStart, span.redactedEnd)).toBeNull();
    // 未被替换的其它区段仍可正常回锚
    expect(resolveEvidenceToOriginal(preview.map, RAW, preview.payloadText, 0, 2)).not.toBeNull();
  });

  it("签发拒绝策略版本与实现不符的预览（不静默接受旧策略载荷）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    expectThrown(
      () => grants.issueGrant({ ...preview, policyVersion: "rules-v0" }),
      /策略版本与当前实现不一致/,
    );
    expectThrown(() => grants.preparePreview("rev_不存在"), /记录版本不存在/);
  });
});

// ── 禁区一：脱敏文本不回写原始记录 ──────────────────────────────────

describe("禁区：脱敏后的文本不得回写原始记录", () => {
  it("redact / preparePreview / issueGrant 全程之后，M1 记录面逐字段不变", () => {
    insertEntity("entity_zhang", "person", "张三", "张三");
    const before = snapshot(RECORD_TABLES);
    const beforeCount = countRows(db, "record_revision");

    const pure = redact(RAW, collectKnownEntities(db));
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG, ENTITY_LAOZHOU], nonce: NONCE });
    grants.issueGrant(preview);
    grants.requireApplicableGrant(revisionId, preview.payloadSha256, preview.policyVersion);

    expect(snapshot(RECORD_TABLES)).toBe(before);
    expect(countRows(db, "record_revision")).toBe(beforeCount);
    const row = db
      .prepare("select raw_text, content_sha256, tokens from record_revision where id = ?")
      .get(revisionId) as { raw_text: string; content_sha256: string; tokens: string };
    expect(row.raw_text).toBe(RAW);
    expect(row.raw_text).not.toContain("[person_1_");
    expect(row.raw_text).not.toContain(pure.map.spans[0]!.placeholder);
    expect(row.content_sha256).toBe(sha256OfText(RAW.normalize("NFC")));
    expect(row.tokens).not.toContain(pure.map.spans[0]!.placeholder);
    // 记录级处理状态/模式/隐私级也不被授权动作改写（K-17：三者独立，不得互推）
    const record = db.prepare("select processing_status, processing_mode, privacy_level from capture_record").get() as {
      processing_status: string;
      processing_mode: string;
      privacy_level: string;
    };
    expect(record).toEqual({ processing_status: "captured", processing_mode: "manual_only", privacy_level: "normal" });
  });

  it("库里没有任何表存放脱敏文本本体：只有 run 行的 manifest 携带映射", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const grant = grants.issueGrant(preview);
    const manifest = manifestWith({ redactionMap: redactionMapJsonValue(preview.map) });
    db.prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
       values ('run_map_only', ?, ?, ?, 'k-map-only', 'queued', 'candidate', ?)`,
    ).run(revisionId, pipelineManifestLocalJson(manifest), pipelineFingerprint(manifest), NOW);

    const tables = (
      db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    const carriers = tables.filter((table) => {
      try {
        const rows = db.prepare(`select * from ${table}`).all() as Array<Record<string, unknown>>;
        return rows.some((row) => Object.values(row).some((v) => typeof v === "string" && v.includes(preview.redactedText)));
      } catch {
        return false;
      }
    });
    // 授权表只有六列身份/哈希，脱敏文本本体不落任何表
    expect(carriers).toEqual([]);
    const columns = db.prepare("pragma table_info(cloud_send_grant)").all() as Array<{ name: string }>;
    // 六列身份/哈希，顺序按 DDL 读；比对时两边都排序，钉的是集合不是排列
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "record_revision_id",
      "redacted_sha256",
      "payload_sha256",
      "policy_version",
      "confirmed_at_utc",
    ]);
    expect(columns.map((c) => c.name).sort()).toEqual(
      [
        "confirmed_at_utc",
        "id",
        "payload_sha256",
        "policy_version",
        "record_revision_id",
        "redacted_sha256",
      ].sort(),
    );
    const stored: CloudSendGrantRow = db
      .prepare("select * from cloud_send_grant where id = ?")
      .get(grant.id) as unknown as CloudSendGrantRow;
    expect(Object.keys(stored).sort()).toEqual([...columns.map((c) => c.name)].sort());
  });
});

// ── 禁区二：grant 不得跨记录复用 ────────────────────────────────────

describe("禁区：授权不得跨记录、跨版本复用", () => {
  it("两条内容完全相同的记录：A 的授权对 B 不适用，B 必须自己确认", () => {
    const a = records.createRecord(RAW);
    const b = records.createRecord(RAW);
    const previewA = grants.preparePreview(a.revision.id, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const previewB = grants.preparePreview(b.revision.id, { entities: [ENTITY_ZHANG], nonce: NONCE });
    expect(previewA.payloadSha256).toBe(previewB.payloadSha256);
    expect(previewA.map.nonce).toBe(previewB.map.nonce);

    const grantA = grants.issueGrant(previewA, { confirmedAtUtc: NOW });
    expect(grants.findApplicableGrant(b.revision.id, previewB.payloadSha256, previewB.policyVersion)).toBeNull();
    expectThrown(
      () => grants.requireApplicableGrant(b.revision.id, previewB.payloadSha256, previewB.policyVersion),
      /没有适用授权/,
    );
    // 逐记录逐版本：B 自己签发不被唯一键挡住
    const grantB = grants.issueGrant(previewB, { confirmedAtUtc: NOW });
    expect(grantB.id).not.toBe(grantA.id);
    expect(grantB.record_revision_id).toBe(b.revision.id);
    expect(countRows(db, "cloud_send_grant")).toBe(2);
  });

  it("库里同载荷不同 revision 各自成键（服务面不把 B 的查询落到 A 的行上）", () => {
    const a = records.createRecord(RAW).revision.id;
    const b = records.createRecord(RAW).revision.id;
    insertGrantRow("csg_for_a", a, HEX64, REDACTION_POLICY_VERSION);
    expect(grants.findApplicableGrant(b, HEX64, REDACTION_POLICY_VERSION)).toBeNull();
    expect(grants.requireApplicableGrant(a, HEX64, REDACTION_POLICY_VERSION).id).toBe("csg_for_a");
    expectAccepted(() => insertGrantRow("csg_for_b", b, HEX64, REDACTION_POLICY_VERSION));
    expectRejected(
      () => insertGrantRow("csg_for_a2", a, HEX64, REDACTION_POLICY_VERSION),
      /UNIQUE constraint failed/,
    );
  });
});

// ── T-33（隐私面）：映射不出本机 ────────────────────────────────────

describe("T-33：脱敏映射不出本机（仅存本地 manifest）", () => {
  it("离开本机的只有待发送文本：映射与真实词面都不在其内", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG, ENTITY_LAOZHOU], nonce: NONCE });
    const outbound = outboundRequestText(preview);
    expect(outbound).toBe(preview.payloadText);
    expect(outbound).not.toContain("张三");
    expect(outbound).not.toContain("老周");
    expect(outbound).not.toContain("redactionMap");
    expect(outbound).not.toContain("spans");
    expect(outbound).not.toContain("originalStart");
    for (const span of preview.map.spans) expect(outbound).toContain(span.placeholder);
    // 映射本体反过来：真实词面只能靠原文坐标拿到
    const mappingJson = canonicalJson(preview.map as unknown as JsonObject);
    expect(mappingJson).toContain("originalStart");
    expect(mappingJson).not.toContain("张三");
    expect(preview.map.spans.map((s) => RAW.slice(s.originalStart, s.originalEnd))).toEqual([
      "张三",
      "13800138000",
      "laowang@example.com",
      "老周",
    ]);
  });

  it("JSONL 导出面零命中：映射、占位符、授权都不进导出（原文按本地备份语义照旧）", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    grants.issueGrant(preview);
    const manifest = manifestWith({ redactionMap: redactionMapJsonValue(preview.map) });
    db.prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
       values ('run_local_only', ?, ?, ?, 'k-local-only', 'queued', 'candidate', ?)`,
    ).run(revisionId, pipelineManifestLocalJson(manifest), pipelineFingerprint(manifest), NOW);

    const dump = exportJsonl(db, { now: () => new Date(NOW) });
    expect(dump).toContain(RAW);
    for (const needle of ["redactionMap", "pipeline_manifest", "pipeline_fingerprint", "cloud_send_grant", "spans", "nonce", "originalStart", "person_1_"]) {
      expect(dump).not.toContain(needle);
    }
    expect(dump).not.toContain(preview.map.spans[0]!.placeholder);
  });

  it("隐私模块自身不写日志、不发消息：源码里既无 console 也无网络客户端", () => {
    for (const file of [
      "src/server/privacy/redaction.ts",
      "src/server/privacy/grantService.ts",
      "src/server/privacy/manifest.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/console\.|process\.stdout|fetch\(|node:http|node:net|XMLHttpRequest/);
      expect(source).not.toMatch(/update\s+capture_record|update\s+record_revision|insert\s+into\s+record_revision/i);
    }
  });

  it("映射只写一处：parse_run.pipeline_manifest 是它唯一的落库位置", () => {
    const preview = grants.preparePreview(revisionId, { entities: [ENTITY_ZHANG], nonce: NONCE });
    const manifest = manifestWith({ redactionMap: redactionMapJsonValue(preview.map) });
    expectThrown(() => buildPipelineManifest({ ...manifestWithoutRedactionMap(manifest) }), /缺字段：redactionMap/);

    db.prepare(
      `insert into parse_run (id, source_revision_id, pipeline_manifest, pipeline_fingerprint, idempotency_key, execution_status, result_state, started_at_utc)
       values ('run_single_home', ?, ?, ?, 'k-single-home', 'queued', 'candidate', ?)`,
    ).run(revisionId, pipelineManifestLocalJson(manifest), pipelineFingerprint(manifest), NOW);
    const hits = (
      db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as Array<{
        name: string;
      }>
    )
      .filter((row) => row.name !== "record_fts")
      .filter((row) => {
        const rows = db.prepare(`select * from ${row.name}`).all() as Array<Record<string, unknown>>;
        return rows.some((r) => Object.values(r).some((v) => typeof v === "string" && v.includes('"spans"')));
      })
      .map((row) => row.name);
    expect(hits).toEqual(["parse_run"]);
  });
});
