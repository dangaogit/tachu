import OpenAI from "openai";
import { createTiktokenTokenizer, type Tokenizer } from "@tachu/core";
import {
  ProviderError,
  TimeoutError,
  type AdapterCallContext,
  type ChatFinishReason,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type ToolCallRequest,
  type ToolDefinition,
} from "@tachu/core";
import { withAbortTimeout } from "../common/net";

interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  /**
   * 透传给 OpenAI SDK 构造器的附加选项（对应 `ProviderConnectionConfig.extra`）。
   *
   * 典型用途：`defaultHeaders` / `defaultQuery` / `httpAgent` / `dangerouslyAllowBrowser`
   * 等官方 SDK 支持但未在 {@link OpenAIProviderOptions} 显式暴露的字段。仅当值非空
   * 时会与显式字段浅合并进 SDK 构造参数。
   */
  extra?: Record<string, unknown>;
  /**
   * `listAvailableModels` 的 TTL 缓存窗口（ms）。默认 60_000；<=0 关闭缓存（每次真实拉取）。
   */
  modelListCacheTtlMs?: number;
}

interface ExtendedChatRequest extends ChatRequest {
  topP?: number;
  stop?: string[];
  toolChoice?:
  | "auto"
  | "required"
  | {
    function: {
      name: string;
    };
  };
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: unknown };
}

const DEFAULT_TIMEOUT_MS = 60_000;

const inferModelCapabilities = (modelName: string): ModelInfo["capabilities"] => {
  const lowered = modelName.toLowerCase();
  const vision =
    lowered.includes("gpt-4o") ||
    lowered.includes("o1") ||
    lowered.includes("o3") ||
    lowered.includes("vision") ||
    /** Gemini 系与显式带 image 的生图/多模态模型名（如 geekai 上的 gemini flash image） */
    lowered.includes("gemini") ||
    lowered.includes("image-preview") ||
    lowered.includes("flash-image");
  const longContext = lowered.includes("128k") || lowered.includes("200k");
  return {
    supportedModalities: vision ? ["text", "image"] : ["text"],
    maxContextTokens: longContext ? 200_000 : 128_000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
  };
};

const toOpenAiTools = (
  tools: ToolDefinition[] | undefined,
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
};

const mapMessageContent = (
  content: Message["content"],
): string | Array<Record<string, unknown>> => {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: part.image_url,
    };
  });
};

const mapMessage = (message: Message): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      role: "tool",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
      tool_call_id: message.toolCallId ?? message.name ?? "tool-call",
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    // ADR-0002：回灌 Agentic Loop 历史时，assistant 消息可能伴随结构化 tool_calls。
    // OpenAI 协议：`message.tool_calls: [{ id, type: "function", function: { name, arguments } }]`。
    // `arguments` 必须是 JSON 字符串（OpenAI SDK 的类型约束），此处对 object 做 stringify。
    const textContent =
      typeof message.content === "string"
        ? message.content
        : message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
    return {
      role: "assistant",
      content: textContent.length > 0 ? textContent : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
      ...(message.name ? { name: message.name } : {}),
    };
  }
  return {
    role: message.role,
    content: mapMessageContent(message.content),
    ...(message.name ? { name: message.name } : {}),
  };
};

/**
 * 把 OpenAI 原生响应里的 `tool_calls` 数组解析为结构化 `ToolCallRequest[]`。
 *
 * - `arguments` 是官方 SDK 类型规定的 JSON 字符串；解析失败意味着模型返回了非法
 *   JSON，抛 `PROVIDER_TOOL_ARGUMENTS_INVALID` 让上游 Agentic Loop 决定如何处置。
 * - 空参数字符串（LLM 偶尔会发 `""`）统一视为 `{}`，与 Claude / OpenAI 官方示例一致。
 */
