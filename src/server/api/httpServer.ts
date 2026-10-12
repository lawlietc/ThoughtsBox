import { createServer, type Server } from "node:http";

import { APP_NAME } from "../../shared/constants/app.ts";
import type { AppConfig } from "../config/config.ts";
import type { DataLayout } from "../config/paths.ts";
import type { SelfCheckReport } from "../runtime/selfCheck.ts";

export const HEALTH_PATH = "/api/health";

export class PortConflictError extends Error {
  constructor(host: string, port: number, cause: string) {
    super(
      `固定端口冲突：${host}:${port} 无法监听（${cause}）。V0 不自动切换端口，请释放端口或改配置后重启。`,
    );
    this.name = "PortConflictError";
  }
}

export interface ServerFacts {
  readonly layout: DataLayout;
  readonly config: AppConfig;
  readonly selfCheck: SelfCheckReport;
  readonly schemaVersion: number;
  readonly sqliteCtorName: string;
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // 本地单用户应用：不缓存，避免图谱/记录状态在浏览器里滞留。
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * 只绑定 127.0.0.1（规格 §6.4）。任何非回环地址的配置都在 listen 前被拒绝，
 * 不依赖运行时才发现自己把私人记录暴露到局域网。
 */
export function assertLoopback(host: string): void {
  if (host !== "127.0.0.1") {
    throw new PortConflictError(host, 0, "只允许绑定 127.0.0.1");
  }
}

export function createApiServer(facts: ServerFacts): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === HEALTH_PATH) {
      json(res, 200, {
        app: APP_NAME,
        status: "ok",
        pid: process.pid,
        node: process.version,
        sqliteVersion: facts.selfCheck.sqliteVersion,
        sqliteCtor: facts.sqliteCtorName,
        schemaVersion: facts.schemaVersion,
        contractsFingerprint: facts.selfCheck.contractsFingerprint,
        dataDir: facts.layout.dataDir,
        boundTo: `${facts.config.server.host}:${facts.config.server.port}`,
      });
      return;
    }
    json(res, 404, { error: "not_found", path: url });
  });
  // 不在 error 事件里抛错：监听失败由 listen() 转成 PortConflictError 交给调用方处理。
  return server;
}

export function listen(server: Server, host: string, port: number): Promise<void> {
  assertLoopback(host);
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        error.code === "EADDRINUSE"
          ? new PortConflictError(host, port, error.code)
          : error,
      );
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}
