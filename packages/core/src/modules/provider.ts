import { ProviderError } from "../errors";
import type { GeneratedImage, Message, ToolCallRequest, ToolDefinition } from "../types";

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
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
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
}

/**
 * Chat 返回的 usage 统计。
 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
  | {
      type: "tool-call-delta";
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      argumentsDelta?: string | undefined;
    }
  | { type: "tool-call-complete"; call: ToolCallRequest }
  | {
      type: "finish";
      finishReason: ChatFinishReason;
      usage?: ChatUsage | undefined;
    };

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
   * @param signal 可选取消信号
   */
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /**
   * 流式对话调用。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   */
  chatStream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamChunk>;
  /**
   * 可选 token 计数能力。
   *
   * @param messages 待计数消息
   * @param model 目标模型
   */
  countTokens?(messages: Message[], model: string): Promise<number>;
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

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
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
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const response = await this.chat(request, signal);
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

