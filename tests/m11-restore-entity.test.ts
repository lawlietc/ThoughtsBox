import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/server/db/migrator.ts";
import { IngestService, type IngestServiceOptions } from "../src/server/ingest/ingestService.ts";
import { restorePlaceholders } from "../src/server/privacy/placeholderRestore.ts";
import { LOCAL_LLM_POLICY_VERSION, redact, type RedactionMap } from "../src/server/privacy/redaction.ts";
import { resolveOrCreateEntity } from "../src/server/entities/entityIdentity.ts";
import { countRows, makeSandbox, openSandboxDb, type Sandbox } from "./helpers/sandbox.ts";
import {
  FIXTURE_NOW,
  OK_ENVELOPE,
  SYSTEM_PROMPT,
  createRecord,
  makeAdapter,
  stubTransport,
} from "./helpers/ingestFixtures.ts";
import type { StructuredOutput } from "../src/server/ingest/contract.ts";
import type { Database } from "../src/server/db/adapter.ts";

/**
 * 2026-11-05 脱敏回填 + 本地实体登记（D-1…D-8）。
 *
 * 两件事：
 *  - 回填：云端回稿里的占位符换回真名（evidence 不动）；
 *  - 登记：本机脱敏 span 的语义实体在整理事务里落库（active / ai_generated），
 *    云端围绕占位符组织的提及归并到同一实体。
 */

const CLOUD_RAW = "周末和张三去了蓝山咖啡馆，聊了三个小时";
const PERSON_START = 3;
const PERSON_END = 5;
const ORG_START = 7;
const ORG_END = 12;

function llmMap(): { map: RedactionMap; redactedText: string; person: string; org: string } {
  const { map, redactedText } = redact(CLOUD_RAW, [], {
    nonce: "abc123",
    policyVersion: LOCAL_LLM_POLICY_VERSION,
    extraCandidates: [
      { start: PERSON_START, end: PERSON_END, kind: "person" },
      { start: ORG_START, end: ORG_END, kind: "organization" },
    ],
  });
  return { map, redactedText, person: map.spans[0]!.placeholder, org: map.spans[1]!.placeholder };
}

describe("restorePlaceholders", () => {
  it("把映射内的占位符换回真名；未知占位符原样保留", () => {
    const { map } = llmMap();
    const person = map.spans[0]!.placeholder;
    const org = map.spans[1]!.placeholder;
    expect(restorePlaceholders(`和${person}在${org}`, map, CLOUD_RAW)).toBe("和张三在蓝山咖啡馆");
    expect(restorePlaceholders("[person_9_dead]", map, CLOUD_RAW)).toBe("[person_9_dead]");
  });

  it("模型把方括号去掉（裸形 `person_1_x`）也照样回填真名", () => {
    const { map } = llmMap();
    const bare = (placeholder: string): string => placeholder.replace(/^\[|\]$/g, "");
    const person = bare(map.spans[0]!.placeholder);
    const org = bare(map.spans[1]!.placeholder);
    expect(restorePlaceholders(`和${person}在${org}`, map, CLOUD_RAW)).toBe("和张三在蓝山咖啡馆");
  });
});

describe("resolveOrCreateEntity", () => {
  let sandbox: Sandbox;
  let db: Database;

  beforeEach(() => {
    sandbox = makeSandbox("tb-m11-identity-");
    db = openSandboxDb(sandbox.layout);
    migrate(db);
  });
  afterEach(() => {
    db.close();
    sandbox.cleanup();
  });

  it("同名同类型复用；同名不同类型分开；均落 active + ai_generated", () => {
    const now = new Date(FIXTURE_NOW).toISOString();
    const a = resolveOrCreateEntity(db, { name: "张三", type: "person", now });
    const b = resolveOrCreateEntity(db, { name: "张三", type: "person", now });
    const c = resolveOrCreateEntity(db, { name: "张三", type: "place", now });
    expect(a.created).toBe(true);
    expect(b).toEqual({ entityId: a.entityId, created: false });
    expect(c.created).toBe(true);
    expect(c.entityId).not.toBe(a.entityId);
    expect(countRows(db, "entity")).toBe(2);
    const row = db.prepare(`select lifecycle_status, origin_type, mask_enabled from entity where id = ?`).get(a.entityId) as {
      lifecycle_status: string;
      origin_type: string;
      mask_enabled: number;
    };
    expect(row).toEqual({ lifecycle_status: "active", origin_type: "ai_generated", mask_enabled: 1 });
  });
});

