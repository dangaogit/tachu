import type {
  AdapterCallContext,
  ChatFinishReason,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatUsage,
  Message,
  ModelInfo,
  ProviderAdapter,
  ToolCallRequest,
} from "@tachu/core";

const MOCK_MODEL = "mock-chat";

/**
 * 单次脚本化回复的规格（ADR-0002）。
 *
 * Agentic Loop 测试常常需要模拟"多步 tool-use → 最终文本"的完整链路，
 * 允许测试预先写好一组回复脚本，`MockProviderAdapter` 按序挑选返回。
 *
 * - `content`：assistant 文本回复；可为空字符串（当本步仅请求工具调用时）
 * - `toolCalls`：LLM 本步请求的工具调用；设置后 `finishReason` 默认 `tool_calls`
 * - `finishReason`：显式覆盖，用于测试 `length` / `content_filter` 等分支
 * - `usage`：覆盖本步的 token usage；未设置则使用启发式估算
 */
export interface MockScriptedReply {
  content?: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: ChatFinishReason;
  usage?: ChatUsage;
}

export interface MockProviderOptions {
  /**
   * 可选脚本序列：按调用顺序依次消耗。
   *
   * - 用尽后，后续调用自动回落到默认行为（`mock:<lastUserText>`，`finishReason: "stop"`）
   * - 不提供或传入空数组时完全等价于未打开脚本化，适合大部分既有单元测试
   */
  replies?: MockScriptedReply[];
  /**
   * 流式调用时每个 token/字符之间的延迟（ms）。默认 0 表示尽快产出
   * （设置非零值可用于压测/取消传播相关的测试）。
   */
  streamDelayMs?: number;
}

const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * 用于单元测试与开发调试的可预测 Provider。
 *
 * 两种模式：
 *  1. **默认模式**（无 `replies`）：复制最后一条 user 输入，前缀 `"mock:"` 返回，流式
 *     按字符切片。历史行为，与 ADR-0002 前的所有测试兼容。
 *  2. **脚本化模式**（传入 `replies`）：按顺序吐出脚本化的 assistant 回复，支持
 *     `toolCalls`、自定义 `finishReason`，用于 Agentic Loop 的循环行为测试
 *     （如"第 1 步请求 read-file、第 2 步请求 fetch-url、第 3 步给最终文本"）。
 */
export class MockProviderAdapter implements ProviderAdapter {
  readonly id = "mock";
  readonly name = "Mock";

  private readonly scriptedReplies: MockScriptedReply[];
  private readonly streamDelayMs: number;
  private replyIndex = 0;

  constructor(options: MockProviderOptions = {}) {
    this.scriptedReplies = options.replies ? [...options.replies] : [];
    this.streamDelayMs = options.streamDelayMs ?? 0;
  }

  /**
   * 返回 mock 模型列表。
   */
  async listAvailableModels(): Promise<ModelInfo[]> {
    return [
      {
        modelName: MOCK_MODEL,
        capabilities: {
          supportedModalities: ["text"],
          maxContextTokens: 8192,
          supportsStreaming: true,
          supportsFunctionCalling: true,
        },
      },
    ];
  }

  /**
   * 生成可预测回复。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   * @returns 对话响应
   */
  async chat(request: ChatRequest, _ctx: AdapterCallContext, signal?: AbortSignal): Promise<ChatResponse> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    const scripted = this.consumeScriptedReply();
    if (scripted) {
      return this.buildResponseFromScript(scripted);
    }
    return this.buildDefaultResponse(request);
  }

  /**
   * 以字符级别流式返回 mock 回复。
   *
   * @param request 对话请求
   * @param signal 可选取消信号
   * @returns 流式分片
   */
  async *chatStream(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    const scripted = this.consumeScriptedReply();
    const response = scripted
      ? this.buildResponseFromScript(scripted)
      : this.buildDefaultResponse(request);

    for (const char of response.content) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      if (this.streamDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.streamDelayMs));
      }
      yield { type: "text-delta", delta: char };
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (let index = 0; index < response.toolCalls.length; index += 1) {
        const call = response.toolCalls[index]!;
        yield {
          type: "tool-call-delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
        };
        yield { type: "tool-call-complete", call };
      }
    }
    yield {
      type: "finish",
      finishReason: response.finishReason ?? "stop",
      usage: response.usage,
    };
  }

  /**
   * 对消息内容做近似 token 计数。
   *
   * @param messages 消息列表
   * @returns token 数
   */
  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((sum, message) => {
      if (typeof message.content === "string") {
        return sum + approxTokens(message.content);
      }
      return (
        sum +
        message.content.reduce(
          (inner, part) => inner + (part.type === "text" ? approxTokens(part.text) : 0),
          0,
        )
      );
    }, 0);
  }

  private consumeScriptedReply(): MockScriptedReply | undefined {
    if (this.replyIndex >= this.scriptedReplies.length) {
      return undefined;
    }
    const reply = this.scriptedReplies[this.replyIndex];
    this.replyIndex += 1;
    return reply;
  }

  private buildResponseFromScript(script: MockScriptedReply): ChatResponse {
    const content = script.content ?? "";
    const toolCalls = script.toolCalls && script.toolCalls.length > 0 ? script.toolCalls : undefined;
    const finishReason: ChatFinishReason =
      script.finishReason ?? (toolCalls ? "tool_calls" : "stop");
    const usage: ChatUsage =
      script.usage ?? {
        promptTokens: approxTokens(content),
        completionTokens: approxTokens(content),
        totalTokens: approxTokens(content) * 2,
      };
    return {
      content,
      ...(toolCalls ? { toolCalls } : {}),
      finishReason,
      usage,
    };
  }

  private buildDefaultResponse(request: ChatRequest): ChatResponse {
    const lastUser = [...request.messages].reverse().find((item) => item.role === "user");
    const lastUserText =
      lastUser === undefined
        ? ""
        : typeof lastUser.content === "string"
          ? lastUser.content
          : lastUser.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
    const prompt = lastUserText.trim();
    const content = `mock:${prompt}`;
    return {
      content,
      finishReason: "stop",
      usage: {
        promptTokens: approxTokens(prompt),
        completionTokens: approxTokens(content),
        totalTokens: approxTokens(prompt) + approxTokens(content),
      },
    };
  }
}
