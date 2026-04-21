/**
 * 纯文本消息内容部件。
 */
export interface MessageTextPart {
  type: "text";
  text: string;
}

/**
 * 图像内容部件；URL 与 base64 任选其一，至少提供其一。
 *
 * Provider Adapter 在序列化时按官方协议映射（OpenAI: `image_url.url`，
 * Anthropic: `image` block）。
 */
export interface MessageImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

/**
 * 多模态消息部件联合类型。
 */
export type MessageContentPart = MessageTextPart | MessageImagePart;

/**
 * 多 Provider 共通消息结构。
 *
 * `content` 支持两种形态：
 * - `string`：单段文本（与 v0.1 形态保持二进制兼容）
 * - `MessageContentPart[]`：多模态部件数组，在需要混排文本 + 图像等内容时使用
 *   （例如 `ImageToTextTransformer` 把图像块直接提交给 Vision 模型）
 *
 * Provider Adapter 需按类型分派：string → 原样传给官方 SDK；parts → 按各自协议
 * 做内容块转换。
 *
 * ## tool-use 相关字段（ADR-0002）
 *
 * - `toolCalls`：assistant 消息在 Agentic Loop 中请求工具调用时携带。Provider
 *   Adapter 的 `mapMessage` 会据此在 OpenAI 格式下产出 `message.tool_calls`，在
 *   Anthropic 格式下产出 `content: [{type:"tool_use", ...}]` 块。
 * - `toolCallId` + `role: "tool"`：回灌工具执行结果时使用，`toolCallId` 必须与
 *   上一轮 assistant 消息中对应 `ToolCallRequest.id` 相同。
 */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContentPart[];
  name?: string | undefined;
  toolCallId?: string | undefined;
  /**
   * assistant 角色消息中附带的工具调用请求（ADR-0002）。
   *
   * 当 `role === "assistant"` 且本轮 LLM 决定调工具时，此字段承载**结构化**
   * `ToolCallRequest[]`，由 Agentic Loop 回灌历史、下一轮 chat 请求时需保留。
   * 非 assistant 或无工具调用时应为 `undefined` 或省略。
   */
  toolCalls?: ToolCallRequest[] | undefined;
}

/**
 * 函数调用定义（提供给 LLM 作为可选工具）。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * LLM 返回的单次工具调用请求（ADR-0002）。
 *
 * 语义：LLM 在本轮推理后决定调用工具 `name`、传入 `arguments`。Provider Adapter
 * 负责：
 *  1. 从原生响应（OpenAI `choices[].message.tool_calls[]` / Anthropic 的
 *     `content[].type === "tool_use"` 块）构造此结构；
 *  2. 将 `arguments` JSON 字符串 **解析为对象**（解析失败抛
 *     `ProviderError("PROVIDER_TOOL_ARGUMENTS_INVALID")`，由 Agentic Loop 决定
 *     是否给 LLM 一次重试机会）；
 *  3. 在下一轮把 assistant 消息（含此 toolCalls）与对应的 `role: "tool"` 消息
 *     透明序列化回原生协议。
 *
 * `id` 对应各 Provider 的 call id（OpenAI `tool_call_id` / Anthropic `tool_use.id`），
 * 用于在回灌 `role: "tool"` 消息时精确匹配。
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

