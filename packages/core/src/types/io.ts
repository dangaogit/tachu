import type { EngineError } from "../errors/engine-error";
import type { ExecutionCorrelation, ExecutionSubject } from "./context";
import type { RankedPlan } from "./result";
import type { TurnPolicy } from "./turn-policy";

/**
 * 输入元信息。
 */
export interface InputMetadata {
  modality?: string | undefined;
 /**
 * 本轮能力进退清单（ 阶段归一化后始终存在稳定形状。
 */
  turnPolicy?: TurnPolicy | undefined;
  size?: number | undefined;
  source?: string | undefined;
  mimeType?: string | undefined;
  references?: Array<{
    raw: string;
    type: string;
    resolved?: unknown | undefined;
  }> | undefined;
}

/**
 * 输入信封。
 */
export interface InputEnvelope {
  content: unknown;
  metadata: InputMetadata;
 /**
 * 本轮输入的旁路 Resource Pool。
 *
 * 当 host 直接提交带图/文件 part 的 `content` 时，core 在 session 阶段抽离 part →
 * 此池，并在 `content` 文本末尾追加占位 token。host 亦可直接提供已抽离的池。
 */
  resources?: import("./resource").ResourceReference[] | undefined;
}

/**
 * 附件产物。
 */
export interface Artifact {
  name: string;
  type: string;
  content: unknown;
}

/**
 * 步骤状态。
 */
export interface StepStatus {
  name: string;
  status: "completed" | "failed" | "skipped";
  reason?: string | undefined;
}

/**
 * Tool 调用记录。
 */
export interface ToolCallRecord {
  callId: string;
  tool: string;
  parentStepId?: string | undefined;
  durationMs: number;
  success: boolean;
  source: "tool";
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | undefined;
}

/**
 * 文生图 / 图像编辑产物。
 *
 * Provider Adapter 在文生图类响应上返回结构化列表（`ChatResponse.images`），
 * 由 `direct-answer` Sub-flow 透传到引擎主干，最终出现在
 * {@link OutputMetadata.generatedImages}。CLI / 宿主据此可：
 * 1. 下载 URL 并持久化到本地（`tachu run --save-image <path>`、`/draw ... --save <path>`）
 * 2. 渲染图片缩略图 / 结构化卡片
 * 3. 做审计、指标、费用归因
 *
 * 与 `ChatResponse.content` 的 Markdown `![](url)` 文本是**互补**而非替代关系：
 * content 负责"面向用户的渲染文本"，`images` 负责"面向宿主的机器可读结构"。
 */
export interface GeneratedImage {
 /** 图片 URL（通常为 Provider 回传的 HTTP 链接；可能为 `data:` URL） */
  url: string;
 /** 本次响应内的顺序号，0-based。用于多图组合场景稳定排序与文件命名 */
  index: number;
 /** 若可推断；DashScope wan2.x 默认输出 `image/png` */
  mimeType?: string | undefined;
 /** 像素尺寸字符串，形如 `"2048*2048"`；Provider 已知则透传 */
  size?: string | undefined;
 /** 若 Provider 在响应中给出了体积（字节），原样透传 */
  sizeBytes?: number | undefined;
 /** Provider 原始字段（request_id / task_id / seed 等），排查用 */
  providerMetadata?: Record<string, unknown> | undefined;
}

/**
 * 通用多模态输出产物。
 *
 * `GeneratedImage` 保持兼容既有文生图链路；新 Provider 可同时填充 `media`，
 * 用于图片之外的音频、视频、文件，或 Gemini 这类 text/image interleaved 输出。
 */
export interface GeneratedMedia {
  type: "image" | "audio" | "video" | "file";
  index: number;
  mimeType: string;
  url?: string | undefined;
  data?: string | undefined;
  name?: string | undefined;
  sizeBytes?: number | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}

/**
 * 输出元信息。
 */
export type TurnOutcome = "completed" | "degraded" | "failed";

export type TurnErrorSource =
  | "tool"
  | "tool-loop"
  | "model"
  | "provider"
  | "scheduler"
  | "validation"
  | "output"
  | "engine";

export interface TurnError {
  code: string;
  message: string;
  source: TurnErrorSource;
  toolName?: string | undefined;
  callId?: string | undefined;
  retryable?: boolean | undefined;
}

