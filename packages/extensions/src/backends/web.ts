import type {
  BackendInput,
  BackendOutput,
  ExecutionBackend,
  ExecutionContext,
  ExecutionTraits,
} from "@tachu/core";
import { ValidationError } from "@tachu/core";
import { assertPublicUrl, readResponseBodyWithLimit, withAbortTimeout } from "../common/net";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Web 请求执行后端。
 */
export class WebBackend implements ExecutionBackend {
  readonly name = "web";
  readonly kind = "web" as const;
  readonly traits: ExecutionTraits = {
    sideEffect: "readonly",
    idempotent: false,
    requiresApproval: false,
    timeout: 30_000,
  };

  /**
   * 执行 HTTP 请求。
   *
   * @param input 后端输入
   * @param context 执行上下文
   * @returns 后端输出
   */
  async execute(input: BackendInput, context: ExecutionContext): Promise<BackendOutput> {
    const payload = input.payload as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    };
    if (!payload.url) {
      throw new ValidationError("VALIDATION_INVALID_URL", "web backend 缺少 url");
    }

    const target = await assertPublicUrl(payload.url);
    // D1-LOW-11：把宿主注入的 `context.abortSignal` 与本地超时信号合并，外部取消
    // 能立即中断下游 fetch 请求，不必等到本 backend 的内建超时到期。
    const timeout = withAbortTimeout(
      context.abortSignal,
      payload.timeoutMs ?? this.traits.timeout,
      "TIMEOUT_WEB_BACKEND",
    );
    try {
      const response = await fetch(target, {
        method: payload.method ?? "GET",
        headers: payload.headers,
        body: payload.body,
        signal: timeout.signal,
      });
      const body = await readResponseBodyWithLimit(response, MAX_RESPONSE_BYTES);
      return {
        success: response.ok,
        result: {
          status: response.status,
          body: body.body,
          truncated: body.truncated,
          traceId: context.traceId,
        },
      };
    } finally {
      timeout.cleanup();
    }
  }
}
