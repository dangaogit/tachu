import { ProviderError } from "../errors";
import type { AdapterCallContext } from "../types/context";
import type {
  GeneratedImage,
  GeneratedMedia,
  Message,
  MessageContentPart,
  ProviderMetadata,
  ToolCallRequest,
  ToolDefinition,
} from "../types";

/**
 * 模型能力标签。
 */
export type ModelCapabilityTags =
  | "high-reasoning"
  | "fast-cheap"
  | "vision"
  | "long-context"
  | string;

/**
 * 模型能力描述。
 */
export interface ModelCapabilities {
  supportedModalities: string[];
  supportedOutputModalities?: string[] | undefined;
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsStructuredOutput?: boolean | undefined;
  supportsEmbeddings?: boolean | undefined;
  supportsRerank?: boolean | undefined;
}

/**
 * 模型信息。
 */
export interface ModelInfo {
  modelName: string;
  capabilities: ModelCapabilities;
}

/**
 * Chat 请求。
 */
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  structuredOutput?: StructuredOutputConfig | undefined;
  responseModalities?: ResponseModality[] | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

export type ResponseModality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO";

export interface StructuredOutputConfig {
  schema: Record<string, unknown>;
  name?: string | undefined;
  description?: string | undefined;
  mimeType?: "application/json" | "text/x.enum" | string | undefined;
  strict?: boolean | undefined;
}

/**
 * Chat 返回的 usage 统计。
 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt caching 命中的 token 数（OpenAI `prompt_tokens_details.cached_tokens`
   * / Anthropic `usage.cache_read_input_tokens`）。
   *
   * - OpenAI 把 cached 部分**包含在 `promptTokens` 内**，按半价计费
   * - Anthropic 把 `cache_read` 单独统计，**不重复计入 `input_tokens`**；
   *   本 adapter 仍按原行为把它合并进 `promptTokens` 用于预算/估算，
   *   同时把 cache_read 量单独通过本字段上报便于折扣展示
   *
   * 该字段仅用于 CLI / 账单展示与可观测性；预算 (`assertBudget`) 仍按
   * `promptTokens + completionTokens` 全额校验，避免低估。
   */
  cachedPromptTokens?: number;
}

/**
 * Chat 调用的终止原因（ADR-0002）。
 *
 * - `stop`：LLM 正常结束（给出文本回复，无工具调用）
 * - `tool_calls`：LLM 请求调用工具，Agentic Loop 需执行工具后继续
 * - `length`：达到 `maxTokens` 上限被截断
 * - `content_filter`：被 Provider 内容审核截断
 * - `error`：上游异常但 stream 已部分产出；非流式调用通常直接抛错
 * - `unknown`：Provider 返回的终止原因无法归类到以上任一
 */
export type ChatFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "unknown";

/**
 * Chat 返回结果（ADR-0002 扩展）。
 *
 * 向后兼容：`toolCalls` / `finishReason` 为可选字段；未参与 Agentic Loop 的调用方
 * （如 `direct-answer` Sub-flow、Intent 阶段、Memory 压缩、Vision Transformer）
 * 只需关心 `content` + `usage` 即可，与本 ADR 之前的行为完全一致。
 */
export interface ChatResponse {
  content: string;
  structured?: unknown | undefined;
  providerMetadata?: ProviderMetadata | undefined;
  /**
   * 模型自身的推理过程整体（非流式 `chat()` 路径专用）。
   *
   * 触发条件：仅对支持原生 reasoning 输出的模型（DeepSeek-R1 /
   * OpenAI o-series / 豆包 thinking variant / Anthropic extended thinking
   * 等）由 Provider Adapter 填充；普通模型保持 `undefined`。
   *
   * 与 `content` 的关系：本字段承载"模型在生成 `content` 之前的思考过程"，
   * 上游 sub-flow 可一次性以 `ReasoningDeltaChunk` 形式 yield 给 SSE 通道；
   * **禁止**被回灌为下一轮 LLM 上下文（会导致 token 爆炸 + 分布漂移）。
   */
  reasoningContent?: string | undefined;
  /**
   * LLM 请求的工具调用列表；为空数组或 undefined 表示本轮未请求调工具。
   *
   * Provider Adapter 必须在构造此字段时把原生 `arguments` JSON 字符串解析为对象；
   * 解析失败时抛 `ProviderError("PROVIDER_TOOL_ARGUMENTS_INVALID")`，
   * 由 Agentic Loop 决定是否给 LLM 重试或转成 `tool_result` 错误回灌。
   */
  toolCalls?: ToolCallRequest[] | undefined;
  /**
   * 终止原因；若 Provider 响应未标注或无法识别，填 `"unknown"` 以消除歧义。
   */
  finishReason?: ChatFinishReason | undefined;
  usage: ChatUsage;
  /**
   * 文生图 / 图像编辑响应里结构化的图片产物（可选）。
   *
   * 触发条件：仅文生图类 Provider（如 DashScope 万相 `wanx-*` / `wan2.x-image*` /
   * `qwen-image-*`）在成功返回图片时填充；普通 chat 轮次保持 `undefined`。
   *
   * 字段与 `content` 的 Markdown `![](url)` 文本**互补**：content 面向用户渲染，
   * `images` 面向宿主机器消费。上游 `direct-answer` Sub-flow 会把本字段透传到
   * {@link import("../types").OutputMetadata.generatedImages}，CLI / SDK 据此
   * 完成下载落盘、卡片渲染、审计等操作。
   */
  images?: GeneratedImage[] | undefined;
  media?: GeneratedMedia[] | undefined;
}

