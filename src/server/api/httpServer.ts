import { createServer, type Server } from "node:http";

import { APP_NAME } from "../../shared/constants/app.ts";
import type { AppConfig } from "../config/config.ts";
import type { CredentialStore } from "../config/credentials.ts";
import type { DataLayout } from "../config/paths.ts";
import type { PrewarmQueue } from "../privacy/prewarmQueue.ts";
import type { SelfCheckReport } from "../runtime/selfCheck.ts";
import type { Workspace } from "../runtime/workspace.ts";
import { handleDataRequest } from "./dataRoutes.ts";
import { handleEntitiesRequest } from "./entitiesRoutes.ts";
import { handleIngestRequest } from "./ingestRoutes.ts";
import { handleJobsRequest } from "./jobsRoutes.ts";
import { handleRecordsRequest } from "./recordsRoutes.ts";

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
  /** 启动时使用的环境；环境变量密钥后备与请求处理共用同一份来源。 */
  readonly env: NodeJS.ProcessEnv;
  readonly credentials: CredentialStore;
  readonly selfCheck: SelfCheckReport;
  /**
   * 恢复（R-5 整库替换）会在运行中换掉句柄与服务实例，
   * 路由每个请求都从 workspace 现取现用，而不是在闭包里冻住旧引用。
   */
  readonly workspace: Workspace;
  /** 运行期状态：设置页写盘后标记为需要重启，当前进程不热换 Provider。 */
  readonly runtime: { configDirty: boolean };
  /**
   * 本机预跑的串行队列（M10-4，裁决 M10-D-10）。复核队列端点从这里现读「此刻哪几条在册」——
   * 「还在检查」只认这份在册状态，不从 `hasPayload === false` 反推。
   *
   * **可选**只为既有夹具：直接调 `createApiServer` 的那些测试没接队列。缺席时读数一律是
   * `pending: 0` + 每条 `checkingSinceUtc: null`——那枚 0 说的是「这个夹具没接队列」，
   * **不是**一个正常的生产读数（生产路径由 `bootstrap` 恒传）。
   */
  readonly prewarm?: PrewarmQueue;
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
    const rawUrl = req.url ?? "";
    if (req.method === "GET" && rawUrl === HEALTH_PATH) {
      json(res, 200, {
        app: APP_NAME,
        status: "ok",
        pid: process.pid,
        node: process.version,
        sqliteVersion: facts.selfCheck.sqliteVersion,
        sqliteCtor: facts.workspace.db.ctorName,
        schemaVersion: facts.workspace.schemaVersion,
        contractsFingerprint: facts.selfCheck.contractsFingerprint,
        dataDir: facts.layout.dataDir,
        boundTo: `${facts.config.server.host}:${facts.config.server.port}`,
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${facts.config.server.host}`);
    } catch {
      json(res, 404, { error: "not_found", path: rawUrl });
      return;
    }
    handleRecordsRequest(facts.workspace.records, req, res, url)
      .then((handled) => (handled ? true : handleDataRequest(facts.workspace, req, res, url)))
      // 实体面（M8-1）：`/api/entities` 与其余三个前缀互不相交，挂在链首之后即可。
      .then((handled) => (handled ? true : handleEntitiesRequest(facts, req, res, url)))
      // 队列观测面（M6-0E）：`/api/jobs` 与上面两个前缀互不相交，链上顺序因此无关紧要；
      // 放在 ingest 之前，是为了让「任务」这一段的裁决完全不碰 ingest 的错误分类。
      .then((handled) => (handled ? true : handleJobsRequest(facts, req, res, url)))
      .then((handled) => (handled ? true : handleIngestRequest(facts, req, res, url)))
      .then((handled) => {
        if (!handled) json(res, 404, { error: "not_found", path: rawUrl });
      })
      .catch(() => {
        json(res, 500, { error: "internal_error" });
      });
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