const parseOpenAiToolCalls = (
  raw: unknown,
): ToolCallRequest[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: ToolCallRequest[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : `call-${out.length}`;
    const name = typeof obj.function?.name === "string" ? obj.function.name : "";
    if (name.length === 0) continue;
    const rawArgs = obj.function?.arguments;
    let parsedArgs: Record<string, unknown> = {};
    if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        } else {
          throw new Error("tool arguments must be a JSON object");
        }
      } catch (err) {
        throw new ProviderError(
          "PROVIDER_TOOL_ARGUMENTS_INVALID",
          `OpenAI 返回的工具调用 ${name} 参数不是合法 JSON`,
          { cause: err, retryable: true },
        );
      }
    } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      // 兼容：部分 SDK 直接返回对象。
      parsedArgs = rawArgs as Record<string, unknown>;
    }
    out.push({ id, name, arguments: parsedArgs });
  }
  return out.length > 0 ? out : undefined;
};

/**
 * OpenAI `finish_reason` → 统一 `ChatFinishReason` 映射。
 */
const mapOpenAiFinishReason = (raw: unknown): ChatFinishReason => {
  if (raw === "stop") return "stop";
  if (raw === "tool_calls" || raw === "function_call") return "tool_calls";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  if (raw === null || raw === undefined) return "unknown";
  return "unknown";
};

const extractContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
};

const mapProviderError = (error: unknown): ProviderError | TimeoutError => {
  if (error instanceof TimeoutError) {
    return error;
  }
  if (error instanceof ProviderError) {
    return error;
  }
  const candidate = error as { status?: number; code?: string; message?: string; cause?: unknown };
  const message = candidate.message ?? "OpenAI 调用失败";
  if (candidate.status === 401) {
    return new ProviderError("PROVIDER_AUTH_FAILED", message, { cause: error });
  }
  if (candidate.status === 429) {
    return new ProviderError("PROVIDER_RATE_LIMITED", message, {
      cause: error,
      retryable: true,
    });
  }
  if ((candidate.status ?? 0) >= 500) {
    return new ProviderError("PROVIDER_UPSTREAM_ERROR", message, {
      cause: error,
      retryable: true,
    });
  }
  if (candidate.code === "ETIMEDOUT" || candidate.code === "ECONNABORTED") {
    return new TimeoutError("TIMEOUT_PROVIDER_REQUEST", message, {
      cause: error,
      retryable: true,
    });
  }
  return new ProviderError("PROVIDER_CALL_FAILED", message, {
    cause: error,
    retryable: true,
  });
};

/**
 * OpenAI 官方 Provider Adapter。
 */