/**
 * Chat 流式分片（ADR-0002：tagged union）。
 *
 * 旧版 `{ delta: string; done?: boolean }` 形态已移除。
 * 迁移规则：
 *  - 旧 `{ delta: "abc" }` → `{ type: "text-delta", delta: "abc" }`
 *  - 旧 `{ delta: "", done: true }` → `{ type: "finish", finishReason: "stop" }`
 *
 * 新增事件：
 *  - `tool-call-delta`：Provider 流式投递 tool_call 分片（OpenAI 按 `index` 聚合、
 *    Anthropic 投递 `input_json_delta` 片段），消费者负责按 `index` 缓存拼接
 *  - `tool-call-complete`：单次完整的 `ToolCallRequest`；OpenAI 在 `finish_reason`
 *    到达前聚合完毕、Anthropic 在 `content_block_stop` 时发射。
 *    Agentic Loop 只消费此事件即可，无需自己处理增量分片。
 */
export type ChatStreamChunk =
  | { type: "text-delta"; delta: string }
  /**
   * 模型 reasoning_content 流式增量（OpenAI 兼容 `delta.reasoning_content` /
   * Anthropic `thinking_delta` 等）。仅支持原生推理流的模型会下发。
   * Provider Adapter 仅负责把上游字段映射到本 chunk 类型，
   * 由 sub-flow 决定是否透传成顶层 `StreamChunk.reasoning-delta`。
   */
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      argumentsDelta?: string | undefined;
      providerMetadata?: ProviderMetadata | undefined;
    }
  | { type: "tool-call-complete"; call: ToolCallRequest }
  | { type: "structured-delta"; delta: string }
  | { type: "media"; media: GeneratedMedia }
  | {
      type: "finish";
      finishReason: ChatFinishReason;
      usage?: ChatUsage | undefined;
      providerMetadata?: ProviderMetadata | undefined;
    };

export type EmbeddingContent = string | MessageContentPart[];

export interface EmbeddingRequest {
  model: string;
  inputs: EmbeddingContent[];
  taskType?:
    | "RETRIEVAL_QUERY"
    | "RETRIEVAL_DOCUMENT"
    | "SEMANTIC_SIMILARITY"
    | "CLASSIFICATION"
    | "CLUSTERING"
    | string
    | undefined;
  outputDimensionality?: number | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  usage?: ChatUsage | undefined;
  providerMetadata?: ProviderMetadata | undefined;
}

export interface RerankDocument {
  id?: string | undefined;
  text: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: RerankDocument[];
  topK?: number | undefined;
  providerOptions?: Record<string, unknown> | undefined;
}

export interface RerankResult {
  index: number;
  score: number;
  document: RerankDocument;
}

export interface RerankResponse {
  results: RerankResult[];
  usage?: ChatUsage | undefined;
  providerMetadata?: ProviderMetadata | undefined;
}

/**
 * Provider 适配器协议。
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  /**
   * 列出当前 Provider 可用模型。
   */
  listAvailableModels(): Promise<ModelInfo[]>;
  /**
   * 非流式对话调用。
   *
   * @param request 对话请求
   * @param ctx 租户 / 会话 / 链路上下文
   * @param signal 可选取消信号
   */
  chat(
    request: ChatRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
  /**
   * 流式对话调用。
   *
   * @param request 对话请求
   * @param ctx 租户 / 会话 / 链路上下文
   * @param signal 可选取消信号
   */
  chatStream(
    request: ChatRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk>;
  /**
   * 可选 token 计数能力。
   *
   * @param messages 待计数消息
   * @param model 目标模型
   */
  countTokens?(messages: Message[], model: string): Promise<number>;
  embed?(
    request: EmbeddingRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<EmbeddingResponse>;
  rerank?(
    request: RerankRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<RerankResponse>;
  /**
   * 可选资源释放回调。
   */
  dispose?(): Promise<void>;
}

const DEFAULT_MODELS: ModelInfo[] = [
  {
    modelName: "dev-small",
    capabilities: {
      supportedModalities: ["text"],
      maxContextTokens: 8_192,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
  {
    modelName: "dev-medium",
    capabilities: {
      supportedModalities: ["text"],
      maxContextTokens: 16_384,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
  {
    modelName: "dev-large",
    capabilities: {
      supportedModalities: ["text", "image"],
      maxContextTokens: 64_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
  },
];

/**
 * 用于本地开发与测试的 Noop Provider。
 */
export class NoopProvider implements ProviderAdapter {
  readonly id = "noop";
  readonly name = "NoopProvider";

  async listAvailableModels(): Promise<ModelInfo[]> {
    return DEFAULT_MODELS;
  }

  async chat(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    if (signal?.aborted) {
      throw ProviderError.callFailed(this.name, signal.reason);
    }
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const content = `[noop]${lastUserMessage ?? ""}`;
    return {
      content,
      finishReason: "stop",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    };
  }

  async *chatStream(
    request: ChatRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const response = await this.chat(request, ctx, signal);
    for (const char of response.content) {
      if (signal?.aborted) {
        throw ProviderError.callFailed(this.name, signal.reason);
      }
      yield { type: "text-delta", delta: char };
    }
    yield { type: "finish", finishReason: "stop", usage: response.usage };
  }

  async countTokens(messages: Message[], _model?: string): Promise<number> {
    return messages.reduce((sum, message) => {
      if (typeof message.content === "string") {
        return sum + message.content.length;
      }
      return (
        sum +
        message.content.reduce(
          (inner, part) => inner + (part.type === "text" ? part.text.length : 0),
          0,
        )
      );
    }, 0);
  }
}
