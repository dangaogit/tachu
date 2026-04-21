import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  TimeoutError,
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
import type { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { withAbortTimeout } from "../common/net";

interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  /**
   * 透传给 Anthropic SDK 构造器的附加选项（对应 `ProviderConnectionConfig.extra`）。
   *
   * 典型用途：`defaultHeaders` / `defaultQuery` / `httpAgent` 等 SDK 支持但未在
   * {@link AnthropicProviderOptions} 显式暴露的字段。仅当值非空时与显式字段浅合并。
   */
  extra?: Record<string, unknown>;
  /**
   * `listAvailableModels` TTL 缓存窗口（ms）。默认 60_000；<=0 关闭缓存。
   */
  modelListCacheTtlMs?: number;
}

interface ExtendedChatRequest extends ChatRequest {
  stop?: string[];
  toolChoice?:
    | "auto"
    | "required"
    | {
        function: {
          name: string;
        };
      };
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Anthropic `/v1/models` 返回结构（SDK 0.30+ 提供 `client.models.list`）。
 *
 * 仅在 SDK 升级或端点缺失时用作 fallback 映射参考，**不再作为硬编码清单返回**。
 */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    modelName: "claude-3-5-sonnet-latest",
    capabilities: {
      supportedModalities: ["text", "image"],
      maxContextTokens: 200_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
  {
    modelName: "claude-3-5-haiku-latest",
    capabilities: {
      supportedModalities: ["text", "image"],
      maxContextTokens: 200_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
  {
    modelName: "claude-3-opus-latest",
    capabilities: {
      supportedModalities: ["text", "image"],
      maxContextTokens: 200_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
];

interface AnthropicSdkCapability {
  supported?: boolean;
}

interface AnthropicSdkModelCapabilities {
  image_input?: AnthropicSdkCapability;
  pdf_input?: AnthropicSdkCapability;
  structured_outputs?: AnthropicSdkCapability;
}

interface AnthropicSdkModelInfo {
  id: string;
  capabilities?: AnthropicSdkModelCapabilities | null;
  max_input_tokens?: number | null;
}

/**
 * 将 Anthropic SDK 返回的原始 `ModelInfo` 适配为本项目统一的 {@link ModelInfo}。
 *
 * Claude 系列全部支持 streaming 与 tool use（tool use 以 `structured_outputs`
 * 近似代表；在 `capabilities` 为 `null` 或字段缺失时保守回退为 `true`）。
 */
const adaptSdkModelInfo = (raw: AnthropicSdkModelInfo): ModelInfo => {
  const capabilities = raw.capabilities ?? undefined;
  const supportsImage = capabilities?.image_input?.supported === true;
  const supportsPdf = capabilities?.pdf_input?.supported === true;
  const supportedModalities: string[] = ["text"];
  if (supportsImage) {
    supportedModalities.push("image");
  }
  if (supportsPdf) {
    supportedModalities.push("file");
  }
  return {
    modelName: raw.id,
    capabilities: {
      supportedModalities,
      maxContextTokens: raw.max_input_tokens ?? 200_000,
      supportsStreaming: true,
      supportsFunctionCalling:
        capabilities?.structured_outputs?.supported !== false,
    },
  };
};

const toAnthropicTools = (
  tools: ToolDefinition[] | undefined,
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> | undefined =>
  tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

const collectText = (content: Message["content"]): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
};

const toAnthropicContentBlocks = (
  content: Message["content"],
): string | Array<Record<string, unknown>> => {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    // MessageImagePart → Anthropic image block
    // 支持 data URL 与远端 URL 两种输入；Anthropic SDK 会根据 source.type 分派。
    const url = part.image_url.url;
    if (url.startsWith("data:")) {
      const [header, data] = url.split(",", 2);
      const mediaTypeMatch = /data:([^;,]+)(?:;base64)?/.exec(header ?? "");
      const mediaType = mediaTypeMatch?.[1] ?? "image/png";
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: data ?? "",
        },
      };
    }
    return {
      type: "image",
      source: { type: "url", url },
    };
  });
};

const toAnthropicMessages = (
  messages: Message[],
): { system: string | undefined; messages: Messages.MessageParam[] } => {
  const systemSegments: string[] = [];
  const converted: Messages.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemSegments.push(collectText(message.content));
      continue;
    }
    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? message.name ?? "tool",
            content: collectText(message.content),
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      // ADR-0002：Agentic Loop 回灌历史时，assistant 消息需把 text + tool_use 块混排。
      // Anthropic 协议要求 tool_use 块位于同一条 assistant content 数组内，
      // 且 `input` 为**对象**（不是 JSON 字符串，与 OpenAI 相反）。
      const textContent = collectText(message.content).trim();
      const blocks: Array<Record<string, unknown>> = [];
      if (textContent.length > 0) {
        blocks.push({ type: "text", text: textContent });
      }
      for (const call of message.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      converted.push({
        role: "assistant",
        content: blocks as never,
      });
      continue;
    }
    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: toAnthropicContentBlocks(message.content) as never,
    });
  }

  return {
    system: systemSegments.length > 0 ? systemSegments.join("\n\n") : undefined,
    messages: converted,
  };
};