export interface OutputMetadata {
  outcome: TurnOutcome;
  errors?: TurnError[] | undefined;
  incompleteSteps?: number | undefined;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
 /**
 * Prompt caching 命中累计量（OpenAI `prompt_tokens_details.cached_tokens`
 * / Anthropic `cache_read_input_tokens`）。仅用于 CLI / 账单展示与可观测性，
 * 不影响 `total` 与预算校验：
 *
 * - OpenAI 的 cached 部分**已经计入 `input`**，按半价计费，CLI 据此做折扣展示
 * - Anthropic 的 cache_read 在 adapter 层已合并进 `input`，cached 字段单独
 * 上报命中量
 *
 * 该字段为可选：未命中或 Provider 未返回时缺省（即视为 0）。
 */
    cached?: number;
  };
 /**
 * 文生图 / 图像编辑响应的结构化图片列表（可选）。
 *
 * 仅当本轮实际产生了图片时存在；纯文本轮次 / 工具调用轮次此字段保持 undefined
 * 或空数组。CLI 在渲染完毕后据此下载落盘（见 `packages/cli/src/commands/run.ts`
 * 的 `--save-image`）。
 */
  generatedImages?: GeneratedImage[] | undefined;
  generatedMedia?: GeneratedMedia[] | undefined;
}

/**
 * 输出类型。
 */
export type OutputType =
  | "text"
  | "image"
  | "file"
  | "structured"
  | "composite"
  | "custom";

/**
 * 引擎标准输出。
 */
export interface EngineOutput {
  type: OutputType;
  content: unknown;
  steps: StepStatus[];
  metadata: OutputMetadata;
  artifacts?: Artifact[] | undefined;
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
  deliveryMode: "complete" | "streaming";
}

export interface StreamEnvelope {
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
}

/**
 * Agentic 工具循环事件负载（
 *
 * 由内置 `tool-use` Sub-flow 发送：
 * - `tool-loop-step`：每一轮 LLM 思考开始前，携带当前步号与最大步数，便于 UI 进度条
 * - `tool-call-start`：一个工具实际被调用前，携带工具名、调用 id 与参数预览
 * - `tool-call-end`：一个工具调用完成后，携带成功与否、耗时、错误信息（若失败）
 * - `tool-loop-final`：工具循环结束（不论成功失败），携带最终回复（success 时）或 null（failure 时）
 */
export interface ToolLoopStepChunk {
  type: "tool-loop-step";
  step: number;
  maxSteps: number;
  stepId?: string | undefined;
  parentStepId?: string | undefined;
  selectedTools?: string[] | undefined;
  argumentsPreview?: string | undefined;
  retryCount?: number | undefined;
}

export interface ToolLoopDeltaChunk {
  type: "tool-loop-delta";
  step: number;
  content: string;
  stepId?: string | undefined;
}

export interface ToolLoopStepEndChunk {
  type: "tool-loop-step-end";
  step: number;
  success: boolean;
  stepId?: string | undefined;
  parentStepId?: string | undefined;
  reason?: string | undefined;
  stopReason?: string | undefined;
  failureReason?: string | undefined;
  selectedTools?: string[] | undefined;
  argumentsPreview?: string | undefined;
  retryCount?: number | undefined;
 /** sub-agent 调度的 history-scope 隔离键，主调度时缺省。 */
  agentRunId?: string | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | undefined;
}

export interface ToolCallStartChunk {
  type: "tool-call-start";
  callId: string;
  tool: string;
  argumentsPreview: string;
  parentStepId?: string | undefined;
}

export interface ToolCallEndChunk {
  type: "tool-call-end";
  callId: string;
  tool: string;
  success: boolean;
  durationMs: number;
  parentStepId?: string | undefined;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | undefined;
}

export interface ToolLoopFinalChunk {
  type: "tool-loop-final";
  steps: number;
  success: boolean;
  stepId?: string | undefined;
}

export interface ToolUseResultToolCall {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  outputPreview?: string | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | undefined;
}

export interface ToolUseResultStep {
  step: number;
  modelNotes: string;
  toolCalls: ToolUseResultToolCall[];
}

export interface ToolUseObservation {
  source: "tool";
  tool: string;
  callId: string;
  text: string;
  rawRef?: string | undefined;
}

export interface ToolUseResult {
  kind: "tool-use-result";
  status: "ready_for_output" | "partial" | "failed" | "exhausted";
  steps: ToolUseResultStep[];
  observations: ToolUseObservation[];
  terminalDraft?: string | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | undefined;
}

/**
 * 本轮执行中 orchestrator 的累计用量快照（用于 CLI 底部栏等实时展示）。
 * 在 streaming 模式下随 Provider usage 回流或阶段推进多次发出。
 */