export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly id = "openai";
  readonly name = "OpenAI";

  private readonly client: OpenAI;
  /** 用于识别百炼 OpenAI 兼容端点（`compatible-mode/v1`），以便修正 SSE 请求头。 */
  private readonly resolvedBaseURL: string | undefined;
  private readonly timeoutMs: number;
  private readonly tokenizerCache = new Map<string, Tokenizer>();
  /**
   * `listAvailableModels` 的 TTL 缓存（D1-LOW-22）。
   * 避免在 `checkCapabilities` / CLI `--verbose` 等高频路径下反复拉取远端模型列表。
   * 默认 TTL 60s，可通过 `OpenAIProviderOptions.modelListCacheTtlMs` 覆盖（0 / 负值关闭缓存）。
   */
  private modelListCache: { at: number; value: ModelInfo[] } | null = null;
  private readonly modelListCacheTtlMs: number;

  /**
   * 创建 OpenAI Provider。
   *
   * @param options Provider 配置
   * @throws ProviderError 当缺失凭据时抛出
   */
  constructor(options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "PROVIDER_MISSING_CREDENTIALS",
        "缺少 OPENAI_API_KEY 或 options.apiKey",
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelListCacheTtlMs = options.modelListCacheTtlMs ?? 60_000;
    this.resolvedBaseURL = options.baseURL;
    this.client = new OpenAI({
      ...(options.extra ?? {}),
      apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
      project: options.project,
    });
  }

  /**
   * 百炼要求：`X-DashScope-SSE=enable` 仅与 `stream=true` 同发；非流式须 `disable`。
   * 流式请求在兼容端点上显式带 `enable`，避免构造器里误配 `disable` 时与 `stream=true` 冲突。
   */
  private isDashScopeCompatibleBaseUrl(): boolean {
    const u = this.resolvedBaseURL ?? "";
    return u.toLowerCase().includes("dashscope");
  }

  /**
   * 非流式请求需覆盖构造器里可能存在的 `X-DashScope-SSE=enable`（与 `stream=false` 互斥）。
   * `baseURL` 为空时使用 SDK 默认官方端点，不附加百炼头。
   */
  private dashScopeSseDisableHeaderForNonStream(): Record<string, string> | undefined {
    const u = (this.resolvedBaseURL ?? "").trim().toLowerCase();
    if (u.length === 0 || u.includes("api.openai.com")) {
      return undefined;
    }
    return { "X-DashScope-SSE": "disable" };
  }

  /**
   * 真实查询 OpenAI 可用模型列表。
   *
   * 带 TTL 缓存；默认 60s，可通过构造选项 `modelListCacheTtlMs` 调整，<=0 关闭缓存。
   *
   * @returns 模型能力列表
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    const ttl = this.modelListCacheTtlMs;
    if (ttl > 0 && this.modelListCache && Date.now() - this.modelListCache.at < ttl) {
      return this.modelListCache.value;
    }
    try {
      const response = await this.client.models.list();
      const models = "data" in response ? response.data : [];
      const result = models.map((item) => ({
        modelName: item.id,
        capabilities: inferModelCapabilities(item.id),
      }));
      if (ttl > 0) {
        this.modelListCache = { at: Date.now(), value: result };
      }
      return result;
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  /**
   * 发起非流式对话请求。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   * @returns 对话响应
   */
  async chat(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const extended = request as ExtendedChatRequest;
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((message) => mapMessage(message)),
      };
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
      if (request.maxTokens !== undefined) {
        body.max_tokens = request.maxTokens;
      }
      if (extended.topP !== undefined) {
        body.top_p = extended.topP;
      }
      if (extended.stop) {
        body.stop = extended.stop;
      }
      const tools = toOpenAiTools(request.tools);
      if (tools) {
        body.tools = tools;
      }
      body.tool_choice =
        extended.toolChoice === "required"
          ? "required"
          : extended.toolChoice && typeof extended.toolChoice === "object"
            ? { type: "function", function: { name: extended.toolChoice.function.name } }
            : "auto";
      if (extended.responseFormat) {
        body.response_format = extended.responseFormat;
      }
      const sseNonStream = this.dashScopeSseDisableHeaderForNonStream();
      const response = await this.client.chat.completions.create(body as never, {
        signal: timeout.signal,
        ...(sseNonStream ? { headers: sseNonStream } : {}),
      });

      const choice = response.choices[0];
      const content = extractContent(choice?.message?.content ?? "");
      const toolCalls = parseOpenAiToolCalls(choice?.message?.tool_calls);
      const finishReason = mapOpenAiFinishReason(choice?.finish_reason);
      return {
        content,
        ...(toolCalls ? { toolCalls } : {}),
        finishReason,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      };
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * 发起流式对话请求。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   * @returns 文本增量流
   */
  async *chatStream(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const extended = request as ExtendedChatRequest;
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const stream = await this.client.chat.completions.create(
        (() => {
          const body: Record<string, unknown> = {
            model: request.model,
            messages: request.messages.map((message) => mapMessage(message)),
            stream: true,
          };
          if (request.temperature !== undefined) {
            body.temperature = request.temperature;
          }
          if (request.maxTokens !== undefined) {
            body.max_tokens = request.maxTokens;
          }
          if (extended.topP !== undefined) {
            body.top_p = extended.topP;
          }
          if (extended.stop) {
            body.stop = extended.stop;
          }
          const tools = toOpenAiTools(request.tools);
          if (tools) {
            body.tools = tools;
          }
          body.tool_choice =
            extended.toolChoice === "required"
              ? "required"
              : extended.toolChoice && typeof extended.toolChoice === "object"
                ? { type: "function", function: { name: extended.toolChoice.function.name } }
                : "auto";
          if (extended.responseFormat) {
            body.response_format = extended.responseFormat;
          }
          return body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
        })(),
        {
          signal: timeout.signal,
          ...(this.isDashScopeCompatibleBaseUrl()
            ? { headers: { "X-DashScope-SSE": "enable" } }
            : {}),
        },
      );

      // 按 index 聚合 tool_call 分片：
      //   OpenAI Stream 把多 tool_call 按 `index` 投递增量（id/name 可能只在第一片出现，
      //   `arguments` 跨片拼接）。我们在 stream 期间即时转发 `tool-call-delta`，
      //   并在 `finish_reason` 到达时聚合产出 `tool-call-complete`，最后发 `finish`。
      const toolCallBuffer = new Map<
        number,
        { id?: string; name?: string; arguments: string }
      >();
      let finishReason: ChatFinishReason = "unknown";

      for await (const chunk of stream) {
        if (timeout.signal.aborted) {
          throw timeout.signal.reason ?? new Error("aborted");
        }
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        const text = extractContent(delta?.content ?? "");
        if (text) {
          yield { type: "text-delta", delta: text };
        }
        const toolDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined;
        if (toolDelta) {
          for (const entry of toolDelta) {
            const index = typeof entry.index === "number" ? entry.index : 0;
            const id = typeof entry.id === "string" ? entry.id : undefined;
            const name =
              typeof entry.function?.name === "string" ? entry.function.name : undefined;
            const argumentsDelta =
              typeof entry.function?.arguments === "string"
                ? entry.function.arguments
                : undefined;
            const buffered = toolCallBuffer.get(index) ?? { arguments: "" };
            if (id) buffered.id = id;
            if (name) buffered.name = name;
            if (argumentsDelta) buffered.arguments += argumentsDelta;
            toolCallBuffer.set(index, buffered);
            yield {
              type: "tool-call-delta",
              index,
              ...(id ? { id } : {}),
              ...(name ? { name } : {}),
              ...(argumentsDelta ? { argumentsDelta } : {}),
            };
          }
        }
        if (choice?.finish_reason) {
          finishReason = mapOpenAiFinishReason(choice.finish_reason);
          break;
        }
      }

      // 聚合阶段：把 buffer 里的 tool_call 逐一解析为 `ToolCallRequest` 并发 complete 事件。
      if (toolCallBuffer.size > 0) {
        const indices = [...toolCallBuffer.keys()].sort((a, b) => a - b);
        for (const index of indices) {
          const entry = toolCallBuffer.get(index)!;
          const name = entry.name ?? "";
          if (name.length === 0) continue;
          const id = entry.id ?? `call-${index}`;
          let parsedArgs: Record<string, unknown> = {};
          const argsText = entry.arguments.trim();
          if (argsText.length > 0) {
            try {
              const parsed = JSON.parse(argsText);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedArgs = parsed as Record<string, unknown>;
              } else {
                throw new Error("tool arguments must be a JSON object");
              }
            } catch (err) {
              throw new ProviderError(
                "PROVIDER_TOOL_ARGUMENTS_INVALID",
                `OpenAI stream 聚合后的工具调用 ${name} 参数不是合法 JSON`,
                { cause: err, retryable: true },
              );
            }
          }
          yield {
            type: "tool-call-complete",
            call: { id, name, arguments: parsedArgs },
          };
        }
      }

      yield { type: "finish", finishReason };
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * 使用 tiktoken 计算消息 token。
   *
   * @param messages 消息列表
   * @param model 模型名
   * @returns token 数
   */
  async countTokens(messages: Message[], model: string): Promise<number> {
    const payload = messages
      .map((item) => `${item.role}:${item.name ?? ""}:${item.toolCallId ?? ""}:${item.content}`)
      .join("\n");
    return this.getTokenizer(model).count(payload);
  }

  /**
   * 释放 tokenizer 等资源。
   */
  async dispose(): Promise<void> {
    for (const tokenizer of this.tokenizerCache.values()) {
      tokenizer.dispose?.();
    }
    this.tokenizerCache.clear();
  }

  private getTokenizer(model: string): Tokenizer {
    const existing = this.tokenizerCache.get(model);
    if (existing) {
      return existing;
    }
    const tokenizer = createTiktokenTokenizer(model);
    this.tokenizerCache.set(model, tokenizer);
    return tokenizer;
  }
}