/**
 * 把 Anthropic 响应的 content blocks 里 `type === "tool_use"` 的块解析为 `ToolCallRequest[]`。
 *
 * Anthropic 和 OpenAI 的关键差异：`tool_use.input` **已经是对象**，不是 JSON 字符串。
 */
const parseAnthropicToolCalls = (
  content: unknown,
): ToolCallRequest[] | undefined => {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const out: ToolCallRequest[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const obj = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (obj.type !== "tool_use") continue;
    const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : `call-${out.length}`;
    const name = typeof obj.name === "string" ? obj.name : "";
    if (name.length === 0) continue;
    let input: Record<string, unknown> = {};
    if (obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)) {
      input = obj.input as Record<string, unknown>;
    }
    out.push({ id, name, arguments: input });
  }
  return out.length > 0 ? out : undefined;
};

/**
 * Anthropic `stop_reason` → 统一 `ChatFinishReason` 映射。
 */
const mapAnthropicFinishReason = (raw: unknown): ChatFinishReason => {
  if (raw === "end_turn") return "stop";
  if (raw === "tool_use") return "tool_calls";
  if (raw === "max_tokens") return "length";
  if (raw === "stop_sequence") return "stop";
  if (raw === null || raw === undefined) return "unknown";
  return "unknown";
};

const mapProviderError = (error: unknown): ProviderError | TimeoutError => {
  if (error instanceof TimeoutError || error instanceof ProviderError) {
    return error;
  }
  const candidate = error as { status?: number; message?: string; cause?: unknown };
  const message = candidate.message ?? "Anthropic 调用失败";
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
  return new ProviderError("PROVIDER_CALL_FAILED", message, {
    cause: error,
    retryable: true,
  });
};

/**
 * Anthropic 官方 Provider Adapter。
 */
