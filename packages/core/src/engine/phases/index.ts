import type {
  EngineConfig,
  SessionScope,
  TokenUsageTriplet,
  UsageAccuracy,
  UsageAttribution,
  UsageTerminalState,
} from "../../types";
import type { AdapterCallContext } from "../../types/context";
import type {
  HookRegistry,
  MemorySystem,
  ModelRouter,
  ObservabilityEmitter,
  ProviderAdapter,
  RuntimeState,
  SafetyModule,
  SessionManager,
} from "../../modules";
import type { DescriptorRegistry } from "../../registry";
import type { TaskScheduler } from "../scheduler";
import type { ToolActivator } from "../tool-activation";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import type { MultimodalResolver } from "../../types/multimodal-resolver";

/**
 * 各阶段运行环境依赖。
 *
 * `onProviderUsage` 为 引入的回调：每次 Provider.chat 真实返回 usage
 * 时由阶段调用，引擎主干据此把真实 token 消耗回流到 `ExecutionOrchestrator`，替代
 * 先前只用 Prompt 估算 token 的做法，保证预算熔断与可观测事件拿到准确数据。
 */
export interface PhaseEnvironment {
  config: EngineConfig;
  registry: DescriptorRegistry;
  sessionManager: SessionManager;
  memorySystem: MemorySystem;
  runtimeState: RuntimeState;
  modelRouter: ModelRouter;
  providers: Map<string, ProviderAdapter>;
  safetyModule: SafetyModule;
  observability: ObservabilityEmitter;
  hooks: HookRegistry;
  scheduler: TaskScheduler;
  activeAbortSignal: AbortSignal;
 /** 本轮 `ExecutionContext` 导出的 Provider / Memory / Vector 调用上下文。 */
  adapterContext: AdapterCallContext;
  onProviderUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
 /**
 * Prompt caching 命中量（OpenAI `prompt_tokens_details.cached_tokens`
 * / Anthropic `cache_read_input_tokens`）。可选；未命中时缺省。
 */
    cachedPromptTokens?: number;
  }) => void;
 /**
 * Structured usage telemetry emitted at the LLM-call boundary. Consumers
 * replace snapshots for the same attribution id instead of accumulating
 * deltas, which allows final provider usage to correct estimates.
 */
  emitUsageTelemetry?: (event: {
    attribution: UsageAttribution;
    usage: TokenUsageTriplet;
    accuracy: UsageAccuracy;
    terminal?: UsageTerminalState | undefined;
  }) => void;
 /** Stable public id of the currently active top-level phase step. */
  currentPhaseStepId?: string | undefined;
  /** Host/run-scoped stable id factory. */
  nextStreamId?: (() => string) | undefined;
  /** Tool candidate activator for tool-routing phase. */
  toolActivator?: ToolActivator;
  /** Policy-aware semantic retrieval. */
  semanticRetrieval?: SemanticRetrievalFacade;
  /** Session-level scope for per-run dynamic config. */
  scope?: SessionScope;
 /** Host resource ref → Provider 载体物化 seam. */
  multimodalResolver?: MultimodalResolver;
 /** Host 注入的 token 级需求路由；缺省全保真。 */
  resourceDemandRouter?: import("../resolve-provider-messages").ResourceDemandRouter | undefined;
 /**
 * Turn-level retry context。
 *
 * 仅当 Engine 的 do-while 重试循环触发 `continue` 时被注入；首次执行时为 undefined。
 * `runToolRoutingPhase` 在 attempt > 0 时会 emit `previous-attempt-injected` 事件，
 * 供观测/审计使用(路由本身是确定性的，不会据此改变任务构造)。
 */
  previousAttempt?: PreviousTurnAttempt;
}

/**
 * 上一轮 turn 的失败摘要。
 *
 * 由 Engine 在 `decideTurnRetry` 决定 `continue` 后填入 `PhaseEnvironment.previousAttempt`，
 * `runToolRoutingPhase` 据此 emit 观测事件，避免重试诊断信号随死 phase 一并消失。
 */
export interface PreviousTurnAttempt {
 /** 已完成的重试次数，等价于即将进入的 attempt index（第 N 次重试，N 从 1 起）。 */
  retryCount: number;
 /** 上一轮 ValidationOutcome.kind（`retry` / 已观察到的最终态）。 */
  lastOutcomeKind: string;
 /** 上一轮 outcome 的 `target`（`retry-turn` / `tool-loop-finalize`），供观测 / 审计。 */
  target?: string | undefined;
  /** 上一轮 outcome.reason；loop-route 观测与候选策略都用得上。 */
  reason?: string | undefined;
 /** 上一轮 validation diagnosis（如有）；调试用。 */
  diagnosis?: string | undefined;
}

export * from "./candidate-answer";
export * from "./execution";
export * from "./output";
export * from "./safety";
export * from "./session";
export * from "./tool-routing";
export * from "./validation";
