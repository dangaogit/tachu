import type { EngineError } from "../errors/engine-error";
import type { RankedPlan } from "./result";

/**
 * 输入元信息。
 */
export interface InputMetadata {
  modality?: string | undefined;
  /**
   * 为 true 时表示文生图请求，引擎将路由到 `capabilityMapping["text-to-image"]`。
   * 自然语言场景由 Intent LLM 在 JSON 中输出 `textToImage` 后写入；与多模态读图互斥时以读图为准。
   */
  textToImage?: boolean | undefined;
  /**
   * 用户通过 CLI `--text-to-image`、`/draw` 等**显式**进入文生图时为 true，跳过 Intent LLM 以省延迟。
   */
  explicitTextToImage?: boolean | undefined;
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
  name: string;
  durationMs: number;
  success: boolean;
  errorCode?: string | undefined;
}

/**
 * 文生图 / 图像编辑产物。
 *
 * Provider Adapter 在文生图类响应上返回结构化列表（`ChatResponse.images`），
 * 由 `direct-answer` Sub-flow 透传到引擎主干，最终出现在
 * {@link OutputMetadata.generatedImages}。CLI / 宿主据此可：
 *   1. 下载 URL 并持久化到本地（`tachu run --save-image <path>`、`/draw ... --save <path>`）
 *   2. 渲染图片缩略图 / 结构化卡片
 *   3. 做审计、指标、费用归因
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
 * 输出元信息。
 */
export interface OutputMetadata {
  toolCalls: ToolCallRecord[];
  durationMs: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  /**
   * 文生图 / 图像编辑响应的结构化图片列表（可选）。
   *
   * 仅当本轮实际产生了图片时存在；纯文本轮次 / 工具调用轮次此字段保持 undefined
   * 或空数组。CLI 在渲染完毕后据此下载落盘（见 `packages/cli/src/commands/run.ts`
   * 的 `--save-image`）。
   */
  generatedImages?: GeneratedImage[] | undefined;
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
  status: "success" | "partial" | "failed";
  steps: StepStatus[];
  metadata: OutputMetadata;
  artifacts?: Artifact[] | undefined;
  traceId: string;
  deliveryMode: "complete" | "streaming";
}

/**
 * Agentic 工具循环事件负载（ADR-0002）。
 *
 * 由内置 `tool-use` Sub-flow 发送：
 *   - `tool-loop-step`：每一轮 LLM 思考开始前，携带当前步号与最大步数，便于 UI 进度条
 *   - `tool-call-start`：一个工具实际被调用前，携带工具名、调用 id 与参数预览
 *   - `tool-call-end`：一个工具调用完成后，携带成功与否、耗时、错误信息（若失败）
 *   - `tool-loop-final`：工具循环结束（不论成功失败），携带最终回复（success 时）或 null（failure 时）
 */
export interface ToolLoopStepChunk {
  type: "tool-loop-step";
  step: number;
  maxSteps: number;
}

export interface ToolCallStartChunk {
  type: "tool-call-start";
  callId: string;
  tool: string;
  argumentsPreview: string;
}

export interface ToolCallEndChunk {
  type: "tool-call-end";
  callId: string;
  tool: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  /**
   * 失败原因的稳定标识码（ADR-0002 Stage 4）。例如：
   *   - `TOOL_LOOP_APPROVAL_DENIED`：审批被拒绝
   *   - `TOOL_LOOP_UNKNOWN_TOOL`：LLM 请求了未注册的工具
   *   - `TOOL_LOOP_TOOL_EXECUTION_FAILED`：真实执行器抛错
   *
   * 成功时固定为 `undefined`。UI 层可据此决定渲染分支（如将"已拒绝"标题与
   * "执行失败"标题分开）。
   */
  errorCode?: string;
}

export interface ToolLoopFinalChunk {
  type: "tool-loop-final";
  steps: number;
  success: boolean;
}

/**
 * 本轮执行中 orchestrator 的累计用量快照（用于 CLI 底部栏等实时展示）。
 * 在 streaming 模式下随 Provider usage 回流或阶段推进多次发出。
 */
export interface UsageChunk {
  type: "usage";
  tokens: number;
  toolCalls: number;
  wallTimeMs: number;
}

/**
 * 流式输出块。
 *
 * 自 ADR-0002 起新增 `tool-loop-step` / `tool-call-start` / `tool-call-end` /
 * `tool-loop-final` 四类事件。CLI / SDK 侧消费方应以 `chunk.type` 做穷举分派，
 * 未识别事件按 no-op 处理以便向前兼容。
 */
export type StreamChunk =
  | { type: "progress"; phase: string; message: string }
  | { type: "delta"; content: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "error"; error: EngineError }
  | { type: "plan-preview"; phase: "planning"; plan: RankedPlan }
  | ToolLoopStepChunk
  | ToolCallStartChunk
  | ToolCallEndChunk
  | ToolLoopFinalChunk
  | UsageChunk
  | { type: "done"; output: EngineOutput };

