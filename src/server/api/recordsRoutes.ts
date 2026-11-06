import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { ThreeAxisCombinationError, ThreeAxisValueError } from "../../shared/contracts/enums.ts";
import {
  InvalidProcessingModeError,
  RecordNotFoundError,
  RecordService,
  RecordStateConflictError,
  RecordValidationError,
} from "../records/service.ts";

const MAX_BODY_BYTES = 1_048_576;

const textBody = z.object({ text: z.string() }).strict();
// M5-1：建记录可选 processing_mode；取值合法性由 RecordService 回到 enums.json 单一事实源校验，
// 这里不重抄字面量（zod 只保证是字符串）。
const createBody = textBody.extend({ processing_mode: z.string().optional() });
const modeBody = z.object({ processing_mode: z.string() }).strict();
// M9-4d-2（裁决 M9-D-15）：只改脱敏档的那一条窄入口。`redaction` 与 `processing` 是两个字段，
// 请求体里出现别的键一律拒（`.strict()`）——「顺手改另一轴」在这条路由上不可能发生。
const redactionModeBody = z.object({ redaction_mode: z.string() }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional() });

export class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * 记录/搜索/存储维护路由（M1a）。错误响应只带错误码，不回显输入原文，
 * 也不把 SQL 细节透出（工程要求 5：日志与异常消息不含原文）。
 */
export async function handleRecordsRequest(
  records: RecordService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!path.startsWith("/api/records") && !path.startsWith("/api/search") && !path.startsWith("/api/storage-maintenance")) {
    return false;
  }
  const send = (status: number, body: unknown): void => replyJson(res, status, body);
  const fail = (cause: unknown): void => {
    if (cause instanceof z.ZodError) {
      send(400, { error: "invalid_request", detail: "请求体或查询参数不符合契约" });
    } else if (cause instanceof InvalidProcessingModeError) {
      send(400, { error: "invalid_request", detail: cause.message, issues: [...cause.issues] });
    } else if (cause instanceof RecordValidationError) {
      send(400, { error: "invalid_request", detail: cause.message });
    } else if (cause instanceof ThreeAxisValueError) {
      // 脱敏档取值不在册 ⇒ 400。消息只带字段名与封闭清单的标签，不带任何原值（§11.2 同取向）。
      send(400, { error: "invalid_request", detail: cause.message, issues: [cause.field] });
    } else if (cause instanceof ThreeAxisCombinationError) {
      // 改后三轴组合不成立 ⇒ 400，服务层已在任何写语句之前抛出，库里逐字未变。
      send(400, { error: "invalid_request", detail: cause.message });
    } else if (cause instanceof RecordNotFoundError) {
      send(404, { error: "not_found" });
    } else if (cause instanceof RecordStateConflictError) {
      send(409, { error: "state_conflict", detail: cause.message });
    } else if (cause instanceof BodyTooLargeError) {
      send(413, { error: "body_too_large" });
    } else if (cause instanceof SyntaxError) {
      send(400, { error: "invalid_json" });
    } else {
      send(500, { error: "internal_error" });
    }
  };

  try {
    if (path === "/api/records") {
      if (method === "POST") {
        const parsed = createBody.parse(await readJsonBody(req));
        const { record, revision } = records.createRecord(
          RecordService.validateText(parsed.text),
          parsed.processing_mode,
        );
        send(201, { record, revision });
        return true;
      }
      if (method === "GET") {
        const q = listQuery.parse({
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined,
        });
        const { records: rows, total } = records.listRecords(q.limit ?? 100, q.offset ?? 0);
        send(200, { records: rows, total });
        return true;
      }
    }

    // M5-1：改这一条的处理模式。选 PATCH 而非 PUT：PUT /api/records/:id 已承载「改原文」的
    // 全量替换语义，这里只增改 mode/status 两列，是部分更新，不该再占一个 PUT。
    const modeMatch = /^\/api\/records\/([^/]+)\/mode$/.exec(path);
    if (modeMatch) {
      const id = modeMatch[1]!;
      if (method === "PATCH") {
        const parsed = modeBody.parse(await readJsonBody(req));
        send(200, records.setProcessingMode(id, parsed.processing_mode));
        return true;
      }
    }

    // M9-4d-2：换脱敏档。与上面 `/mode` 同一种路径解析手法，也是同一取向——PUT 那个位子已经
    // 承载「改原文」的全量替换语义，这里只动一列，是部分更新。
    const redactionModeMatch = /^\/api\/records\/([^/]+)\/redaction-mode$/.exec(path);
    if (redactionModeMatch) {
      const id = redactionModeMatch[1]!;
      if (method === "PATCH") {
        const parsed = redactionModeBody.parse(await readJsonBody(req));
        send(200, records.setRedactionMode(id, parsed.redaction_mode));
        return true;
      }
    }

    const recordMatch = /^\/api\/records\/([^/]+)$/.exec(path);
    if (recordMatch) {
      const id = recordMatch[1]!;
      if (method === "GET") {
        send(200, records.getRecord(id));
        return true;
      }
      if (method === "PUT") {
        const parsed = textBody.parse(await readJsonBody(req));
        const result = records.editRecord(id, RecordService.validateText(parsed.text));
        send(200, result);
        return true;
      }
      if (method === "DELETE") {
        send(200, records.deleteRecord(id));
        return true;
      }
    }

    if (path === "/api/search" && method === "GET") {
      const q = url.searchParams.get("q");
      if (q === null) {
        send(400, { error: "invalid_request", detail: "缺少查询参数 q" });
        return true;
      }
      send(200, records.searchRecords(q));
      return true;
    }

    if (path === "/api/search/rebuild" && method === "POST") {
      const desyncBefore = records.detectIndexDesync();
      records.rebuildSearchIndex();
      send(200, { rebuilt: true, desyncBefore, desyncAfter: records.detectIndexDesync() });
      return true;
    }

    if (path === "/api/storage-maintenance" && method === "GET") {
      send(200, { pending: records.getMaintenanceTasks() });
      return true;
    }

    if (path === "/api/storage-maintenance/retry" && method === "POST") {
      const result = records.retryStorageMaintenance();
      send(result.ok ? 200 : 503, result);
      return true;
    }

    send(405, { error: "method_not_allowed", method, path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