export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  readonly name = "Anthropic";

  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  /**
   * `listAvailableModels` TTL 缓存（D1-LOW-22），默认 60s，避免反复命中远端 `/v1/models`。
   */
  private modelListCache: { at: number; value: ModelInfo[] } | null = null;
  private readonly modelListCacheTtlMs: number;

  /**
   * 创建 Anthropic Provider。
   *
   * @param options Provider 配置
   * @throws ProviderError 缺失凭据时抛出
   */
  constructor(options: AnthropicProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "PROVIDER_MISSING_CREDENTIALS",
        "缺少 ANTHROPIC_API_KEY 或 options.apiKey",
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelListCacheTtlMs = options.modelListCacheTtlMs ?? 60_000;
    this.client = new Anthropic({
      ...(options.extra ?? {}),
      apiKey,
      baseURL: options.baseURL,
    });
  }

  /**
   * 调用 Anthropic `/v1/models` 返回**动态**模型清单（SDK 0.30+）。
   *
   * 若 SDK 调用异常（鉴权失败、网络异常、SDK 旧版本无此接口等），退化为
   * {@link FALLBACK_MODELS} 静态清单以保证上层 ModelRouter 不会因单次列表失败
   * 而整体不可用；真实错误已通过 `mapProviderError` 转成结构化错误抛给
   * 诊断链路（此处吞错并落 fallback 是出于鲁棒性考虑）。
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    const ttl = this.modelListCacheTtlMs;
    if (ttl > 0 && this.modelListCache && Date.now() - this.modelListCache.at < ttl) {
      return this.modelListCache.value;
    }
    try {
      const models = (this.client as unknown as {
        models?: {
          list: (
            params?: Record<string, unknown> | null,
            options?: { signal?: AbortSignal },
          ) => AsyncIterable<AnthropicSdkModelInfo>;
        };
      }).models;
      if (!models || typeof models.list !== "function") {
        return FALLBACK_MODELS;
      }
      const page = models.list(null, {});
      const infos: ModelInfo[] = [];
      for await (const raw of page as AsyncIterable<AnthropicSdkModelInfo>) {
        if (raw && typeof raw.id === "string") {
          infos.push(adaptSdkModelInfo(raw));
        }
      }
      const result = infos.length > 0 ? infos : FALLBACK_MODELS;
      if (ttl > 0) {
        this.modelListCache = { at: Date.now(), value: result };
      }
      return result;
    } catch {
      return FALLBACK_MODELS;
    }
  }

  /**
   * 发起非流式对话请求。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   * @returns 对话响应
   */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const extended = request as ExtendedChatRequest;
    const mapped = toAnthropicMessages(request.messages);
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens ?? 1024,
        messages: mapped.messages,
      };
      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }
      if (extended.stop) {
        body.stop_sequences = extended.stop;
      }
      if (mapped.system) {
        body.system = mapped.system;
      }
      const tools = toAnthropicTools(request.tools);
      if (tools && tools.length > 0) {
        body.tools = tools;
      }
      body.tool_choice =
        extended.toolChoice === "required"
          ? { type: "any" }
          : extended.toolChoice && typeof extended.toolChoice === "object"
            ? { type: "tool", name: extended.toolChoice.function.name }
            : { type: "auto" };
      const response = await this.client.messages.create(body as never, {
        signal: timeout.signal,
      });

      // ADR-0002：tool_use 块不再落入 content 字符串（避免污染最终答复），
      // 而是解析为结构化 `toolCalls` 字段；content 仅保留 `type === "text"` 的块拼接。
      const content = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter((part) => part.length > 0)
        .join("\n");
      const toolCalls = parseAnthropicToolCalls(response.content);
      const finishReason = mapAnthropicFinishReason(response.stop_reason);

      return {
        content,
        ...(toolCalls ? { toolCalls } : {}),
        finishReason,
        usage: {
          promptTokens:
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0),
          completionTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0) +
            response.usage.output_tokens,
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
   * @returns 流式分片
   */
  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const extended = request as ExtendedChatRequest;
    const mapped = toAnthropicMessages(request.messages);
    const timeout = withAbortTimeout(signal, this.timeoutMs);

    try {
      const stream = (await this.client.messages.create(
        (() => {
          const body: Record<string, unknown> = {
            model: request.model,
            max_tokens: request.maxTokens ?? 1024,
            messages: mapped.messages,
            stream: true,
          };
          if (request.temperature !== undefined) {
            body.temperature = request.temperature;
          }
          if (extended.stop) {
            body.stop_sequences = extended.stop;
          }
          if (mapped.system) {
            body.system = mapped.system;
          }
          const tools = toAnthropicTools(request.tools);
          if (tools && tools.length > 0) {
            body.tools = tools;
          }
          body.tool_choice =
            extended.toolChoice === "required"
              ? { type: "any" }
              : extended.toolChoice && typeof extended.toolChoice === "object"
                ? { type: "tool", name: extended.toolChoice.function.name }
                : { type: "auto" };
          return body;
        })() as never,
        {
          signal: timeout.signal,
        },
      )) as unknown as AsyncIterable<{
        type: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: {
          type?: string;
          text?: string;
          partial_json?: string;
          stop_reason?: string;
        };
      }>;

      // ADR-0002：按 block index 聚合 tool_use 分片。
      // Anthropic 在 `content_block_start` 时给出 tool_use 元信息（id/name），
      // 随后的 `content_block_delta` 携带 `input_json_delta.partial_json` 拼装参数；
      // `content_block_stop` 触发聚合发射 tool-call-complete。
      const toolBlocks = new Map<number, { id: string; name: string; argumentsText: string }>();
      let finishReason: ChatFinishReason = "unknown";

      for await (const event of stream) {
        if (timeout.signal.aborted) {
          throw timeout.signal.reason ?? new Error("aborted");
        }

        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use" && typeof event.index === "number") {
            const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `call-${event.index}`;
            const name = typeof block.name === "string" ? block.name : "";
            toolBlocks.set(event.index, { id, name, argumentsText: "" });
            yield {
              type: "tool-call-delta",
              index: event.index,
              id,
              ...(name ? { name } : {}),
            };
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            yield { type: "text-delta", delta: event.delta.text };
            continue;
          }
          if (event.delta?.type === "input_json_delta" && typeof event.index === "number") {
            const partial = event.delta.partial_json ?? "";
            const buffered = toolBlocks.get(event.index);
            if (buffered) {
              buffered.argumentsText += partial;
            }
            if (partial.length > 0) {
              yield {
                type: "tool-call-delta",
                index: event.index,
                argumentsDelta: partial,
              };
            }
          }
          continue;
        }

        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const buffered = toolBlocks.get(event.index);
          if (buffered && buffered.name.length > 0) {
            let parsedArgs: Record<string, unknown> = {};
            const argsText = buffered.argumentsText.trim();
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
                  `Anthropic stream 聚合后的工具调用 ${buffered.name} 参数不是合法 JSON`,
                  { cause: err, retryable: true },
                );
              }
            }
            yield {
              type: "tool-call-complete",
              call: { id: buffered.id, name: buffered.name, arguments: parsedArgs },
            };
            toolBlocks.delete(event.index);
          }
          continue;
        }

        if (event.type === "message_delta" && event.delta?.stop_reason) {
          finishReason = mapAnthropicFinishReason(event.delta.stop_reason);
          continue;
        }

        if (event.type === "message_stop") {
          yield { type: "finish", finishReason };
        }
      }
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * 调用官方 countTokens 接口做精确计数。
   *
   * @param messages 消息列表
   * @param model 模型名
   * @returns token 数
   */
  async countTokens(messages: Message[], model: string): Promise<number> {
    const mapped = toAnthropicMessages(messages);
    const payload: Record<string, unknown> = {
      model,
      messages: mapped.messages,
    };
    if (mapped.system) {
      payload.system = mapped.system;
    }
    const result = await this.client.messages.countTokens(payload as never);
    return result.input_tokens;
  }
}
