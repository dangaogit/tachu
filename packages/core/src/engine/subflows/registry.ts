import type {
  EngineConfig,
  ExecutionContext,
  GeneratedImage,
  GeneratedMedia,
  StreamChunk,
  ToolCallRecord,
} from "../../types";
import type { TurnPolicy } from "../../types/turn-policy";
import type { AdapterCallContext } from "../../types/context";
import type { MultimodalResolver } from "../../types/multimodal-resolver";
import type { MemorySystem } from "../../modules/memory";
import type { ModelRouter } from "../../modules/model-router";
import type { ProviderAdapter, ChatUsage } from "../../modules/provider";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { AssembledPrompt } from "../../prompt/assembler";
import type { SessionManager } from "../../modules/session";
import type { Registry } from "../../registry";
import type { StickyManager } from "../skill-activation/sticky";
import type { EmitLlmUsageTelemetry } from "../llm-usage-telemetry";
import type { TaskExecutor } from "../scheduler";
import {
  executeDirectAnswer,
  type DirectAnswerInput,
} from "./direct-answer";
import {
  executeToolUse,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolUseInput,
} from "./tool-use";

/**
 * 内置 Sub-flow 名称的只读集合。
 *
 * Registry 会以此集合拦截业务注册，防止与引擎内置 Sub-flow 同名冲突。
 */
export const INTERNAL_SUBFLOW_NAMES = ["direct-answer", "tool-use"] as const;

export type InternalSubflowName = (typeof INTERNAL_SUBFLOW_NAMES)[number];

/**
 * 内置 Sub-flow 执行上下文。
 *
 * 与 `DirectAnswerContext` 的差异：
 * - Registry 层对上下文一无所知，传入的 context 必须是**已装配**好的值对象；
 * - 每次 `execute` 调用构造一个新的上下文，避免跨会话泄漏。
 *
 * 扩展字段（仅 `tool-use` 使用，其它内置 Sub-flow 可忽略）：
 * - `registry`：用于 `ToolCallRequest.name → ToolDescriptor` 的白名单校验
 * - `taskExecutor`：交由主干 TaskExecutor 执行工具，保证审批/安全闸门一致
 * - `executionContext`：下发给 `taskExecutor` 的上下文（预算、权限、trace）
 * - `onToolLoopEvent`：把 loop-step / tool-call-* 事件推给 runStream
 * - `onToolCall`：把 ToolCallRecord 汇回主干 metadata / orchestrator
 */
export interface InternalSubflowContext {
  config: EngineConfig;
  providers: Map<string, ProviderAdapter>;
  modelRouter: ModelRouter;
  memorySystem: MemorySystem;
  observability: ObservabilityEmitter;
  signal: AbortSignal;
 /** Provider / Memory 调用上下文（来自 `adapterCallContextFromExecution`）。 */
  adapterContext: AdapterCallContext;
 /** Host resource ref → Provider 载体物化 seam（ */
  multimodalResolver?: MultimodalResolver;
 /** Host 注入的 token 级需求路由；缺省全保真。 */
  resourceDemandRouter?:
    | import("../resolve-provider-messages").ResourceDemandRouter
    | undefined;
 /**
 * 由主干阶段（`Engine.runStream` Phase 6 预热阶段）预先组装好的 Prompt。
 *
 * 当内置 Sub-flow 选择"直接用预组装 Prompt 调 Provider.chat"（例如 direct-answer）
 * 时使用；为空表示子流程需自行组装上下文。
 */
  prebuiltPrompt?: AssembledPrompt;
 /**
 * Provider usage 回流回调。
 *
 * 由 Engine 注入；内置 Sub-flow 透传给底层 Provider.chat 调用点，让主干
 * `ExecutionOrchestrator` 能接收真实 token 消耗。
 */
  onProviderUsage?: (usage: ChatUsage) => void;
  emitUsageTelemetry?: EmitLlmUsageTelemetry | undefined;
  currentPhaseStepId?: string | undefined;
  nextStreamId?: (() => string) | undefined;
 /**
 * 描述符注册中心（ `tool-use` 消费。
 */
  registry?: Registry;
 /**
 * 主干 TaskExecutor（ `tool-use` 消费。
 */
  taskExecutor?: TaskExecutor;
 /**
 * 交付给 `taskExecutor` 的 ExecutionContext（ `tool-use` 消费。
 */
  executionContext?: ExecutionContext;
 /**
 * Agentic Loop 事件回流（ `tool-use` 产出。
 */
  onToolLoopEvent?: (chunk: StreamChunk) => void;
 /**
 * 工具调用记录回流（ `EngineOutput.metadata.toolCalls`
 * 与 `ExecutionOrchestrator`。仅 `tool-use` 消费。
 */
  onToolCall?: (record: ToolCallRecord) => void;
  onToolLoopActiveStart?: () => void;
  onToolLoopActiveEnd?: () => void;
  onUserBlockingStart?: () => void;
  onUserBlockingEnd?: () => void;
 /**
 * `direct-answer` 流式正文分片（需 `runtime.streamingOutput` 与 Provider `chatStream`）。
 */
  onAssistantDelta?: (text: string) => void;
 /**
 * 模型 reasoning_content 流式分片。
 */
  onAssistantReasoningDelta?: (text: string) => void;
 /**
 * 文生图 / 图像编辑产物回流。
 *
 * 由 Engine 注入：主干维护 traceId 级 sink，内置 `direct-answer` 子流程在从
 * Provider.chat 拿到 `ChatResponse.images` 时调用一次，把结构化列表合并到该 sink，
 * 最终由 `output` 阶段写入 `EngineOutput.metadata.generatedImages`。
 */
  onGeneratedImages?: (images: GeneratedImage[]) => void;
 /**
 * 通用多模态产物回流。
 */
  onGeneratedMedia?: (media: GeneratedMedia[]) => void;
 /**
 * 工具执行前审批回调（ Stage 4）：仅 `tool-use` 消费。
 *
 * 触发条件：描述符 `requiresApproval: true` 或全局
 * `runtime.toolLoop.requireApprovalGlobal: true`。未注入时视作自动批准。
 */
  onBeforeToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
 /** Session 管理（ADR skill sticky）：仅 `tool-use` 消费。 */
  sessionManager?: SessionManager;
  stickyManager?: StickyManager;
  searchSkills?: (query: string, topK?: number) => Promise<
    Array<{ name: string; score: number; description: string }>
  >;
 /** normalized turn policy for tool-use tail constraints. */
  turnPolicy?: TurnPolicy;
}

