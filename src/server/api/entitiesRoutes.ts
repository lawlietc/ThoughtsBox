import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type {
  EntityMaskRequestDto,
  EntityPromoteResultDto,
  VocabularyEntityDto,
  VocabularyResponseDto,
} from "../../shared/dto.ts";
import { EntityPromoteError, promoteEntity } from "../entities/promote.ts";
import {
  EntityVocabularyError,
  listVocabulary,
  setEntityMask,
  type VocabularyEntityRow,
} from "../entities/vocabulary.ts";
import type { ServerFacts } from "./httpServer.ts";
import { BodyTooLargeError } from "./recordsRoutes.ts";

/**
 * 实体面的 HTTP 入口（M8-1 先只开转正这一条）。
 *
 * 与 `jobsRoutes.ts` 同一种签名与同一条纪律：**路由不写 SQL**，只做
 * 「请求契约 → 服务调用 → DTO 投影」，四类错误在 `fail` 里一次裁决完。
 * 这里传给服务层的是 `facts.workspace.db` 句柄本身（`jobStoreFor` 同一个先例）：
 * 恢复（R-5）会换掉它，所以每请求现取，不在闭包里冻住旧引用。
 *
 * 三条接口：`POST /api/entities/promote`（`{entityId}`）⇒ `EntityPromoteResultDto`；
 * `GET /api/entities/vocabulary` ⇒ `VocabularyResponseDto`；
 * `PATCH /api/entities/:id/mask`（`{maskEnabled}`）⇒ `VocabularyEntityDto`。
 * 自动转正、批量转正、归档恢复都不在这一面（M8 裁决：只有用户按下的那一下）；
 * 词表只改 `mask_enabled`，不删实体、不改词面。
 */

const ENTITIES_PREFIX = "/api/entities";

const MAX_BODY_BYTES = 1_048_576;

/** 只认这一个键：多余键（比如把 recordId 一起发来）是契约错误，不是「忽略」。 */
const promoteBody = z.object({ entityId: z.string().min(1) }).strict();
const maskBody = z.object({ maskEnabled: z.boolean() }).strict();

function toVocabularyDto(row: VocabularyEntityRow): VocabularyEntityDto {
  return {
    entityId: row.entityId,
    entityType: row.entityType,
    canonicalName: row.canonicalName,
    displayName: row.displayName,
    lifecycleStatus: row.lifecycleStatus,
    originType: row.originType,
    maskEnabled: row.maskEnabled,
    terms: row.terms,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

export async function handleEntitiesRequest(
  facts: ServerFacts,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (path !== ENTITIES_PREFIX && !path.startsWith(`${ENTITIES_PREFIX}/`)) return false;

  const send = (status: number, body: unknown): void => replyJson(res, status, body);

  // 与 ingest / jobs 同一格法：契约不合法 400、不在册 404、状态不接受 409、其余 500。
  // detail 取服务层策展消息（只有实体 id 与类别），不透出词面之外的任何内容。
  const fail = (cause: unknown): void => {
    if (cause instanceof z.ZodError) {
      send(400, { error: "invalid_request", detail: "请求体或查询参数不符合契约" });
    } else if (cause instanceof SyntaxError) {
      send(400, { error: "invalid_json" });
    } else if (cause instanceof BodyTooLargeError) {
      send(413, { error: "body_too_large" });
    } else if (cause instanceof EntityPromoteError) {
      if (cause.kind === "missing") send(404, { error: "not_found", detail: cause.message });
      else send(409, { error: "state_conflict", detail: cause.message });
    } else if (cause instanceof EntityVocabularyError) {
      send(404, { error: "not_found", detail: cause.message });
    } else {
      send(500, { error: "internal_error" });
    }
  };

  try {
    if (path === "/api/entities/vocabulary" && method === "GET") {
      const body: VocabularyResponseDto = {
        entities: listVocabulary(facts.workspace.db).map(toVocabularyDto),
      };
      send(200, body);
      return true;
    }

    const maskMatch = /^\/api\/entities\/([^/]+)\/mask$/.exec(path);
    if (maskMatch?.[1] !== undefined && method === "PATCH") {
      const entityId = decodeURIComponent(maskMatch[1]);
      const parsed: EntityMaskRequestDto = maskBody.parse(await readJsonBody(req));
      const row = setEntityMask(facts.workspace.db, entityId, parsed.maskEnabled);
      send(200, toVocabularyDto(row) satisfies VocabularyEntityDto);
      return true;
    }

    if (path === "/api/entities/promote" && method === "POST") {
      const parsed = promoteBody.parse(await readJsonBody(req));
      const { promoted, entity } = promoteEntity(facts.workspace.db, parsed.entityId);
      const body: EntityPromoteResultDto = {
        promoted,
        entity: {
          id: entity.id,
          entityType: entity.entity_type,
          displayName: entity.display_name,
          lifecycleStatus: entity.lifecycle_status,
        },
      };
      send(200, body);
      return true;
    }

    send(405, { error: "method_not_allowed", method, path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