export interface TokenUsageTriplet {
  input: number;
  output: number;
  total: number;
}

export type UsageAccuracy = "estimated" | "final";

export type UsageTerminalState = "cancelled" | "failed" | "disconnected";

export interface UsageAttribution {
  id: string;
  kind: string;
  parentId?: string | undefined;
  label?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface UsageChunk {
  type: "usage";
 /** Legacy aggregate fields kept for existing CLI consumers. */
  tokens: number;
  toolCalls: number;
  wallTimeMs: number;
  usage?: TokenUsageTriplet | undefined;
  cumulative?: TokenUsageTriplet | undefined;
  attribution?: UsageAttribution | undefined;
  accuracy?: UsageAccuracy | undefined;
  terminal?: UsageTerminalState | undefined;
}

/**
 * 引擎 9 阶段（session / safety / intent / precheck / planning / graph-check /
 * execution / validation / output）枚举。
 *
 * 用于 `phase-enter` / `phase-exit` 顶层 StreamChunk 的结构化标签，替代
 * `progress` chunk 上靠 `message` 后缀（`"${phase} started"`）判 START/END
 * 的脆弱约定，便于下游消费方做穷举式 switch。
 */
export type EnginePhase =
  | "session"
  | "safety"
  | "intent"
  | "precheck"
  | "planning"
  | "graph-check"
  | "execution"
  | "validation"
  | "output";

/**
 * 阶段进入事件：tachu engine 在每个 9 阶段开始时 yield 一次。
 *
 * 与现有 `progress` chunk 的关系：
 * - `progress` 保留：现有 CLI / 旧消费方按 message 文案展示
 * - `phase-enter`：新结构化通道，供 SSE mapper / SDK 等通过 `chunk.type`
 * 做穷举式 switch，避免依赖文案后缀
 */
export interface PhaseEnterChunk {
  type: "phase-enter";
  phase: EnginePhase;
  stepId?: string | undefined;
}

/**
 * 阶段退出事件：tachu engine 在每个 9 阶段结束时 yield 一次。
 *
 * `ok=false` 仅在阶段函数抛错时由 `runStream` 的 catch 分支补发；正常完成时
 * `ok=true`。
 */
export interface PhaseExitChunk {
  type: "phase-exit";
  phase: EnginePhase;
  stepId?: string | undefined;
  ok: boolean;
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * 模型 reasoning_content 流式增量事件（DeepSeek-R1 / OpenAI o-series /
 * 豆包 thinking variant / Anthropic extended thinking 等支持原生推理流的模型）。
 *
 * 与 `delta` chunk 的关系：
 * - `delta`：面向用户的最终答复文本，会被持久化、回灌为下一轮上下文
 * - `reasoning-delta`：模型自身的推理过程片段，**禁止**回灌为后续上下文
 * （会导致 token 爆炸 + 模型分布漂移；DeepSeek 官方明确禁止）
 *
 * Provider Adapter 负责把上游 `delta.reasoning_content`（OpenAI 兼容）/
 * `thinking_delta`（Anthropic）映射到 `ChatStreamChunk.reasoning-delta`，
 * 由 sub-flow 透传成本顶层 StreamChunk。非流式 `chat()` 路径下，
 * `ChatResponse.reasoningContent` 的整体内容由 sub-flow 一次性 yield 一条本
 * chunk。
 */
export interface ReasoningDeltaChunk {
  type: "reasoning-delta";
  content: string;
  stepId?: string | undefined;
  parentStepId?: string | undefined;
}

/**
 * 流式输出块。
 *
 * 自 起新增 `tool-loop-step` / `tool-call-start` / `tool-call-end` /
 * `tool-loop-final` 四类事件。CLI / SDK 侧消费方应以 `chunk.type` 做穷举分派，
 * 未识别事件按 no-op 处理以便向前兼容。
 */
export type StreamChunkPayload =
  | { type: "progress"; phase: string; message: string }
  | { type: "delta"; content: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "error"; error: EngineError }
  | { type: "plan-preview"; phase: "planning"; plan: RankedPlan }
  | PhaseEnterChunk
  | PhaseExitChunk
  | ReasoningDeltaChunk
  | ToolLoopStepChunk
  | ToolLoopDeltaChunk
  | ToolLoopStepEndChunk
  | ToolCallStartChunk
  | ToolCallEndChunk
  | ToolLoopFinalChunk
  | UsageChunk
  | { type: "done"; output: EngineOutput };

export type StreamChunk = StreamChunkPayload & StreamEnvelope;