/**
 * 内置 Sub-flow 执行器签名。
 *
 * 公开导出，便于业务侧在自定义 `TaskExecutor` 或测试桩中引用同一签名，避免
 * 重复声明导致类型漂移（详见 §决定4 / ）。
 */
export type InternalSubflowHandler = (
  input: Record<string, unknown>,
  ctx: InternalSubflowContext,
) => Promise<unknown>;

/**
 * 内置 Sub-flow 注册表。
 *
 * 特性：
 * - 注册条目**硬编码**，不对业务暴露 register / unregister 接口
 * - 名称集合与 `INTERNAL_SUBFLOW_NAMES` 保持一致，供 Registry 校验冲突
 * - `execute(ref, ...)` 以显式失败（抛错）而非静默跳过，防止调用方误用
 */
export class InternalSubflowRegistry {
  private readonly handlers = new Map<string, InternalSubflowHandler>();

  constructor() {
    this.handlers.set(
      "direct-answer",
      async (input, ctx) => {
 // 鸭子类型校验：内置 Sub-flow 对输入 shape 负有完全责任。
 // 不做 `as DirectAnswerInput` 强转，避免 TS 的 Record<string, unknown> 兼容性报错。
        const payload = input as unknown as DirectAnswerInput;
        return executeDirectAnswer(payload, {
          config: ctx.config,
          providers: ctx.providers,
          modelRouter: ctx.modelRouter,
          memorySystem: ctx.memorySystem,
          observability: ctx.observability,
          signal: ctx.signal,
          adapterContext: ctx.adapterContext,
          ...(ctx.multimodalResolver !== undefined
            ? { multimodalResolver: ctx.multimodalResolver }
            : {}),
          ...(ctx.resourceDemandRouter !== undefined
            ? { resourceDemandRouter: ctx.resourceDemandRouter }
            : {}),
          ...(ctx.prebuiltPrompt !== undefined
            ? { prebuiltPrompt: ctx.prebuiltPrompt }
            : {}),
          ...(ctx.onProviderUsage !== undefined
            ? { onProviderUsage: ctx.onProviderUsage }
            : {}),
          ...(ctx.emitUsageTelemetry !== undefined
            ? { emitUsageTelemetry: ctx.emitUsageTelemetry }
            : {}),
          ...(ctx.currentPhaseStepId !== undefined
            ? { currentPhaseStepId: ctx.currentPhaseStepId }
            : {}),
          ...(ctx.nextStreamId !== undefined ? { nextStreamId: ctx.nextStreamId } : {}),
          ...(ctx.onAssistantDelta !== undefined
            ? { onAssistantDelta: ctx.onAssistantDelta }
            : {}),
          ...(ctx.onAssistantReasoningDelta !== undefined
            ? { onAssistantReasoningDelta: ctx.onAssistantReasoningDelta }
            : {}),
          ...(ctx.onGeneratedImages !== undefined
            ? { onGeneratedImages: ctx.onGeneratedImages }
            : {}),
          ...(ctx.onGeneratedMedia !== undefined
            ? { onGeneratedMedia: ctx.onGeneratedMedia }
            : {}),
        });
      },
    );

    this.handlers.set("tool-use", async (input, ctx) => {
      const payload = input as unknown as ToolUseInput;
      if (!ctx.prebuiltPrompt) {
        throw new Error("tool-use Sub-flow 需要 prebuiltPrompt，但主干未注入");
      }
      if (!ctx.registry) {
        throw new Error("tool-use Sub-flow 需要 registry，但主干未注入");
      }
      if (!ctx.taskExecutor) {
        throw new Error("tool-use Sub-flow 需要 taskExecutor，但主干未注入");
      }
      if (!ctx.executionContext) {
        throw new Error("tool-use Sub-flow 需要 executionContext，但主干未注入");
      }
      return executeToolUse(payload, {
        config: ctx.config,
        providers: ctx.providers,
        modelRouter: ctx.modelRouter,
        memorySystem: ctx.memorySystem,
        observability: ctx.observability,
        registry: ctx.registry,
        taskExecutor: ctx.taskExecutor,
        executionContext: ctx.executionContext,
        signal: ctx.signal,
        adapterContext: ctx.adapterContext,
        ...(ctx.multimodalResolver !== undefined
          ? { multimodalResolver: ctx.multimodalResolver }
          : {}),
        ...(ctx.resourceDemandRouter !== undefined
          ? { resourceDemandRouter: ctx.resourceDemandRouter }
          : {}),
        prebuiltPrompt: ctx.prebuiltPrompt,
        ...(ctx.onProviderUsage !== undefined
          ? { onProviderUsage: ctx.onProviderUsage }
          : {}),
        ...(ctx.emitUsageTelemetry !== undefined
          ? { emitUsageTelemetry: ctx.emitUsageTelemetry }
          : {}),
        ...(ctx.currentPhaseStepId !== undefined
          ? { currentPhaseStepId: ctx.currentPhaseStepId }
          : {}),
        ...(ctx.nextStreamId !== undefined ? { nextStreamId: ctx.nextStreamId } : {}),
        ...(ctx.onToolLoopEvent !== undefined
          ? { onToolLoopEvent: ctx.onToolLoopEvent }
          : {}),
        ...(ctx.onToolCall !== undefined ? { onToolCall: ctx.onToolCall } : {}),
        ...(ctx.onAssistantReasoningDelta !== undefined
          ? { onAssistantReasoningDelta: ctx.onAssistantReasoningDelta }
          : {}),
        ...(ctx.onToolLoopActiveStart !== undefined
          ? { onToolLoopActiveStart: ctx.onToolLoopActiveStart }
          : {}),
        ...(ctx.onToolLoopActiveEnd !== undefined
          ? { onToolLoopActiveEnd: ctx.onToolLoopActiveEnd }
          : {}),
        ...(ctx.onUserBlockingStart !== undefined
          ? { onUserBlockingStart: ctx.onUserBlockingStart }
          : {}),
        ...(ctx.onUserBlockingEnd !== undefined
          ? { onUserBlockingEnd: ctx.onUserBlockingEnd }
          : {}),
        ...(ctx.onBeforeToolCall !== undefined
          ? { onBeforeToolCall: ctx.onBeforeToolCall }
          : {}),
        ...(ctx.sessionManager !== undefined
          ? { sessionManager: ctx.sessionManager }
          : {}),
        ...(ctx.stickyManager !== undefined ? { stickyManager: ctx.stickyManager } : {}),
        ...(ctx.searchSkills !== undefined ? { searchSkills: ctx.searchSkills } : {}),
        ...(ctx.turnPolicy !== undefined ? { turnPolicy: ctx.turnPolicy } : {}),
      });
    });
  }

 /**
 * 查询某 ref 是否为内置 Sub-flow。
 *
 * 默认 TaskExecutor 会以此判定是否转交给本注册表处理；返回 false 意味着
 * 该 ref 属于业务 Sub-flow（或未实现的类型），调用方应走其它分发路径。
 */
  has(ref: string): boolean {
    return this.handlers.has(ref);
  }

 /**
 * 列出全部内置 Sub-flow 名称。
 *
 * 用于 Registry 启动期的"保留名校验"与诊断输出。
 */
  list(): readonly string[] {
    return [...this.handlers.keys()];
  }

 /**
 * 执行指定内置 Sub-flow。
 *
 * @throws 当 ref 不存在时抛错（防止"业务自定义 TaskExecutor 把错误的 ref 扔进来"的静默失败）
 */
  async execute(
    ref: string,
    input: Record<string, unknown>,
    ctx: InternalSubflowContext,
  ): Promise<unknown> {
    const handler = this.handlers.get(ref);
    if (!handler) {
      throw new Error(`internal sub-flow 未注册: ${ref}`);
    }
    return handler(input, ctx);
  }
}