describe("整理：回填 + 实体登记（本地模型轨）", () => {
  let sandbox: Sandbox;
  let db: Database;
  let revisionId: string;
  let map: RedactionMap;
  let redactedText: string;
  let person: string;
  let org: string;

  beforeEach(() => {
    sandbox = makeSandbox("tb-m11-ingest-");
    db = openSandboxDb(sandbox.layout);
    migrate(db);
    ({ map, redactedText, person, org } = llmMap());
    revisionId = createRecord(db, CLOUD_RAW, "cloud_redacted").revisionId;
  });
  afterEach(() => {
    db.close();
    sandbox.cleanup();
  });

  function cloudOutput(): StructuredOutput {
    return {
      title: `和${person}在${org}`,
      summary: `${person}和${org}聊了三个小时`,
      episodes: [
        {
          summary: `和${person}去了${org}`,
          evidence: `和${person}去了`,
          eventTime: { raw: "周末", precision: "day", certainty: "approximate", start: "2026-10-17", end: "2026-10-17" },
        },
      ],
      thoughts: [{ text: `${person}喜欢${org}`, evidence: `和${person}去了` }],
      emotions: [],
      topics: [],
      // 复现真实故障：云端把占位符本身填进 candidateConceptId（没有真实实体 ID 可用）。
      entities: [{ labelSaid: person, candidateConceptId: person, basis: "explicit", evidence: `和${person}` }],
      relations: [],
    };
  }

  function makeService(transport: ReturnType<typeof stubTransport>["transport"]): IngestService {
    const options: IngestServiceOptions = {
      db,
      adapter: makeAdapter({ baseUrl: "https://api.openai.com/v1" }),
      transport,
      systemPrompt: SYSTEM_PROMPT,
      grantCheck: () => {},
      now: () => new Date(FIXTURE_NOW),
    };
    return new IngestService(options);
  }

  it("真名入库：摘要/标题/经历/念头回填；本地实体登记；云端占位符提及归并到同一实体", async () => {
    const output = cloudOutput();
    const stub = stubTransport(OK_ENVELOPE(output));
    const result = await makeService(stub.transport).ingest({
      recordRevisionId: revisionId,
      payloadText: redactedText,
      redactionMap: map,
    });

    expect(result.succeeded).toBe(true);
    // 标题/摘要已回填
    expect(result.title).toBe("和张三在蓝山咖啡馆");
    expect(result.summary).toBe("张三和蓝山咖啡馆聊了三个小时");
    const runId = (db.prepare(`select id from parse_run where source_revision_id = ?`).get(revisionId) as { id: string }).id;
    const run = db.prepare(`select ai_title, ai_summary from parse_run where id = ?`).get(runId) as {
      ai_title: string;
      ai_summary: string;
    };
    expect(run.ai_title).toBe("和张三在蓝山咖啡馆");
    expect(run.ai_summary).toBe("张三和蓝山咖啡馆聊了三个小时");
    expect(run.ai_summary).not.toContain(person);

    // 经历摘要回填
    const episode = db.prepare(`select summary from episode where parse_run_id is not null limit 1`).get() as { summary: string };
    expect(episode.summary).toBe("和张三去了蓝山咖啡馆");

    // 两个实体已登记，均为 active / ai_generated
    expect(countRows(db, "entity")).toBe(2);
    const names = db.prepare(`select entity_type, canonical_name, lifecycle_status from entity order by entity_type`).all() as Array<{
      entity_type: string;
      canonical_name: string;
      lifecycle_status: string;
    }>;
    expect(names).toEqual([
      { entity_type: "organization", canonical_name: "蓝山咖啡馆", lifecycle_status: "active" },
      { entity_type: "person", canonical_name: "张三", lifecycle_status: "active" },
    ]);
    // 张三（云端标签）+ 蓝山咖啡馆（本机 span 补的提及）
    expect(countRows(db, "entity_mention")).toBeGreaterThanOrEqual(2);
  });

  it("候选 ID 是裸形占位符（无方括号）也不整批失败：清空候选 ID、词面回填、实体照常登记", async () => {
    const bare = (placeholder: string): string => placeholder.replace(/^\[|\]$/g, "");
    const barePerson = bare(person);
    const output = cloudOutput();
    output.entities = [
      { labelSaid: barePerson, candidateConceptId: barePerson, basis: "explicit", evidence: `和${person}` },
    ];
    const stub = stubTransport(OK_ENVELOPE(output));
    const result = await makeService(stub.transport).ingest({
      recordRevisionId: revisionId,
      payloadText: redactedText,
      redactionMap: map,
    });

    expect(result.succeeded).toBe(true);
    expect(result.title).toBe("和张三在蓝山咖啡馆");
    expect(countRows(db, "entity")).toBe(2);
  });
});
