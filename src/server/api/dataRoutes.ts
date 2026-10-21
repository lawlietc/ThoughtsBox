import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { BackupError } from "../backup/backupService.ts";
import { JsonlImportError, exportJsonl, importJsonl } from "../backup/jsonl.ts";
import { RestoreError, restoreFromBackup } from "../backup/restoreService.ts";
import { DataCheckFailure, runDataCheck } from "../runtime/dataCheck.ts";
import type { Workspace } from "../runtime/workspace.ts";
import { BodyTooLargeError } from "./recordsRoutes.ts";

/**
 * 数据管理 API（M1b §五–§七）。路由只认 Workspace 的当下引用：
 * 恢复换血后所有端点自动作用于新库，不存在「旧句柄继续服务」的缝隙。
 *
 * 错误语义与 M1a 一致：不回显输入原文、不透出 SQL 细节；
 * 但备份/恢复/导入的失败原因本身就是用户要做的决策信息（中文策展文案），如实带出。
 */

const MAX_JSON_BODY_BYTES = 1_048_576;
/** JSONL 导入是整库文本：上限与记录请求分开，超限显式 413 而不是截断半份导入。 */
const MAX_IMPORT_BODY_BYTES = 32 * 1_048_576;

const restoreBody = z
  .object({ file: z.string().min(1), confirm: z.boolean().optional() })
  .strict();

async function readRawBody(req: IncomingMessage, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > capBytes) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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

function exportFileName(now: Date): string {
  return `thoughtsbox-export-${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z.jsonl`;
}

const DATA_PREFIXES = [
  "/api/backups",
  "/api/export/jsonl",
  "/api/import/jsonl",
  "/api/restore",
  "/api/data-check",
];

export async function handleDataRequest(
  workspace: Workspace,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!DATA_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return false;
  }
  const send = (status: number, body: unknown): void => replyJson(res, status, body);

  const fail = (cause: unknown): void => {
    if (cause instanceof z.ZodError) {
      send(400, { error: "invalid_request", detail: "请求体或查询参数不符合契约" });
    } else if (cause instanceof BodyTooLargeError) {
      send(413, { error: "body_too_large" });
    } else if (cause instanceof SyntaxError) {
      send(400, { error: "invalid_json" });
    } else if (cause instanceof BackupError) {
      // 备份面只拒绝用户可理解的两种情况：名字不合法/文件不在，或快照流程显式失败。
      if (/非法备份文件名|路径越界|不存在/.test(cause.message)) {
        send(404, { error: "backup_not_found", detail: cause.message });
      } else {
        send(500, { error: "backup_failed", detail: cause.message });
      }
    } else if (cause instanceof JsonlImportError) {
      if (cause.kind === "not_empty") {
        send(409, { error: "target_not_empty", detail: cause.message });
      } else {
        send(400, { error: "invalid_import", detail: cause.message, issues: cause.issues });
      }
    } else if (cause instanceof RestoreError) {
      if (cause.kind === "rejected") {
        send(400, { error: "restore_rejected", detail: cause.message });
      } else {
        send(500, {
          error: "restore_failed",
          detail: cause.message,
          safetyBackupName: cause.safetyBackupName,
        });
      }
    } else if (cause instanceof DataCheckFailure) {
      send(503, { error: "data_check_failed", step: cause.step, detail: cause.detail });
    } else {
      send(500, { error: "internal_error" });
    }
  };

  try {
    if (path === "/api/backups" && method === "POST") {
      send(201, { backup: workspace.backups.createBackup() });
      return true;
    }
    if (path === "/api/backups" && method === "GET") {
      send(200, { ...workspace.backups.listBackups(), disk: workspace.backups.diskCapacity() });
      return true;
    }

    const verifyMatch = /^\/api\/backups\/([^/]+)\/verify$/.exec(path);
    if (verifyMatch && method === "POST") {
      const name = decodeURIComponent(verifyMatch[1]!);
      send(200, { name, verification: workspace.backups.verifyBackup(name) });
      return true;
    }

    const fileMatch = /^\/api\/backups\/([^/]+)$/.exec(path);
    if (fileMatch && method === "DELETE") {
      const name = decodeURIComponent(fileMatch[1]!);
      workspace.backups.deleteBackup(name);
      send(200, { deleted: name });
      return true;
    }

    if (path === "/api/export/jsonl" && method === "GET") {
      const payload = exportJsonl(workspace.db);
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "content-disposition": `attachment; filename="${exportFileName(new Date())}"`,
        "cache-control": "no-store",
      });
      res.end(payload);
      return true;
    }

    if (path === "/api/import/jsonl" && method === "POST") {
      const body = await readRawBody(req, MAX_IMPORT_BODY_BYTES);
      send(200, importJsonl(workspace.db, body.toString("utf8")));
      return true;
    }

    if (path === "/api/restore" && method === "POST") {
      const parsed = restoreBody.parse(JSON.parse((await readRawBody(req, MAX_JSON_BODY_BYTES)).toString("utf8") || "{}"));
      if (parsed.confirm !== true) {
        // §7.1 的 UI 告知义务在服务端的兜底门槛：没有显式 confirm 就没有恢复。
        send(400, { error: "confirm_required", detail: "恢复会整体替换当前数据库，必须显式确认（confirm=true）" });
        return true;
      }
      send(200, restoreFromBackup(workspace, parsed.file));
      return true;
    }

    if (path === "/api/data-check" && method === "GET") {
      const report = runDataCheck(workspace.db);
      send(200, { ok: true, ...report });
      return true;
    }

    const knownPath =
      verifyMatch !== null ||
      fileMatch !== null ||
      (path === "/api/backups" ||
        path === "/api/export/jsonl" ||
        path === "/api/import/jsonl" ||
        path === "/api/restore" ||
        path === "/api/data-check");
    send(knownPath ? 405 : 404, knownPath ? { error: "method_not_allowed", method, path } : { error: "not_found", path });
    return true;
  } catch (cause) {
    fail(cause);
    return true;
  }
}
