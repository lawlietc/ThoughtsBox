/**
 * 生产 ProviderTransport 的 fetch 实现（M4-TR-1，缺口一）。
 *
 * 这是全仓第一个「真的向模型端点发 HTTP」的 transport——此前 `ProviderTransport` 只有接口，
 * 生产实现零个（`stubTransport`/`transportReturning` 都在 tests/）。本模块只做一件事：
 * 把 `invokeExtraction` 已经组装好的 `TransportRequest` 交给 global fetch，把响应收敛成
 * `{status, body}`。
 *
 * **职责边界（任务书 §一 现场事实）**：状态分类、超时/取消、信封解析、结构化降级全部在
 * `provider.ts` 的 `invokeExtraction` + `makeSendWithGuards` 里做过并验收（M2-4 封闭面），
 * 这里一律不重发明。尤其超时/取消的判定依赖 `makeSendWithGuards` 对「send 抛出的非
 * ProviderError」的复查——所以本层遇到 abort 类失败必须**原样抛出**，不能提前包装成
 * ProviderError，否则会把 `timeout`/`cancelled` 误判成 `network`。
 *
 * **零日志（任务书 §六-1、密钥红线）**：headers 里带 `Authorization: Bearer <key>`。本模块
 * 不 echo、不 console、不记录任何一行请求/响应；错误消息与 diagnostics 只放内部安全信息
 * （调用路径、错误名），永不引用 headers / body / url 里的任何内容。专项测试有密钥哨兵零泄露钉。
 */

import { ProviderError, type ProviderTransport, type TransportRequest, type TransportResponse } from "./provider.ts";

/**
 * 无状态单例：密钥在发送那一刻由 `invokeExtraction` 从 `process.env[apiKeyEnv]` 取好放进
 * `request.headers`，本 transport 只透传，自己不持有任何密钥、也不读 env。
 */
export const httpTransport: ProviderTransport = {
  async send(request: TransportRequest): Promise<TransportResponse> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: { ...request.headers },
        body: JSON.stringify(request.body),
        signal: request.signal,
      });
    } catch (cause) {
      // 超时/调用方取消：signal 已 aborted，原样抛出，交给 makeSendWithGuards 分类。
      if (request.signal.aborted) throw cause;
      // 真正的传输失败（DNS/连接被拒/socket 断）：归 network。消息只含调用路径（安全封闭值），
      // 绝不拼 cause.message（可能含 url/headers）。
      const errorName = cause instanceof Error ? cause.name : "unknown";
      throw new ProviderError("network", `模型调用 HTTP 请求失败（${request.callPath}）`, {
        error_name: errorName,
        call_path: request.callPath,
      });
    }
    return { status: response.status, body: await response.text() };
  },
};
