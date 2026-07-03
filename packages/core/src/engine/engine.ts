import { EngineError, ValidationError } from "../errors";
import {
  DefaultHookRegistry,
  DefaultModelRouter,
  DefaultObservabilityEmitter,
  DefaultSafetyModule,
  InMemoryMemorySystem,
  InMemoryRuntimeState,
  InMemorySessionManager,
  NoopProvider,
  createSafetyViolationsGuardrail,
  runGuardrails,
  type HookRegistry,
  type MemoryEntry,
  type MemorySystem,
  type ModelRouter,
  type ObservabilityEmitter,
  type ProviderAdapter,
  type RuntimeState,
  type SafetyModule,
  type SessionManager,
} from "../modules";
import type { Guardrail } from "../types/guardrail";
import {
  DefaultPromptAssembler,
  NeedToKnowContextDistributor,
  createTiktokenTokenizer,
  type AssembledPrompt,
  type Tokenizer,
} from "../prompt";
import { DescriptorRegistry } from "../registry";
import type { Registry } from "../registry";
import type {
  EngineConfig,
  EnginePhase,
  EngineOutput,
  ExecutionContext,
  GeneratedImage,
  GeneratedMedia,
  InputEnvelope,
  Message,
  ModelRoute,
  OutputMetadata,
  SessionScope,
  StreamChunk,
  ToolCallRecord,
} from "../types";
import {
  adapterCallContextFromExecution,
  assertCompleteExecutionCorrelation,
  type AdapterCallContext,
  type ExecutionCorrelation,
  type ExecutionSubject,
} from "../types/context";
import {
  createDefaultEngineConfig,
  envelopeNeedsVision,
  validateEngineConfig,
} from "../utils";
import { InMemoryVectorStore, type VectorStore } from "../vector";
import { ExecutionOrchestrator } from "./orchestrator";
import { TaskScheduler, type TaskExecutor } from "./scheduler";
import {
  applyTurnOutcome,
  engineEventFromContext,
  streamEnvelopeFromContext,
  validationOutcomeToEvent,
  withStreamEnvelope,
} from "./turn-outcome";
import { resolveRunSkills } from "./run-skill-activation";
import { decideTurnRetry } from "./turn-retry";
import {
  InMemoryStickyManager,
  createDefaultCandidateStrategies,
  createDefaultPinningStrategies,
  type CandidateStrategy,
  type PinningStrategy,
  type StickyManager,
} from "./skill-activation";
import type { SemanticRetrievalFacade } from "../semantic-retrieval";
import { DefaultToolActivator, createDefaultToolCandidateStrategies } from "./tool-activation";
import type { ToolActivator, ToolCandidateStrategy } from "./tool-activation";
import {
  DefaultAgentRuntimeAdapter,
  DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH,
  type AgentRuntimeAdapter,
} from "./agents";
import type {
  AgentDispatchFn,
  AgentInvocation,
  AgentRunResult,
  AgentStructuredContext,
} from "./agents";
import type { EvidenceEntry } from "../types/evidence";
import { DefaultToolUseExecutor, type ToolUseExecutor } from "./tool-use";
import { readTurnPolicy } from "./turn-policy";
import {
  DefaultContextBudgetBroker,
  type ContextBudgetBroker,
  type ContextBudgetDecision,
} from "./context-budget";
import {
  INTERNAL_SUBFLOW_NAMES,
  InternalSubflowRegistry,
  INTERNAL_TOOL_NAMES,
  mergeInternalToolDefinitions,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolUseContext,
} from "./subflows";
import {
  runExecutionPhase,
  runToolRoutingPhase,
  runOutputPhase,
  runSafetyPhase,
  runSessionPhase,
  runCandidateAnswerPhase,
  runValidationPhase,
  isValidationPassing,
  type PhaseEnvironment,
  type ValidationPhaseOutput,
  ValidationRuleRegistry,
  type SemanticJudgeAdapter,
} from "./phases";
import {
  DELTA_STREAM_END,
  DeltaStreamQueue,
} from "./delta-stream-queue";
import type {
  EmitLlmUsageTelemetry,
  LlmUsageTelemetryEvent,
} from "./llm-usage-telemetry";
import { applyModelOverride } from "./model-router-override";

function enqueueUsageChunk(
  deltaQueue: DeltaStreamQueue | undefined,
  orchestrator: ExecutionOrchestrator,
  context: ExecutionContext,
): void {
  if (!deltaQueue) {
    return;
  }
  const u = orchestrator.getUsage();
  deltaQueue.enqueue(
    withStreamEnvelope(
      {
        type: "usage",
        tokens: u.tokens,
        toolCalls: u.toolCalls,
        wallTimeMs: u.wallTimeMs,
      },
      context,
    ),
  );
}

/**
 * 扫描 `tool-use` 写入的 outbox，为仅有 `tool-call-start`、缺少对偶 `tool-call-end`
 * 的 callId 追加一条失败闭合块。
 *
 * 典型触发：宿主 `onToolLoopEvent` 抛错、或执行在子流程中途失败导致主干
 * `catch` 提前结束而未走正常 flush。不得在未闭合时离开 execution 或 done。
 */
function sealOpenToolCallStreamChunks(outbox: StreamChunk[], context: ExecutionContext): void {
  const pending = new Map<string, string>();
  for (const chunk of outbox) {
    if (chunk.type === "tool-call-start") {
      pending.set(chunk.callId, chunk.tool);
    } else if (chunk.type === "tool-call-end") {
      pending.delete(chunk.callId);
    }
  }
  for (const [callId, tool] of pending) {
    outbox.push({
      type: "tool-call-end",
      callId,
      tool,
      success: false,
      durationMs: 0,
      error: {
        code: "TOOL_LOOP_UNCLOSED_STREAM_CHUNK",
        message:
          "引擎在离开 execution 阶段前检测到该 callId 缺少对偶的 tool-call-end，已补发闭合事件。",
        retryable: false,
      },
      ...streamEnvelopeFromContext(context),
    });
  }
}

function collectToolLoopChunksForTerminalFlush(
  outbox: StreamChunk[],
  alreadyStreamedLive: boolean,
  context: ExecutionContext,
): StreamChunk[] {
  const lengthBeforeSeal = outbox.length;
  sealOpenToolCallStreamChunks(outbox, context);
  return alreadyStreamedLive ? outbox.slice(lengthBeforeSeal) : outbox;
}

class InternalEngineError extends EngineError {}

/**
 * `memorySystem` factory 回调接收到的依赖 —— 由 Engine 构造器在已经完成
 * tokenizer / modelRouter / providers / vectorStore 初始化后调用，专为需要这些
 * 下游依赖的持久化 MemorySystem（例如 `@tachu/extensions` 的 `FsMemorySystem`）
 * 准备。
 *
 * 这样 core 不必直接依赖具体的持久化实现（DP-1:B）——extensions 里定义
 * `FsMemorySystem`，CLI engine-factory 把"构造方法"以闭包形式传回 core，
 * core 填入自己的内部依赖后实例化。
 */
export interface MemorySystemFactoryDeps {
  config: EngineConfig;
  tokenizer: Tokenizer;
  modelRouter: ModelRouter;
  providers: Map<string, ProviderAdapter>;
  vectorStore: VectorStore;
}

/**
 * `memorySystem` 的可注入形态：
 * - `MemorySystem` 实例：调用方自己构造完毕（SDK 典型路径）
 * - `(deps) => MemorySystem`：延迟实例化，可拿到 Engine 内部构造的 tokenizer /
 * modelRouter / providers / vectorStore 后再组装（持久化实现典型路径）
 */
export type MemorySystemInjection =
  | MemorySystem
  | ((deps: MemorySystemFactoryDeps) => MemorySystem);

/**
 * 引擎可注入依赖。
 */
export interface EngineDependencies {
  registry?: DescriptorRegistry;
  vectorStore?: VectorStore;
  providers?: ProviderAdapter[];
  sessionManager?: SessionManager;
  memorySystem?: MemorySystemInjection;
  runtimeState?: RuntimeState;
  modelRouter?: ModelRouter;
  safetyModule?: SafetyModule;
  observability?: ObservabilityEmitter;
  hooks?: HookRegistry;
  taskExecutor?: TaskExecutor;
 /**
 * `tool-use` 工具审批回调（ Stage 4）。
 *
 * 触发条件：`ToolDescriptor.requiresApproval === true` 或
 * `config.runtime.toolLoop.requireApprovalGlobal === true`。
 * 未注入时一律自动批准，等价于旧行为。
 */
  onBeforeToolCall?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
  stickyManager?: StickyManager;
  pinningStrategies?: PinningStrategy[];
  candidateStrategies?: CandidateStrategy[];
 /**
 * Policy-aware semantic retrieval.
 */
  semanticRetrievalFacade?: SemanticRetrievalFacade;
 /** Tool candidate strategies for DefaultToolActivator. */
  toolStrategies?: ToolCandidateStrategy[];
 /** Agent task runtime; default is an in-process LLM adapter using high-reasoning route. */
  agentRuntime?: AgentRuntimeAdapter;
  contextBudgetBroker?: ContextBudgetBroker;
 /**
 * Host-injected ValidationRuleRegistry（测试钩子）。
 * 默认使用 `buildDefaultValidationRuleRegistry()`。
 * 仅供集成测试 / host 替换内置 rule 使用，不打算长期暴露给业务代码。
 */
  validationRuleRegistry?: ValidationRuleRegistry;
 /** Optional semantic judge adapter. */
  semanticJudge?: SemanticJudgeAdapter;
 /**
 * Host-injected seam：按 `key` 把不透明的 ResourceReference 物化为 Provider 载体
 * `data:`/`http(s):` 内联图片由 core 直接携带，不经此 seam。
 */
  multimodalResolver?: import("../types/multimodal-resolver").MultimodalResolver;
 /**
 * Host 注入的 token 级资源需求路由。
 *
 * core 在 `tool-use` 唯一的 Provider 边界 seam 调用前调用一次，得到高层
 * `ResourceDemandSelector`，展开为底层 key-only `ResourceDemand` 后传入 seam。
 * **缺省不注入即行为不变（全保真 `{ mode: "all" }`）**；任何裁剪须经此钩子显式
 * opt-in。
 */
  resourceDemandRouter?: import("./resolve-provider-messages").ResourceDemandRouter;
 /**
 * 对称守卫 seam(ADR-0006 D4):挂 `turnStart`/`turnStop` 的宿主自定义 guardrail。
 *
 * 与 `hooks.register("turnStart"/"turnStop", ...)` 的差异:guardrail 契约提供
 * `pass/block/degrade/annotate` 更贴合"合规/内容策略/质量校验"语义的判别联合,
 * 而不是通用的 `HookAction`。两者共存:引擎内置的 `builtin.safety-violations`
 * guard 恒跑在 `turnStart`;这里注入的列表在其后追加执行。
 */
  guardrails?: {
    turnStart?: Guardrail[];
    turnStop?: Guardrail[];
  };
}

/**
 * Tachu 核心引擎。
 *
 * 该类负责组装运行时依赖并串联 6 阶段主干流程（深单 agentic loop，ADR-0006），
 * 支持流式与非流式执行、会话级取消传播、Hook 扩展以及资源释放。
 */
export class Engine {
  readonly config: EngineConfig;
  readonly registry: Registry;
  readonly providers: Map<string, ProviderAdapter>;

  private readonly vectorStore: VectorStore;
  private readonly tokenizer: Tokenizer;
  private readonly promptAssembler = new DefaultPromptAssembler();
  private readonly contextDistributor = new NeedToKnowContextDistributor();
  private readonly sessionManager: SessionManager;
  private readonly memorySystem: MemorySystem;
  private readonly runtimeState: RuntimeState;
  private readonly modelRouter: ModelRouter;
  private readonly safetyModule: SafetyModule;
  private readonly observability: ObservabilityEmitter;
  private readonly hooks: HookRegistry;
  private readonly guardrails: { turnStart: Guardrail[]; turnStop: Guardrail[] };
  private readonly scheduler: TaskScheduler;
  private readonly taskExecutor: TaskExecutor;
  private readonly internalSubflows: InternalSubflowRegistry;
  private disposed = false;
 /**
 * 活跃 runStream 的预组装 Prompt 缓存，按 `traceId` 索引。
 *
 * 由 `runStream` 在 Phase 6 预热阶段写入、在 `finally` 里清理；`buildLayeredTaskExecutor`
 * 读取它并作为 `prebuiltPrompt` 传递给内置 Sub-flow（`tool-use`）。
 *
 * 以 `traceId` 为键而非 `sessionId`：同一 session 可能有并发取消后的重试，
 * 用 traceId 区分每一次具体执行，避免旧 trace 污染新 trace 的 prompt。
 */
  private readonly activeRunPrompts = new Map<string, AssembledPrompt>();
  private readonly activeRunTurnPolicies = new Map<string, import("../types").TurnPolicy>();

 /**
 * 活跃 runStream 的 usage 回流回调缓存，按 `traceId` 索引。
 *
 * 与 `activeRunPrompts` 同生命周期：`runStream` 创建 orchestrator 后写入，
 * `finally` 清理；内置 Sub-flow（`tool-use`）据此把真实 usage 汇回主干。
 */
  private readonly activeRunUsageSinks = new Map<
    string,
    (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedPromptTokens?: number;
    }) => void
  >();

  private readonly activeRunUsageTelemetrySinks = new Map<
    string,
    EmitLlmUsageTelemetry
  >();
  private readonly activeRunIdFactories = new Map<string, () => string>();
  private readonly activeRunCurrentPhaseStepIds = new Map<string, string>();

 /**
 * 活跃 runStream 的 ExecutionContext。
 *
 * `tool-use` 内置 Sub-flow 执行工具时需要把它传给 TaskExecutor，以保持预算、
 * 权限、traceId 等信息与主干一致。与 `activeRunPrompts` 同生命周期。
 */
  private readonly activeRunExecutionContexts = new Map<string, ExecutionContext>();

 /**
 * 活跃 runStream 的 Agentic Loop 事件 outbox。
 *
 * `tool-use` 在执行过程中通过 `onToolLoopEvent` 把 loop-step / tool-call-*
 * 事件 push 进本 outbox；streaming 模式下同时写入 DeltaStreamQueue 实时
 * yield 给调用方，非 streaming 模式仍在 execution phase 结束后一次性 flush。
 *
 * 即使事件已经实时发送，也保留 outbox 用于对账和异常路径补发未闭合的
 * tool-call-end。
 */
  private readonly activeRunEventOutbox = new Map<string, StreamChunk[]>();

 /**
 * 活跃 runStream 的 ToolCallRecord outbox。
 *
 * `tool-use` 的每次工具调用（成功或失败）都会 push 一条记录；Engine 会在
 * execution phase 结束后与主干的 `toolCalls` 合并，最终反映在
 * `EngineOutput.metadata.toolCalls` 中。
 */
  private readonly activeRunToolCallSinks = new Map<string, ToolCallRecord[]>();

 /**
 * 活跃 runStream 的顶层正文 delta 队列（`runtime.streamingOutput`）。
 *
 * ADR-0006 C1 塌陷为深单 loop 后未被内置 Sub-flow 消费(`tool-use` 走的是
 * `onToolLoopEvent` 的 `tool-loop-delta`)；保留以兼容未来子流程复用。
 */
  private readonly activeRunDeltaOutbox = new Map<string, DeltaStreamQueue>();

 /**
 * 活跃 runStream 的文生图 / 图像编辑产物 sink。
 *
 * 由 `runStream` 在 orchestrator 就绪后初始化为空数组、`finally` 清理；内置
 * `tool-use` 子流程在某个 loop step 的 Provider 响应携带 images 时把列表
 * 合并到本 sink。Output phase 结束前会一次性写入
 * `EngineOutput.metadata.generatedImages`。
 */
  private readonly activeRunGeneratedImages = new Map<string, GeneratedImage[]>();
  private readonly activeRunGeneratedMedia = new Map<string, GeneratedMedia[]>();
 /**
 * 活跃 runStream 的 tool-loop 计时控制回调（排除用户阻塞时间）。
 */
  private readonly activeRunToolLoopTimingControls = new Map<
    string,
    {
      onToolLoopActiveStart: () => void;
      onToolLoopActiveEnd: () => void;
      onUserBlockingStart: () => void;
      onUserBlockingEnd: () => void;
    }
  >();

 /**
 * 活跃 runStream 的 effective ModelRouter（按 `traceId` 索引）。
 *
 * 由 `runStream` 在构造 phaseEnv 时写入、`finally` 清理。值是
 * `applyModelOverride(baseRouter, scope?.modelOverride)` 的结果：
 * - 当 scope 未提供 modelOverride 时与 `this.modelRouter` 同实例（零开销）
 * - 当提供时是一个新的 ModelRouter 包装层
 *
 * 内置 Sub-flow（`tool-use`）通过 `buildLayeredTaskExecutor` 间接接收
 * ModelRouter，需要按 traceId 查到本轮 effective router 才能让 modelOverride
 * 真正影响子流程的 provider 调用。
 */
  private readonly activeRunModelRouters = new Map<string, ModelRouter>();

 /**
 * `tool-use` 工具审批回调（ Stage 4）。
 *
 * 注入时机：Engine 构造期；运行期不可变。未注入视作自动批准，保持旧行为。
 */
  private readonly onBeforeToolCall?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
  private readonly stickyManager: StickyManager;
  private readonly pinningStrategies: PinningStrategy[];
  private readonly candidateStrategies: CandidateStrategy[];
  private readonly semanticRetrieval?: SemanticRetrievalFacade;
  private readonly toolActivator: ToolActivator;
  private readonly injectedAgentRuntime: AgentRuntimeAdapter | undefined;
 /**
 * 共享的 tool-use 执行器。
 *
 * 主 Engine planning/validation 走 orchestrator；sub-agent runtime 通过该执行器
 * 复用同一份多轮 tool-use loop 实现，并以 `ctx.agentRunId = invocation.id`
 * 作为 history-scope 隔离键，避免父子调度的工具历史互相串扰。
 */
  private readonly toolUseExecutor: ToolUseExecutor;
  private readonly contextBudgetBroker: ContextBudgetBroker;
  private readonly validationRuleRegistry?: ValidationRuleRegistry;
  private readonly semanticJudge?: SemanticJudgeAdapter;
  private readonly multimodalResolver?: import("../types/multimodal-resolver").MultimodalResolver;
  private readonly resourceDemandRouter?: import("./resolve-provider-messages").ResourceDemandRouter;
  constructor(config: EngineConfig, dependencies?: EngineDependencies) {
    this.config = validateEngineConfig(config ?? createDefaultEngineConfig());
    this.vectorStore =
      dependencies?.vectorStore ??
      new InMemoryVectorStore({ indexLimit: this.config.memory.vectorIndexLimit });
    this.registry =
      dependencies?.registry ??
      new DescriptorRegistry({
        reservedNames: [...INTERNAL_SUBFLOW_NAMES, ...INTERNAL_TOOL_NAMES],
      });
    this.observability = dependencies?.observability ?? new DefaultObservabilityEmitter();
    this.providers = new Map(
      (dependencies?.providers ?? [new NoopProvider()]).map((provider) => [provider.id, provider]),
    );
    this.modelRouter = dependencies?.modelRouter ?? new DefaultModelRouter(this.config);
    const tokenizerModel = this.pickTokenizerModel();
    this.tokenizer = createTiktokenTokenizer(tokenizerModel, (message) => {
      this.observability.emit({
        timestamp: Date.now(),
        correlation: {
          traceId: "engine-init",
          requestId: "engine-init",
          sessionId: "engine-init",
          turnId: "engine-init",
        },
        phase: "prompt",
        type: "warning",
        payload: { message, tokenizerModel },
      });
    });
    this.sessionManager = dependencies?.sessionManager ?? new InMemorySessionManager();
    this.runtimeState = dependencies?.runtimeState ?? new InMemoryRuntimeState();
    this.internalSubflows = new InternalSubflowRegistry();
    if (dependencies?.onBeforeToolCall !== undefined) {
      this.onBeforeToolCall = dependencies.onBeforeToolCall;
    }
    this.stickyManager =
      dependencies?.stickyManager ??
      new InMemoryStickyManager({
        ttlTurns: this.config.runtime.stickyTtlTurns ?? 8,
        maxSlots: this.config.runtime.stickyMaxSlots ?? 3,
      });
    this.pinningStrategies =
      dependencies?.pinningStrategies ?? createDefaultPinningStrategies();
    if (dependencies?.semanticRetrievalFacade !== undefined) {
      this.semanticRetrieval = dependencies.semanticRetrievalFacade;
    }
    this.candidateStrategies = [
      ...createDefaultCandidateStrategies(),
      ...(dependencies?.candidateStrategies ?? []),
    ];
    this.toolActivator = new DefaultToolActivator({
      strategies:
        dependencies?.toolStrategies ?? createDefaultToolCandidateStrategies(),
    });
    this.injectedAgentRuntime = dependencies?.agentRuntime;
    this.toolUseExecutor = new DefaultToolUseExecutor();
    this.contextBudgetBroker =
      dependencies?.contextBudgetBroker ?? new DefaultContextBudgetBroker();
    if (dependencies?.validationRuleRegistry !== undefined) {
      this.validationRuleRegistry = dependencies.validationRuleRegistry;
    }
    if (dependencies?.semanticJudge !== undefined) {
      this.semanticJudge = dependencies.semanticJudge;
    }
    if (dependencies?.multimodalResolver !== undefined) {
      this.multimodalResolver = dependencies.multimodalResolver;
    }
    if (dependencies?.resourceDemandRouter !== undefined) {
      this.resourceDemandRouter = dependencies.resourceDemandRouter;
    }
    this.safetyModule =
      dependencies?.safetyModule ?? new DefaultSafetyModule(this.config, this.observability);
    this.memorySystem = this.resolveMemorySystem(dependencies?.memorySystem);
    this.hooks =
      dependencies?.hooks ??
      new DefaultHookRegistry(
        this.observability,
        this.config.hooks.writeHookTimeout,
        this.config.hooks.failureBehavior,
      );
    this.guardrails = {
      turnStart: dependencies?.guardrails?.turnStart ?? [],
      turnStop: dependencies?.guardrails?.turnStop ?? [],
    };
 // TaskExecutor 装配：
 // - 无论业务是否注入自定义 executor，内置 Sub-flow（`tool-use`）
 // 必须由引擎内部的 `InternalSubflowRegistry` 拦截执行；否则业务自定义 executor
 // 会把 `type === 'sub-flow'` 视为未知类型而抛错，整条 turn 会失败。
 // - 非内置 Sub-flow 的任务（tool / agent / 业务 Sub-flow）继续按业务自定义
 // executor 或默认占位 executor 处理。
    const fallbackExecutor = dependencies?.taskExecutor ?? this.buildPlaceholderTaskExecutor();
    this.taskExecutor = this.buildLayeredTaskExecutor(fallbackExecutor);
    this.scheduler = new TaskScheduler(this.taskExecutor);
  }

 /**
 * 构造"占位层"TaskExecutor。
 *
 * 当业务未注入 `dependencies.taskExecutor` 时使用：对 tool/agent/业务 sub-flow 返回
 * 结构化占位结果，保留诊断性文本，直到 Tool/Agent 真正落地。
 */
 /**
 * 选择引擎主 tokenizer 绑定的 model。
 *
 * 优先顺序：`fast-cheap` → `intent` → `planning` → `capabilityMapping` 首项 → `gpt-4o-mini`。
 * 该 tokenizer 仅用于引擎内部估算（memory / prompt assembler）。Provider 的精确 token
 * 计数在各自 `countTokens` 内按 request.model 单独构建 tokenizer。
 */
 /**
 * 解析本轮 PromptAssembler 使用的 `maxContextTokens`。
 *
 * 读取顺序：
 * 1. `config.memory.maxContextTokens` 显式配置（>0 时生效）
 * 2. 回退到 128_000（覆盖绝大多数主流长文 LLM）
 *
 * 此值仅约束 assembler 裁剪的上限；真正调用 Provider 时仍以 Provider 的
 * `getCapabilities(model).maxContextTokens` 为权威。
 */
  private resolveMaxContextTokens(): number {
    const configured = this.config.memory.maxContextTokens;
    if (typeof configured === "number" && configured > 0) {
      return configured;
    }
    return 128_000;
  }

 /**
 * 估算 ContextBudget 决策所需的输入 token 数。
 *
 * 旧实现仅 tokenize `input.content`，对实际 prompt 体积严重低估
 * （历史、recall、活动 skill、tool 定义、rule 全部缺席）。现接受可选 `extras`，
 * 在调用方能拿到 contextWindow / recalledEntries 时一起计入；尚不可见的部分
 * （activeSkills/tools/rules）由 PromptAssembler 在装配时通过 envelope.trimOrder
 * 二次约束，避免在 broker 决策阶段做不准确的猜测。
 *
 * 该方法 ≠ provider 计费 token；仅作 broker 阈值比较使用。
 */
  private estimateInputTokens(
    input: InputEnvelope,
    extras?: {
      historyMessages?: Array<{ content: unknown }>;
      recalledEntries?: Array<{ content: unknown }>;
    },
  ): number {
    const tokenize = (raw: unknown): number => {
      if (typeof raw === "string") return this.tokenizer.count(raw);
      try {
        return this.tokenizer.count(JSON.stringify(raw));
      } catch {
        return this.tokenizer.count(String(raw));
      }
    };
    let total = tokenize((input as { content?: unknown }).content);
    if (extras?.historyMessages !== undefined) {
      for (const message of extras.historyMessages) {
        total += tokenize(message.content);
      }
    }
    if (extras?.recalledEntries !== undefined) {
      for (const entry of extras.recalledEntries) {
        total += tokenize(entry.content);
      }
    }
    return total;
  }

  private async resolveProviderContextTokens(route: ModelRoute): Promise<number> {
    const configured = this.resolveMaxContextTokens();
    const provider = this.providers.get(route.provider);
    if (!provider) {
      return configured;
    }
    try {
      const models = await provider.listAvailableModels();
      const match = models.find((item) => item.modelName === route.model);
      const providerMax = match?.capabilities.maxContextTokens;
      if (typeof providerMax === "number" && providerMax > 0) {
        return Math.min(configured, providerMax);
      }
    } catch (error) {
      this.observability.emit({
        timestamp: Date.now(),
        correlation: {
          traceId: "context-budget",
          requestId: "context-budget",
          sessionId: "context-budget",
          turnId: "context-budget",
        },
        phase: "prompt",
        type: "warning",
        payload: {
          reason: "provider capabilities unavailable; using configured maxContextTokens",
          provider: route.provider,
          model: route.model,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return configured;
  }

  private async decideMainContextBudget(
    input: InputEnvelope,
    route: ModelRoute,
    extras?: {
      historyMessages?: Array<{ content: unknown }>;
      recalledEntries?: Array<{ content: unknown }>;
    },
  ): Promise<ContextBudgetDecision> {
    const providerMaxContextTokens = await this.resolveProviderContextTokens(route);
    return this.contextBudgetBroker.decide({
      phase: "planning",
      scope: "main-agent",
      purpose: "assemble main prompt",
      model: route.model,
      modelMaxContextTokens: providerMaxContextTokens,
      configuredMaxContextTokens: this.resolveMaxContextTokens(),
      estimatedInputTokens: this.estimateInputTokens(input, extras),
      reserveOutputTokens: 4_096,
      inputShape: envelopeNeedsVision(input) ? "multimodal" : "text",
      policy: {
        trimAllowed: true,
        compressionAllowed: true,
        chunkingAllowed: false,
        degradeAllowed: true,
      },
    });
  }

 /**
 * sub-agent 预算决策走 ContextBudgetBroker。
 *
 * 替换 engine.ts 原 `Math.floor(maxContext * 0.5)` / `Math.floor(maxContext * 0.25)`
 * 的硬编码常量，让 sub-agent 也享受同一套 trimOrder / degrade / chunk 决策框架，
 * 并在事件流上 emit `context_budget` 事件（scope = "sub-agent"）。
 */
  private decideSubAgentBudget(
    route: ModelRoute,
    estimatedInputTokens: number,
    maxOutputTokens: number,
    providerMaxContextTokens?: number,
  ): ContextBudgetDecision {
    const configured = this.resolveMaxContextTokens();
    const modelMax =
      typeof providerMaxContextTokens === "number" && providerMaxContextTokens > 0
        ? providerMaxContextTokens
        : configured;
    return this.contextBudgetBroker.decide({
      phase: "execution",
      scope: "sub-agent",
      purpose: "dispatch sub-agent",
      model: route.model,
      modelMaxContextTokens: modelMax,
      configuredMaxContextTokens: configured,
      estimatedInputTokens,
      reserveOutputTokens: maxOutputTokens,
      inputShape: "text",
      policy: {
        trimAllowed: true,
        compressionAllowed: true,
        chunkingAllowed: false,
        degradeAllowed: true,
      },
    });
  }

 /**
 * `runtime.toolLoop.subagentDispatch.maxDepth` 的解析（默认 `1`，ADR-0006 D6）。
 *
 * 与 `AgentDescriptor.maxDepth` 取更小值后写入 `AgentRunConstraints.maxDepth`，
 * 防止某个 agent 描述符自行声明更大的 `maxDepth` 时突破全局深度闸门。
 */
  private resolveAgentDispatchMaxDepth(): number {
    const configured = this.config.runtime.toolLoop?.subagentDispatch?.maxDepth;
    return typeof configured === "number" && configured >= 0
      ? configured
      : DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH;
  }

 /**
 * Single-Writer Rule(ADR-0006 D6):sub-agent 只读，`allowedTools` 经本方法
 * 确定性过滤掉非 `readonly` 工具，写操作留给主 loop。
 *
 * fail-closed：registry 查不到的工具名（比如已被业务侧移除）一律排除，不能
 * 假定"未注册 = 只读"而放行。
 */
  private filterReadonlyToolNames(toolNames: readonly string[]): string[] {
    return toolNames.filter((name) => {
      const descriptor = this.registry.getLatest("tool", name);
      return descriptor !== null && descriptor.sideEffect === "readonly";
    });
  }

 /**
 * 为已派发的 sub-agent 组装其自身 `tool-use` loop 所需的 `ToolUseContext`
 * (被 `DefaultAgentRuntimeAdapter.toolUseContextFactory` 消费)。
 *
 * 除了原有的 prompt/tools 装配外，额外挂上 `dispatchAgent`/`agentDispatchDepth`
 * 闭包 —— 这样若 `runtime.toolLoop.subagentDispatch.maxDepth` 配置 > 1，
 * sub-agent 自身的 loop 仍可（在深度闸门允许范围内）继续派发下一层 sub-agent，
 * 复用同一套 `runSubAgent` 实现而非另起一套派发逻辑。
 */
  private buildSubAgentToolUseContext(
    invocation: AgentInvocation,
    signal: AbortSignal,
    executionContext: ExecutionContext,
  ): ToolUseContext {
    const toolDefs = (invocation.constraints.allowedTools ?? [])
      .map((name) => this.registry.getLatest("tool", name))
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    const prebuiltPrompt: AssembledPrompt = {
      messages: [
        {
          role: "system",
          content: `You are the "${invocation.agent.name}" sub-agent. ${invocation.agent.instructions}`,
        },
        {
          role: "user",
          content: `Objective:\n${invocation.objective}\n\nInput:\n${JSON.stringify(
            invocation.input,
            null,
            2,
          )}`,
        },
      ],
      tools: toolDefs,
      tokenCount: 0,
      appliedCuts: [],
      activeSkills: [],
    };
    const nestedDepth = invocation.constraints.currentDepth ?? 1;
    const dispatchAgent: AgentDispatchFn = async (params, dispatchSignal) => {
      const result = await this.runSubAgent(
        params.agentName,
        params.objective,
        params.input ?? {},
        executionContext,
        dispatchSignal,
        {
          taskId: `${invocation.id}:dispatch-agent:${params.agentName}:${Date.now()}`,
          currentDepth: nestedDepth + 1,
        },
      );
      return { ...result, agent: params.agentName };
    };
    return {
      config: this.config,
      providers: this.providers,
      modelRouter: this.modelRouter,
      memorySystem: this.memorySystem,
      observability: this.observability,
      registry: this.registry,
      taskExecutor: this.taskExecutor,
      executionContext,
      signal,
      adapterContext: adapterCallContextFromExecution(executionContext),
      prebuiltPrompt,
      agentRunId: invocation.id,
      hooks: this.hooks,
      dispatchAgent,
      agentDispatchDepth: nestedDepth,
    };
  }

 /**
 * sub-agent 派发的共享实现(ADR-0006 D6)。
 *
 * 两条调用路径共用本方法：
 * 1. `task.type === "agent"`(显式 `@agent` 提及，`tool-routing` phase 产出的
 *    确定性快路径，`currentDepth` 恒为 `1`)
 * 2. loop 内 LLM 自决调用内置 `dispatch_agent` 工具(ADR-0006 D6 本阶段新增，
 *    主 loop 派发时 `currentDepth` 同为 `1`；sub-agent 自身 loop 再次派发时递增)
 *
 * 统一保证：
 * - Single-Writer Rule：`allowedTools` 经 {@link filterReadonlyToolNames} 收窄
 * - maxDepth 闸门：`descriptor.maxDepth` 与 `resolveAgentDispatchMaxDepth()` 取更小值
 * - summary-only 契约：`DefaultAgentRuntimeAdapter` 只回 `terminalDraft` + evidence 摘要，
 *   不透传子 loop 全 transcript(现有实现已如此，本方法不改变该契约)
 * - `preSubagent`/`postSubagent` hook 无论走哪条路径都一致触发
 */
  private async runSubAgent(
    agentName: string,
    objective: string,
    input: Record<string, unknown>,
    context: ExecutionContext,
    signal: AbortSignal,
    opts: {
      taskId: string;
      currentDepth: number;
      structured?: AgentStructuredContext;
    },
  ): Promise<AgentRunResult> {
    const descriptor = this.registry.get("agent", agentName);
    if (!descriptor) {
      return {
        status: "failed",
        error: {
          code: "AGENT_DESCRIPTOR_NOT_FOUND",
          message: `Agent descriptor not found: ${agentName}`,
          retryable: false,
        },
      };
    }

 // preSubagent(ADR-0006 D2/D6):真正的 subagent 派发前置点。deny/abort 时
 // 短路,不真正 spawn,也不消耗 budget 决策。
    const preSubagentAction = await this.hooks.fire("preSubagent", {
      point: "preSubagent",
      timestamp: Date.now(),
      correlation: context.correlation,
      ...(context.subject !== undefined ? { subject: context.subject } : {}),
      data: { agent: descriptor.name, objective, taskId: opts.taskId },
    });
    if (preSubagentAction?.type === "deny" || preSubagentAction?.type === "abort") {
      return {
        status: "failed",
        error: {
          code: "AGENT_DISPATCH_DENIED",
          message: preSubagentAction.reason ?? "preSubagent hook 拒绝了本次 subagent 派发",
          retryable: false,
        },
      };
    }

    const router =
      this.activeRunModelRouters.get(context.correlation.traceId) ?? this.modelRouter;
    let route: ModelRoute;
    try {
      route = router.resolve("high-reasoning");
    } catch {
      route = router.resolve("fast-cheap");
    }
    const runtime =
      this.injectedAgentRuntime ??
      new DefaultAgentRuntimeAdapter({
        providers: this.providers,
        route,
        adapterContext: adapterCallContextFromExecution(context),
        toolUseExecutor: this.toolUseExecutor,
        toolUseContextFactory: (invocation, factorySignal, executionContext) =>
          this.buildSubAgentToolUseContext(invocation, factorySignal, executionContext),
      });

    const allowedTools = this.filterReadonlyToolNames(descriptor.availableTools ?? []);
 // sub-agent 预算走 Broker；去除硬编码 0.5/0.25 常量。
    const maxOutputTokens = 1_500;
    const estimatedSubAgentInput = Math.max(
      256,
      Math.ceil(
        (objective.length + JSON.stringify(input).length + (opts.structured ? 512 : 0)) / 4,
      ),
    );
    const subAgentBudget = this.decideSubAgentBudget(route, estimatedSubAgentInput, maxOutputTokens);
 // chunkingAllowed=false 已禁用 chunk；reject 时退回保守默认（最小可用预算）。
    const subAgentMaxInput =
      subAgentBudget.kind === "chunk" || subAgentBudget.kind === "reject"
        ? Math.max(512, Math.floor(this.resolveMaxContextTokens() / 2))
        : subAgentBudget.envelope.maxInputTokens;

    const invocation: AgentInvocation = {
      id: opts.taskId,
      agent: descriptor,
      objective,
      input,
      context: {
        scope: "sub-agent",
        parentTraceId: context.correlation.traceId,
        inherited: {
          tools: allowedTools,
          memory: "task-relevant",
          ...(opts.structured !== undefined ? { structured: opts.structured } : {}),
        },
        budget: {
          maxInputTokens: subAgentMaxInput,
          maxWorkingTokens: Math.max(256, Math.floor(subAgentMaxInput / 2)),
          maxOutputTokens,
        },
      },
      constraints: {
        maxDepth: Math.min(descriptor.maxDepth, this.resolveAgentDispatchMaxDepth()),
        timeoutMs: descriptor.timeout,
        allowedTools,
        currentDepth: opts.currentDepth,
      },
    };

    const result = await runtime.run(invocation, context, signal);

 // postSubagent(ADR-0006 D2/D6):subagent 收敛后置点,只读订阅/审计用途;
 // 不支持改写 result(summary-only 契约由 D6 的 runtime 自身保证)。
    await this.hooks.fire("postSubagent", {
      point: "postSubagent",
      timestamp: Date.now(),
      correlation: context.correlation,
      ...(context.subject !== undefined ? { subject: context.subject } : {}),
      data: { agent: descriptor.name, taskId: opts.taskId, status: result.status },
    });

    return result;
  }

 /**
 * 把任意结构的 `task.contextSlice` 解构成 `AgentStructuredContext`。
 *
 * 替换"整包 JSON.stringify 再塞进 previousResults"的反模式：
 * - 已知字段（instructions / evidence / rules / priorTurns）直接映射；
 * - 其余未知字段统一进 `evidence` 数组，保留信息不丢失；
 * - 非对象类型整体作为单条 evidence 入帐。
 */
  private decomposeAgentContextSlice(slice: unknown): AgentStructuredContext | undefined {
    if (slice === null || slice === undefined) {
      return undefined;
    }
    const toContextEvidence = (content: unknown, source: string): EvidenceEntry => ({
      source,
      content,
      producedBy: "host",
      purpose: "context",
    });
    const normalizeHostEvidence = (entry: unknown, index: number): EvidenceEntry => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const candidate = entry as Partial<EvidenceEntry>;
        if (
          typeof candidate.source === "string" &&
          candidate.producedBy !== undefined &&
          candidate.purpose !== undefined
        ) {
          return candidate as EvidenceEntry;
        }
      }
      return toContextEvidence(entry, `host:evidence:${index}`);
    };
    if (typeof slice !== "object") {
      return { evidence: [toContextEvidence(slice, "host:context-slice")] };
    }
    const known: AgentStructuredContext = {};
    const remainder: Record<string, unknown> = {};
    let hasRemainder = false;
    for (const [key, value] of Object.entries(slice as Record<string, unknown>)) {
      if (value === undefined) continue;
      switch (key) {
        case "instructions":
          if (Array.isArray(value)) {
            known.instructions = value.map((entry) => String(entry));
          } else if (typeof value === "string") {
            known.instructions = [value];
          } else {
            remainder[key] = value;
            hasRemainder = true;
          }
          break;
        case "evidence":
          known.evidence = Array.isArray(value)
            ? value.map((entry, index) => normalizeHostEvidence(entry, index))
            : [normalizeHostEvidence(value, 0)];
          break;
        case "rules":
          known.rules = Array.isArray(value) ? [...value] : [value];
          break;
        case "priorTurns":
          if (Array.isArray(value)) {
            known.priorTurns = value as readonly Message[];
          } else {
            remainder[key] = value;
            hasRemainder = true;
          }
          break;
        default:
          remainder[key] = value;
          hasRemainder = true;
      }
    }
    if (hasRemainder) {
      const baseEvidence = known.evidence ? [...known.evidence] : [];
      baseEvidence.push(toContextEvidence(remainder, "host:context-remainder"));
      known.evidence = baseEvidence;
    }
    return Object.keys(known).length > 0 ? known : undefined;
  }

  private buildSearchSkillsHandler(): (
    query: string,
    topK?: number,
  ) => Promise<Array<{ name: string; score: number; description: string }>> {
    return async (query, topK = 10) => {
      const normalized = query.toLowerCase();
      const hits = [];
      for (const skill of this.registry.list("skill")) {
        if (skill.deprecated === true) {
          continue;
        }
        const needles = [skill.name, skill.displayName, skill.description].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        for (const needle of needles) {
          if (normalized.includes(needle.toLowerCase())) {
            hits.push({
              name: skill.name,
              score: needle === skill.description ? 0.7 : 0.85,
              description: skill.description,
            });
            break;
          }
        }
      }
      return hits.sort((left, right) => right.score - left.score).slice(0, topK);
    };
  }

 /**
 * 暴露 MemorySystem 实例 —— 供宿主（CLI / 服务端）在需要时直接读写会话上下文。
 *
 * 典型使用场景：
 * - CLI `/history` / `/export` 命令：`engine.getMemorySystem().load(sid)` 读
 * `ContextWindow.entries` 展示历史
 * - CLI `/reset` `/clear` 命令：`engine.getMemorySystem().clear(sid)` 删文件+内存
 * - 外部组件 replay / 数据导出
 *
 * 生产场景一般不需要调用；内置 Phase 已负责 append / compress。返回实例的
 * 具体类型由 `EngineDependencies.memorySystem` 注入决定（默认 InMemory；
 * CLI 默认装配 FsMemorySystem 的持久化实现）。
 */
  getMemorySystem(): MemorySystem {
    return this.memorySystem;
  }

 /**
 * 把外部注入的 `memorySystem`（实例或 factory）解析为真实 MemorySystem。
 *
 * - 未注入：走 core 默认 `InMemoryMemorySystem`
 * - 注入函数：视作 factory，传入 Engine 内部依赖后调用得到实例
 * - 注入实例：直接使用
 *
 * 注意：`config.memory.persistence` 字段**不在 core 里被消费**——它是给外层
 * engine-factory / 宿主读取、并决定要不要传一个 FsMemorySystem factory 的
 * 协议位。core 只接受具体注入，不自行装配文件系统实现。
 */
  private resolveMemorySystem(injection: MemorySystemInjection | undefined): MemorySystem {
    if (injection === undefined) {
      return new InMemoryMemorySystem(
        this.config,
        this.tokenizer,
        this.modelRouter,
        this.providers,
        this.vectorStore,
      );
    }
    if (typeof injection === "function") {
      return injection({
        config: this.config,
        tokenizer: this.tokenizer,
        modelRouter: this.modelRouter,
        providers: this.providers,
        vectorStore: this.vectorStore,
      });
    }
    return injection;
  }

 /**
 * 本轮执行的长期记忆召回。
 *
 * 路径：`semanticRetrieval` + `memorySystem.loadFull()` — 语义搜索全量窗口条目。
 * 无 `semanticRetrieval` 时不召回。
 * 召回失败不阻塞主流程，返回空数组并通过 observability 事件告警。
 */
  private async recallForRun(
    input: InputEnvelope,
    sessionId: string,
    correlation: ExecutionCorrelation,
    subject?: ExecutionSubject | undefined,
  ): Promise<MemoryEntry[]> {
    const topK = this.config.memory.recallTopK ?? 5;
    if (topK <= 0) {
      return [];
    }
    const query = this.extractRecallQuery(input);
    if (query.length === 0) {
      return [];
    }
    if (!this.semanticRetrieval) {
      return [];
    }
    try {
      const corpus = await this.memorySystem.loadFull(sessionId);
      const corpusEntries = corpus.map((e) => ({ id: e.id, text: this.stringifyMemoryContent(e.content) }));
      const adapterCtx: AdapterCallContext = {
        correlation,
        ...(subject !== undefined ? { subject } : {}),
      };
      const result = await this.semanticRetrieval.retrieve(
        { caller: "memory", namespace: "recall", query, corpus: corpusEntries },
        adapterCtx,
      );
      const hits = result.hits.slice(0, topK);
      const hitIds = new Set(hits.map((h) => h.id));
      const recalled = corpus.filter((e) => hitIds.has(e.id));
      this.observability.emit({
        timestamp: Date.now(),
        correlation,
        ...(subject !== undefined ? { subject } : {}),
        phase: "prompt",
        type: "memory_recall",
        payload: { count: recalled.length, topK, strategy: "facade" },
      });
      return recalled;
    } catch (error) {
      this.observability.emit({
        timestamp: Date.now(),
        correlation,
        ...(subject !== undefined ? { subject } : {}),
        phase: "prompt",
        type: "memory_recall_failed",
        payload: {
          message: "memory recall failed; continuing without recalled entries",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return [];
    }
  }

 /**
 * 将记忆条目内容转为字符串，用于语义索引检索。
 */
  private stringifyMemoryContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .filter((s) => s.length > 0)
        .join("\n");
    }
    return JSON.stringify(content);
  }

 /**
 * 从 `InputEnvelope` 中提取用于向量召回的查询文本。
 *
 * - `text` → 直接使用
 * - `mixed`/`multimodal` → 取其中的 `text` 片段拼接
 * - `vector` → 无法字符串化，返回空串（由 recallForRun 判空后跳过召回）
 */
  private extractRecallQuery(input: InputEnvelope): string {
    const content: unknown = (input as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
          }
          return "";
        })
        .filter((segment) => segment.length > 0)
        .join("\n")
        .trim();
    }
    return "";
  }

  private pickTokenizerModel(): string {
    const mapping = this.config.models.capabilityMapping ?? {};
    const preferred = ["fast-cheap", "intent", "planning"];
    for (const tag of preferred) {
      const route = mapping[tag];
      if (route?.model) {
        return route.model;
      }
    }
    const first = Object.values(mapping)[0];
    if (first?.model) {
      return first.model;
    }
    return "gpt-4o-mini";
  }

  private buildPlaceholderTaskExecutor(): TaskExecutor {
    return async (task) => ({
      ok: true,
      output: {
        ref: task.ref,
        input: task.input,
        output: `[executed:${task.type}] ${task.ref}`,
      },
    });
  }

 /**
 * 构造"分层"TaskExecutor：先尝试命中内置 Sub-flow，未命中时回落到业务/占位 executor。
 *
 * 规则：
 * - `type === 'sub-flow'` 且 `ref` 命中 `InternalSubflowRegistry` → 执行内置 Sub-flow
 * - 其它情况 → 交给 `fallback`（业务自定义或占位 executor）处理
 *
 * 这样设计保证：
 * 1. 业务侧即便注入了只处理 `tool` 的 executor，
 * `tool-use` 仍能正确执行，不会整条 turn 失败
 * 2. 业务侧无需了解内置 Sub-flow 的存在，协议层自行兜底
 * 3. 内置 Sub-flow 的 context 由引擎集中装配，避免业务侧重复拼装依赖
 */
 /**
 * 对外暴露的 layered TaskExecutor 工厂。
 *
 * 业务侧（典型为 `@tachu/cli` 的 `buildTaskExecutor`、或宿主自己实现的 executor）
 * 可以用本 helper 把自身 TaskExecutor 包裹成"先尝试内置 Sub-flow，未命中再落到业务
 * executor"的两层结构，从而复用引擎内置的 `tool-use` 子流程。
 *
 * §决定4 承诺对外暴露这个 helper；详见 。
 *
 * @param fallback 业务自定义 TaskExecutor；当当前 task 不是引擎内置 Sub-flow 时转交执行
 */
  createLayeredTaskExecutor(fallback: TaskExecutor): TaskExecutor {
    return this.buildLayeredTaskExecutor(fallback);
  }

  private buildLayeredTaskExecutor(fallback: TaskExecutor): TaskExecutor {
    const internalSubflows = this.internalSubflows;
    return async (task, context, signal) => {
      if (task.type === "sub-flow" && internalSubflows.has(task.ref)) {
        const prebuiltPrompt = this.activeRunPrompts.get(context.correlation.traceId);
        const turnPolicy = this.activeRunTurnPolicies.get(context.correlation.traceId);
        const onProviderUsage = this.activeRunUsageSinks.get(context.correlation.traceId);
        const emitUsageTelemetry =
          this.activeRunUsageTelemetrySinks.get(context.correlation.traceId);
        const currentPhaseStepId =
          this.activeRunCurrentPhaseStepIds.get(context.correlation.traceId);
        const nextStreamId = this.activeRunIdFactories.get(context.correlation.traceId);
        const executionContext = this.activeRunExecutionContexts.get(context.correlation.traceId);
        const eventOutbox = this.activeRunEventOutbox.get(context.correlation.traceId);
        const toolCallSink = this.activeRunToolCallSinks.get(context.correlation.traceId);
        const deltaQueue = this.activeRunDeltaOutbox.get(context.correlation.traceId);
        const onToolLoopEvent = eventOutbox
          ? (chunk: StreamChunk): void => {
              eventOutbox.push(chunk);
              if (deltaQueue !== undefined && this.config.runtime.streamingOutput) {
                deltaQueue.enqueue(chunk);
              }
            }
          : undefined;
        const onToolCall = toolCallSink
          ? (record: ToolCallRecord): void => {
              toolCallSink.push(record);
            }
          : undefined;
        const onAssistantDelta =
          deltaQueue !== undefined && this.config.runtime.streamingOutput
            ? (text: string): void => {
                deltaQueue.enqueue(withStreamEnvelope({ type: "delta", content: text }, context));
              }
            : undefined;
 // reasoning 透传通道：与 onAssistantDelta 共用 DeltaStreamQueue，但
 // enqueue 的是 `reasoning-delta` 顶层 chunk；与正文 delta 解耦，不进
 // EngineOutput.content、不参与 MemorySystem.append。
        const onAssistantReasoningDelta =
          deltaQueue !== undefined && this.config.runtime.streamingOutput
            ? (text: string): void => {
                deltaQueue.enqueue(
                  withStreamEnvelope({ type: "reasoning-delta", content: text }, context),
                );
              }
            : undefined;
        const generatedImagesSink = this.activeRunGeneratedImages.get(context.correlation.traceId);
        const generatedMediaSink = this.activeRunGeneratedMedia.get(context.correlation.traceId);
        const toolLoopTiming = this.activeRunToolLoopTimingControls.get(context.correlation.traceId);
        const onGeneratedImages = generatedImagesSink
          ? (images: GeneratedImage[]): void => {
              for (const img of images) {
                generatedImagesSink.push(img);
              }
            }
          : undefined;
        const onGeneratedMedia = generatedMediaSink
          ? (media: GeneratedMedia[]): void => {
              for (const item of media) {
                generatedMediaSink.push(item);
              }
            }
          : undefined;
// dispatch_agent(ADR-0006 D6):主 loop 恒为深度 0，闭包内复用 runSubAgent
// (Single-Writer Rule 收窄 / preSubagent-postSubagent hook / budget 决策
// 与显式 `@agent` 派发完全一致)。深度闸门与「是否暴露该工具」的判断在
// tool-use.ts 侧做（未注册任何 agent 时不会出现在工具列表里）。
        const dispatchAgent: AgentDispatchFn = async (params, dispatchSignal) => {
          const dispatchResult = await this.runSubAgent(
            params.agentName,
            params.objective,
            params.input ?? {},
            context,
            dispatchSignal,
            {
              taskId: `${context.correlation.traceId}:dispatch-agent:${params.agentName}:${Date.now()}`,
              currentDepth: 1,
            },
          );
          return { ...dispatchResult, agent: params.agentName };
        };
        const output = await internalSubflows.execute(task.ref, task.input, {
          config: this.config,
          providers: this.providers,
// 优先使用本轮 effective router（含 SessionScope.modelOverride）；map 未命中时回退基础 router。
          modelRouter:
            this.activeRunModelRouters.get(context.correlation.traceId) ?? this.modelRouter,
          memorySystem: this.memorySystem,
          observability: this.observability,
          signal,
          adapterContext: adapterCallContextFromExecution(context),
          dispatchAgent,
          agentDispatchDepth: 0,
          ...(this.multimodalResolver !== undefined
            ? { multimodalResolver: this.multimodalResolver }
            : {}),
          ...(this.resourceDemandRouter !== undefined
            ? { resourceDemandRouter: this.resourceDemandRouter }
            : {}),
          ...(prebuiltPrompt !== undefined ? { prebuiltPrompt } : {}),
          ...(onProviderUsage !== undefined ? { onProviderUsage } : {}),
          ...(emitUsageTelemetry !== undefined ? { emitUsageTelemetry } : {}),
          ...(currentPhaseStepId !== undefined ? { currentPhaseStepId } : {}),
          ...(nextStreamId !== undefined ? { nextStreamId } : {}),
          registry: this.registry,
          taskExecutor: fallback,
          hooks: this.hooks,
          ...(executionContext !== undefined ? { executionContext } : {}),
          ...(onToolLoopEvent !== undefined ? { onToolLoopEvent } : {}),
          ...(onToolCall !== undefined ? { onToolCall } : {}),
          ...(onAssistantDelta !== undefined ? { onAssistantDelta } : {}),
          ...(onAssistantReasoningDelta !== undefined
            ? { onAssistantReasoningDelta }
            : {}),
          ...(onGeneratedImages !== undefined ? { onGeneratedImages } : {}),
          ...(onGeneratedMedia !== undefined ? { onGeneratedMedia } : {}),
          ...(toolLoopTiming !== undefined ? toolLoopTiming : {}),
          ...(this.onBeforeToolCall !== undefined
            ? { onBeforeToolCall: this.onBeforeToolCall }
            : {}),
          sessionManager: this.sessionManager,
          stickyManager: this.stickyManager,
          ...(this.config.runtime.enableSearchSkillsTool === true
            ? { searchSkills: this.buildSearchSkillsHandler() }
            : {}),
          ...(turnPolicy !== undefined ? { turnPolicy } : {}),
        });
        return { ok: true, output };
      }
      if (task.type === "agent") {
// 用结构化 envelope 替代 JSON.stringify(task.contextSlice)。
        const structured = this.decomposeAgentContextSlice(task.contextSlice);
        const objective =
          typeof task.input.objective === "string"
            ? task.input.objective
            : typeof task.input.prompt === "string"
              ? task.input.prompt
              : (this.registry.get("agent", task.ref)?.description ?? "");
// main Engine 显式 `@agent` 派发总是首层，depth=1；实现细节（Single-Writer
// Rule 收窄、preSubagent/postSubagent hook、budget 决策）均由 runSubAgent
// 统一承担，与 loop 内 `dispatch_agent` 工具触发的派发共用同一份逻辑。
        const result = await this.runSubAgent(
          task.ref,
          objective,
          task.input,
          context,
          signal,
          {
            taskId: task.id,
            currentDepth: 1,
            ...(structured !== undefined ? { structured } : {}),
          },
        );
        if (result.status === "completed") {
          return {
            ok: true,
            output: {
              kind: "agent-run-result",
              agent: task.ref,
              status: result.status,
              output: result.output,
              evidence: result.evidence ?? [],
              usage: result.usage,
            },
          };
        }
        if (result.status === "cancelled") {
          return {
            ok: false,
            error: {
              code: "AGENT_CANCELLED",
              message: result.reason,
              retryable: true,
              source: "scheduler",
            },
          };
        }
        return {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            source: "scheduler",
          },
        };
      }
      return fallback(task, context, signal);
    };
  }

 /**
 * 非流式执行入口。
 *
 * @param input 标准化输入信封
 * @param context 执行上下文
 * @returns 引擎最终输出
 * @throws EngineError 当执行阶段出现规范化错误时抛出
 */
  async run(
    input: InputEnvelope,
    context: ExecutionContext,
    scope?: SessionScope,
  ): Promise<EngineOutput> {
    let output: EngineOutput | undefined;
    for await (const chunk of this.runStream(input, context, scope)) {
      if (chunk.type === "done") {
        output = chunk.output;
      }
      if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    if (!output) {
      throw new Error("engine finished without output");
    }
    return output;
  }

 /**
 * 流式执行入口。
 *
 * @param input 标准化输入信封
 * @param context 执行上下文
 * @returns 按阶段和结果持续产出的流式块
 * @throws Error 当引擎已 dispose 时抛出
 */
  async *runStream(
    input: InputEnvelope,
    context: ExecutionContext,
    scope?: SessionScope,
  ): AsyncIterable<StreamChunk> {
    this.ensureAvailable();
    assertCompleteExecutionCorrelation(context.correlation);
    const normalizedContext: ExecutionContext = {
      ...context,
      startedAt: context.startedAt ?? Date.now(),
      budget: {
        ...context.budget,
      },
    };

    await this.sessionManager.resolve(normalizedContext.correlation.sessionId);
    const runHandle = this.sessionManager.beginRun(
      normalizedContext.correlation.sessionId,
      normalizedContext.correlation.requestId,
    );
    const activeSignal = runHandle.signal;

    const toolCalls: OutputMetadata["toolCalls"] = [];
    const startTs = Date.now();
    const orchestrator = new ExecutionOrchestrator(this.config);
    const nextStreamId =
      scope?.idFactory ??
      (() => {
        let sequence = 0;
        return (): string => `${normalizedContext.correlation.traceId}:stream:${++sequence}`;
      })();
    const phaseStepIds = new Map<EnginePhase, string>();
    const usageSnapshots = new Map<string, LlmUsageTelemetryEvent>();
    const pendingUsageTelemetry: StreamChunk[] = [];
    const emitUsageTelemetry: EmitLlmUsageTelemetry = (event) => {
      usageSnapshots.set(event.attribution.id, event);
      const cumulative = [...usageSnapshots.values()].reduce(
        (acc, item) => ({
          input: acc.input + item.usage.input,
          output: acc.output + item.usage.output,
          total: acc.total + item.usage.total,
        }),
        { input: 0, output: 0, total: 0 },
      );
      const usage = orchestrator.getUsage();
      const chunk: StreamChunk = withStreamEnvelope(
        {
          type: "usage",
          tokens: cumulative.total,
          toolCalls: usage.toolCalls,
          wallTimeMs: usage.wallTimeMs,
          usage: event.usage,
          cumulative,
          attribution: event.attribution,
          accuracy: event.accuracy,
          ...(event.terminal !== undefined ? { terminal: event.terminal } : {}),
        },
        normalizedContext,
      );
      const deltaQueue = this.activeRunDeltaOutbox.get(normalizedContext.correlation.traceId);
      if (deltaQueue !== undefined) {
        deltaQueue.enqueue(chunk);
      } else {
        pendingUsageTelemetry.push(chunk);
      }
    };
    const flushPendingUsageTelemetry = function* (): Iterable<StreamChunk> {
      while (pendingUsageTelemetry.length > 0) {
        const chunk = pendingUsageTelemetry.shift();
        if (chunk !== undefined) {
          yield chunk;
        }
      }
    };

 // ：把各阶段 Provider.chat 返回的真实 usage 汇回 orchestrator，
 // 保证预算熔断、可观测事件均基于真值而非 Prompt 估算值。
 // `cachedPromptTokens` 由 OpenAI / Anthropic adapter 在命中 prompt caching 时携带，
 // 主路径仅累计、不参与预算熔断（避免把命中量当折扣后的预算下放）。
    const usageSink = (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedPromptTokens?: number;
    }): void => {
      orchestrator.recordModelUsage(
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedPromptTokens ?? 0,
      );
    };
    this.activeRunUsageSinks.set(normalizedContext.correlation.traceId, usageSink);
    this.activeRunUsageTelemetrySinks.set(
      normalizedContext.correlation.traceId,
      emitUsageTelemetry,
    );
    this.activeRunIdFactories.set(normalizedContext.correlation.traceId, nextStreamId);
    this.activeRunExecutionContexts.set(normalizedContext.correlation.traceId, normalizedContext);
 // `tool-use` 子流程预留事件 / 工具调用 outbox；
 // execution 阶段结束后主干 flush 到 yield 流与 metadata。
    const toolLoopEventOutbox: StreamChunk[] = [];
    const toolLoopToolCalls: ToolCallRecord[] = [];
    this.activeRunEventOutbox.set(normalizedContext.correlation.traceId, toolLoopEventOutbox);
    this.activeRunToolCallSinks.set(normalizedContext.correlation.traceId, toolLoopToolCalls);
    const generatedImagesBucket: GeneratedImage[] = [];
    const generatedMediaBucket: GeneratedMedia[] = [];
    this.activeRunGeneratedImages.set(normalizedContext.correlation.traceId, generatedImagesBucket);
    this.activeRunGeneratedMedia.set(normalizedContext.correlation.traceId, generatedMediaBucket);
    this.activeRunToolLoopTimingControls.set(normalizedContext.correlation.traceId, {
      onToolLoopActiveStart: () => orchestrator.beginToolLoopActiveTimer(),
      onToolLoopActiveEnd: () => orchestrator.endToolLoopActiveTimer(),
      onUserBlockingStart: () => orchestrator.beginUserBlocking(),
      onUserBlockingEnd: () => orchestrator.endUserBlocking(),
    });

    const adapterContext = adapterCallContextFromExecution(normalizedContext);
 // SessionScope.modelOverride 在本轮内覆盖 capabilityMapping；未提供时直接返回原 router。
    const effectiveRouter = applyModelOverride(this.modelRouter, scope?.modelOverride);
    this.activeRunModelRouters.set(normalizedContext.correlation.traceId, effectiveRouter);
    const phaseEnv: PhaseEnvironment = {
      config: this.config,
      registry: this.registry as DescriptorRegistry,
      sessionManager: this.sessionManager,
      memorySystem: this.memorySystem,
      runtimeState: this.runtimeState,
      modelRouter: effectiveRouter,
      providers: this.providers,
      safetyModule: this.safetyModule,
      observability: this.observability,
      hooks: this.hooks,
      scheduler: this.scheduler,
      activeAbortSignal: activeSignal,
      adapterContext,
      onProviderUsage: usageSink,
      emitUsageTelemetry,
      nextStreamId,
      toolActivator: this.toolActivator,
      ...(this.semanticRetrieval !== undefined
        ? { semanticRetrieval: this.semanticRetrieval }
        : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(this.multimodalResolver !== undefined
        ? { multimodalResolver: this.multimodalResolver }
        : {}),
      ...(this.resourceDemandRouter !== undefined
        ? { resourceDemandRouter: this.resourceDemandRouter }
        : {}),
    };

    const enterPhase = (phase: EnginePhase): Iterable<StreamChunk> => {
      const stepId = nextStreamId();
      phaseStepIds.set(phase, stepId);
      phaseEnv.currentPhaseStepId = stepId;
      this.activeRunCurrentPhaseStepIds.set(normalizedContext.correlation.traceId, stepId);
      return this.emitPhaseStart(phase, normalizedContext, stepId);
    };
    const exitPhase = (phase: EnginePhase): Iterable<StreamChunk> => {
      const stepId = phaseStepIds.get(phase);
      phaseEnv.currentPhaseStepId = undefined;
      this.activeRunCurrentPhaseStepIds.delete(normalizedContext.correlation.traceId);
      return this.emitPhaseEnd(phase, normalizedContext, stepId);
    };

    try {
 // turnStart guardrail 的 annotate/degrade 前缀说明(ADR-0006 D4)，
 // 待 runOutputPhase 返回后前缀拼接到最终 content，与 contextBudgetDegradeReason 同模式。
      let turnStartGuardAnnotation: string | undefined;
// turnStart(ADR-0006 D2):一轮开始的 pre-guard 挂载点，提供真实 fire 位 +
// free-mutation/deny 语义;`SafetyModule` baseline 归位为默认 guard(见下方
// runSafetyPhase 之后的 turnStartGuardDecision 块,ADR-0006 D4)。
      const turnStartAction = await this.hooks.fire("turnStart", {
        point: "turnStart",
        timestamp: Date.now(),
        correlation: normalizedContext.correlation,
        ...(normalizedContext.subject !== undefined
          ? { subject: normalizedContext.subject }
          : {}),
        data: { input },
      });
      if (turnStartAction?.type === "deny" || turnStartAction?.type === "abort") {
        throw EngineError.fromUnknown(
          new Error(turnStartAction.reason ?? "turnStart hook 拒绝了本轮请求"),
          "HOOK_EXECUTION_FAILED",
        );
      }
      if (turnStartAction?.type === "modify" || turnStartAction?.type === "replace") {
        const candidate =
          turnStartAction.type === "modify" ? turnStartAction.patch : turnStartAction.data;
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "content" in candidate &&
          "metadata" in candidate
        ) {
          input = candidate as InputEnvelope;
        }
      }

      yield* enterPhase("session");
      const sessionState = await runSessionPhase(input, normalizedContext, phaseEnv);
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("session");

 // 取消旧的整轮短路探针。运行时取不到资源 → 在 Provider 边界
 // 物化时做对话内部分降级（第一层）；缺 resolver 但有待物化引用 → 物化期
 // fail-fast（第三层）。此处不再预探测、不再整轮降级。

      yield* enterPhase("safety");
      const safetyState = await runSafetyPhase(sessionState.input, sessionState.context, phaseEnv);
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("safety");

// turnStart guardrail(ADR-0006 D4):内置默认 guard = SafetyModule baseline +
// business policy(scope=turnStart)。`builtin.safety-violations` 把此前
// 计算后从未被消费的 `safetyState.violations` 映射为 annotate/degrade,
// 不再静默丢弃;host 通过 `EngineDependencies.guardrails.turnStart` 追加的
// guard 在其后按顺序执行,恒 fail-closed(任一 block 立即中止整轮)。
      const turnStartGuardDecision = await runGuardrails(
        [createSafetyViolationsGuardrail(safetyState.violations), ...this.guardrails.turnStart],
        {
          point: "turnStart",
          correlation: normalizedContext.correlation,
          ...(normalizedContext.subject !== undefined
            ? { subject: normalizedContext.subject }
            : {}),
          data: {
            input: safetyState.input,
            context: safetyState.context,
            violations: safetyState.violations,
          },
        },
      );
      if (turnStartGuardDecision.kind === "block") {
        throw EngineError.fromUnknown(
          new Error(
            turnStartGuardDecision.userVisibleReason ?? turnStartGuardDecision.reason,
          ),
          "HOOK_EXECUTION_FAILED",
        );
      }
      if (turnStartGuardDecision.kind === "annotate") {
        turnStartGuardAnnotation = turnStartGuardDecision.prefix;
      } else if (turnStartGuardDecision.kind === "degrade") {
        turnStartGuardAnnotation = turnStartGuardDecision.userVisibleReason;
      }

// Turn-level retry loop. ValidationPhase 输出 `outcome.kind === "retry"`
 // 时回到 tool-routing 重新执行；受 runtime.maxTurnRetries 与 decideTurnRetry 反死循环约束。
 // 默认 maxTurnRetries=0 时本 do-while 仅执行一次，等价于先前的线性 planning→output。
      const maxTurnRetries = this.config.runtime.maxTurnRetries ?? 0;
      let turnAttemptCount = 0;
      const previousOutcomeKinds: string[] = [];
      let validationState!: ValidationPhaseOutput;
      let shouldRetryTurn: boolean;
 // 捕获 context-budget degrade 的 userVisibleReason，
 // 待 runOutputPhase 返回后前缀拼接到最终 content。Hoisted at turn scope so each
 // retry attempt overwrites and the final attempt's value reaches OutputPhase.
      let contextBudgetDegradeReason: string | undefined;
      let effectiveInput = safetyState.input;
      let toolRoutingState!: Awaited<ReturnType<typeof runToolRoutingPhase>>;
      do {
        shouldRetryTurn = false;
 // 每轮重试前清空本轮累积的 tool-loop 事件 / 工具调用记录与生成产物，
 // 保证最终 OutputPhase 只看到"最后一次成功 attempt"的证据，避免污染。
        if (turnAttemptCount > 0) {
          toolCalls.length = 0;
          toolLoopEventOutbox.length = 0;
          toolLoopToolCalls.length = 0;
          generatedImagesBucket.length = 0;
          generatedMediaBucket.length = 0;
        }

// 深单 loop 塌陷(ADR-0006 D1):原 intent 分类 phase + precheck phase 的
// LLM 猜测已删除,`runToolRoutingPhase` 用确定性规则(turnPolicy 规范化 +
// 显式 @agent/@tool 名称匹配 + visibleTools 收窄)一次性替代四个死 phase 点
// (intent / precheck / planning / graph-check)。放在重试循环内部重新计算,
// 使 `phaseEnv.previousAttempt`(由上一轮 validation 写入)在 retry 时仍能被
// 观测事件消费,即便路由本身是确定性、结果不因重试而改变。
      yield* enterPhase("tool-routing");
      toolRoutingState = await runToolRoutingPhase(safetyState, phaseEnv);
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("tool-routing");

 /** tool-routing 阶段写入 turnPolicy 等 metadata；装配 Prompt 须与之后各阶段共用同一条 input。 */
      effectiveInput = toolRoutingState.input;
      this.activeRunTurnPolicies.set(
        normalizedContext.correlation.traceId,
        readTurnPolicy(effectiveInput),
      );

      if (this.config.runtime.planMode) {
        yield withStreamEnvelope(
          { type: "plan-preview", phase: "tool-routing", route: toolRoutingState.route },
          normalizedContext,
        );
// planMode 的计划审批曾挂在死点 `afterPlanning`;塌陷为深单 loop 后
// (ADR-0006 D1)该 gate 语义上就是"loop 首次调用 LLM 前的最后一次审批",
// 故归位到 `preLLM`。
        const action = await this.hooks.fire("preLLM", {
          point: "preLLM",
          timestamp: Date.now(),
          correlation: normalizedContext.correlation,
          ...(normalizedContext.subject !== undefined
            ? { subject: normalizedContext.subject }
            : {}),
          data: toolRoutingState.route,
        });
        if (action?.type === "deny" || action?.type === "abort") {
          throw EngineError.fromUnknown(
            new Error(action.reason ?? "preLLM hook 拒绝了当前计划"),
            "HOOK_EXECUTION_FAILED",
          );
        }
      }

      const distributed = this.contextDistributor.distribute(
        {
          rules: this.registry.list("rule"),
          constraints: this.config.safety,
          taskResults: {},
        },
        toolRoutingState.route.tasks,
        toolRoutingState.route.edges,
      );
      toolRoutingState.route.tasks.forEach((task) => {
        task.contextSlice = distributed.get(task.id);
      });

      let route = effectiveRouter.resolve("intent");
      if (envelopeNeedsVision(effectiveInput)) {
        try {
          route = effectiveRouter.resolve("vision");
        } catch {
          /* `vision` 未配置 */
        }
      }
      const recalledEntries = await this.recallForRun(
          effectiveInput,
          normalizedContext.correlation.sessionId,
          normalizedContext.correlation,
          normalizedContext.subject,
        );
 // 先加载 contextWindow，让 broker 决策时拿到完整的输入估算
 // （历史 + recall + 当前输入），避免低估导致漏触发 trim/compress/degrade。
        const contextWindow = await this.memorySystem.load(
          normalizedContext.correlation.sessionId,
          adapterContext,
        );
        const contextBudget = await this.decideMainContextBudget(effectiveInput, route, {
          historyMessages: contextWindow.entries,
          recalledEntries,
        });
        if (contextBudget.kind === "reject") {
          throw ValidationError.promptTooLarge(
            contextBudget.audit.estimatedInputTokens,
            Math.max(
              1,
              contextBudget.audit.maxContextTokens -
                contextBudget.audit.reserveOutputTokens,
            ),
          );
        }
        if (contextBudget.kind === "degrade") {
          contextBudgetDegradeReason = contextBudget.userVisibleReason;
        }
        const contextEnvelope =
          contextBudget.kind === "chunk"
            ? undefined
            : contextBudget.envelope;
 // 发出 context_budget 事件覆盖所有非 reject 决策。
 // chunk 决策当前 schema 不含 envelope/audit（仅 strategy），
 // 故 payload 仅含 decision 与 strategy；待增补 chunk audit 后再扩展。
        if (contextEnvelope !== undefined) {
          this.observability.emit(
            engineEventFromContext(normalizedContext, {
              timestamp: Date.now(),
              phase: "prompt",
              type: "context_budget",
              payload: {
                decision: contextBudget.kind,
                ...contextEnvelope.audit,
 // degrade 决策必须把 userVisibleReason 透传到事件流，
 // host 据此决定是否在最终答复前缀追加降级说明。
                ...(contextBudget.kind === "degrade"
                  ? { userVisibleReason: contextBudget.userVisibleReason }
                  : {}),
              },
            }),
          );
        } else if (contextBudget.kind === "chunk") {
          this.observability.emit(
            engineEventFromContext(normalizedContext, {
              timestamp: Date.now(),
              phase: "prompt",
              type: "context_budget",
              payload: {
                decision: "chunk",
                strategy: contextBudget.strategy,
              },
            }),
          );
        }
        const promptMaxContextTokens =
          contextEnvelope !== undefined
            ? contextEnvelope.maxInputTokens + contextEnvelope.reserveOutputTokens
            : this.resolveMaxContextTokens();
        const reserveOutputTokens =
          contextEnvelope !== undefined ? contextEnvelope.reserveOutputTokens : 4_096;
        const resolvedSkills = await resolveRunSkills({
          config: this.config,
          registry: this.registry,
          sessionManager: this.sessionManager,
          stickyManager: this.stickyManager,
          sessionId: normalizedContext.correlation.sessionId,
          currentInput: effectiveInput,
          contextWindow,
          adapterContext,
          ...(scope !== undefined ? { scope } : {}),
          observability: this.observability,
          tokenizer: this.tokenizer,
          maxContextTokens: promptMaxContextTokens,
          signal: activeSignal,
          pinningStrategies: this.pinningStrategies,
          candidateStrategies: this.candidateStrategies,
          ...(this.semanticRetrieval !== undefined
            ? { semanticRetrieval: this.semanticRetrieval }
            : {}),
        });
        const assembled = await this.promptAssembler.assemble({
          model: route.model,
          tokenizer: this.tokenizer,
          modelCapabilities: {
            supportedModalities: envelopeNeedsVision(effectiveInput) ? ["text", "image"] : ["text"],
            maxContextTokens: promptMaxContextTokens,
            supportsFunctionCalling: true,
            supportsStreaming: true,
          },
          reserveOutputTokens,
          currentInput: effectiveInput,
          activeRules: [
            ...this.registry.list("rule"),
            ...(scope?.additionalRules ?? []),
          ],
          activeSkills: resolvedSkills.activeSkills,
          availableSkills: resolvedSkills.availableSkills,
          skillSimilarityMap: resolvedSkills.skillSimilarityMap,
          stickySkillNames: resolvedSkills.stickySkillNames,
          alwaysSkillNames: resolvedSkills.alwaysSkillNames,
          skillBudget: this.config.runtime.skillBudget ?? 0.8,
          availableTools: [
            ...this.registry.list("tool"),
            ...(scope?.additionalTools ?? []),
          ],
          contextWindow,
          recalledEntries: recalledEntries.map((entry) => ({
            content:
              typeof entry.content === "string"
                ? entry.content
                : JSON.stringify(entry.content),
          })),
 // 把 broker 决定的裁剪优先级序列下推给 assembler，
 // 让真正的剥离顺序与 broker audit 保持一致；chunk 决策无 envelope 时跳过。
          ...(contextEnvelope !== undefined
            ? { trimOrder: contextEnvelope.trimOrder }
            : {}),
          ...(scope?.systemInstruction !== undefined
            ? { systemInstruction: scope.systemInstruction }
            : {}),
          ...(scope?.explicitRuleNames !== undefined
            ? { explicitRuleNames: scope.explicitRuleNames }
            : {}),
        });
        assembled.tools = mergeInternalToolDefinitions(assembled.tools, {
          enableSearchSkills: this.config.runtime.enableSearchSkillsTool === true,
        });
        this.activeRunPrompts.set(normalizedContext.correlation.traceId, assembled);

      yield* enterPhase("execution");

      let executionState: Awaited<ReturnType<typeof runExecutionPhase>>;
      if (this.config.runtime.streamingOutput) {
        const deltaQueue = new DeltaStreamQueue();
        this.activeRunDeltaOutbox.set(normalizedContext.correlation.traceId, deltaQueue);
        const execPromise = runExecutionPhase(
          toolRoutingState,
          phaseEnv,
          ({ taskId, taskType, taskRef, status, output, error }) => {
            if (taskType === "tool" && status === "completed") {
              toolCalls.push({
                callId: taskId,
                tool: taskRef,
                durationMs: 0,
                success: true,
                source: "tool",
              });
              if (output && typeof output === "object") {
                orchestrator.recordToolCall();
                enqueueUsageChunk(deltaQueue, orchestrator, normalizedContext);
              }
            }
            if (taskType === "tool" && status === "failed") {
              toolCalls.push({
                callId: taskId,
                tool: taskRef,
                durationMs: 0,
                success: false,
                source: "tool",
                error: {
                  code: error?.code ?? "TASK_FAILED",
                  message: error?.message ?? "Task failed",
                  retryable: error?.retryable ?? false,
                },
              });
            }
            if (output !== undefined) {
              this.observability.emit(
                engineEventFromContext(normalizedContext, {
                  timestamp: Date.now(),
                  phase: "execution",
                  type: "tool_call_end",
                  payload: { taskId, taskType, taskRef, status },
                }),
              );
            }
          },
        ).finally(() => {
          deltaQueue.enqueue(DELTA_STREAM_END);
        });

        while (true) {
          const item = await deltaQueue.dequeue();
          if (item === DELTA_STREAM_END) {
            break;
          }
          yield item;
        }
        executionState = await execPromise;
      } else {
        executionState = await runExecutionPhase(
          toolRoutingState,
          phaseEnv,
          ({ taskId, taskType, taskRef, status, output, error }) => {
            if (taskType === "tool" && status === "completed") {
              toolCalls.push({
                callId: taskId,
                tool: taskRef,
                durationMs: 0,
                success: true,
                source: "tool",
              });
              if (output && typeof output === "object") {
                orchestrator.recordToolCall();
              }
            }
            if (taskType === "tool" && status === "failed") {
              toolCalls.push({
                callId: taskId,
                tool: taskRef,
                durationMs: 0,
                success: false,
                source: "tool",
                error: {
                  code: error?.code ?? "TASK_FAILED",
                  message: error?.message ?? "Task failed",
                  retryable: error?.retryable ?? false,
                },
              });
            }
            if (output !== undefined) {
              this.observability.emit(
                engineEventFromContext(normalizedContext, {
                  timestamp: Date.now(),
                  phase: "execution",
                  type: "tool_call_end",
                  payload: { taskId, taskType, taskRef, status },
                }),
              );
            }
          },
        );
      }

      for (const step of executionState.steps) {
        yield withStreamEnvelope(
          {
            type: "progress",
            phase: "execution",
            message: `${step.name}: ${step.status}`,
          },
          normalizedContext,
        );
      }
 // streaming 模式在这里批量发出 loop/tool 事件；streaming
 // 模式下事件已实时进入 DeltaStreamQueue，这里只补发 seal 阶段新增的闭合块。
      for (const chunk of collectToolLoopChunksForTerminalFlush(
        toolLoopEventOutbox,
        this.config.runtime.streamingOutput === true,
        normalizedContext,
      )) {
        yield chunk;
      }
 // 同步 tool-use 子流程记录的工具调用元数据到主干 metadata。
      for (const record of toolLoopToolCalls) {
        toolCalls.push(record);
        if (record.success) {
          orchestrator.recordToolCall();
        }
      }
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("execution");

      const candidateState = await runCandidateAnswerPhase(executionState, phaseEnv);

 // 结果验证对所有请求统一执行(ADR-0006 塌陷为深单 loop 后，唯一路径是
 // `tool-use`；零工具调用的纯文本答复由 loop step-1 自然产出，validation
 // 退化为"步骤成功 → 通过"的确定性判断)。
      yield* enterPhase("validation");
      validationState = await runValidationPhase(
        candidateState,
        phaseEnv,
        this.validationRuleRegistry,
        this.semanticJudge,
      );
      const validationOutcome = validationState.validation.outcome;
      if (validationOutcome !== undefined) {
        const event = validationOutcomeToEvent(validationOutcome, Date.now());
        if (event !== null) {
 // 5 种 outcome 在 helper 内集中映射事件，避免 engine.ts 分支漂移。
          this.observability.emit(engineEventFromContext(normalizedContext, event));
        }
 // 由 decideTurnRetry 决定是否回到 tool-routing 重新执行。
        if (maxTurnRetries > 0) {
          const decision = decideTurnRetry({
            outcome: validationOutcome,
            retryCount: turnAttemptCount,
            maxRetries: maxTurnRetries,
            previousOutcomeKinds,
          });
          this.observability.emit(
            engineEventFromContext(normalizedContext, {
              timestamp: Date.now(),
              phase: "validation",
              type: "warning",
              payload: {
                turnRetryDecision: decision.kind,
                reason: decision.reason,
                attempt: turnAttemptCount,
                maxTurnRetries,
              },
            }),
          );
          if (decision.kind === "continue") {
            previousOutcomeKinds.push(validationOutcome.kind);
            turnAttemptCount = decision.nextRetryCount;
            shouldRetryTurn = true;
 // 把上一轮 outcome 摘要写入 PhaseEnvironment，
 // 供下一轮 PlanningPhase emit + planner 候选策略消费。
            phaseEnv.previousAttempt = {
              retryCount: turnAttemptCount,
              lastOutcomeKind: validationOutcome.kind,
              target:
                validationOutcome.kind === "retry"
                  ? validationOutcome.target
                  : undefined,
              reason: decision.reason,
              diagnosis: validationState.validation.diagnosis?.reason,
            };
          }
        }
      }
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("validation");
      } while (shouldRetryTurn);

// turnStop(ADR-0006 D2/D4):一轮结束前的 post-guard 挂载点,恒最后跑、
// fail-closed。默认 Result Validation guard 的归位是 Stage 3(C3b)的工作;
// 本阶段先提供真实 fire 位 + deny(拒绝交付)/modify|replace(改写最终文案,
// 如 degrade/annotate 类用法)的通用语义。
      const turnStopAction = await this.hooks.fire("turnStop", {
        point: "turnStop",
        timestamp: Date.now(),
        correlation: normalizedContext.correlation,
        ...(normalizedContext.subject !== undefined
          ? { subject: normalizedContext.subject }
          : {}),
        data: {
          candidateAnswer: validationState.candidateAnswer,
          validation: validationState.validation,
        },
      });
      if (turnStopAction?.type === "deny" || turnStopAction?.type === "abort") {
        throw EngineError.fromUnknown(
          new Error(turnStopAction.reason ?? "turnStop hook 拒绝了本轮交付"),
          "HOOK_EXECUTION_FAILED",
        );
      }
      if (
        (turnStopAction?.type === "modify" || turnStopAction?.type === "replace") &&
        validationState.candidateAnswer !== undefined
      ) {
        const candidate =
          turnStopAction.type === "modify" ? turnStopAction.patch : turnStopAction.data;
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          typeof (candidate as { content?: unknown }).content === "string"
        ) {
          validationState.candidateAnswer = {
            ...validationState.candidateAnswer,
            content: (candidate as { content: string }).content,
          };
        }
      }

// turnStop guardrail(ADR-0006 D4):宿主通过 `EngineDependencies.guardrails.turnStop`
// 注入的对称守卫,在 raw HookAction 之后按 pass/block/degrade/annotate 语义执行。
// 内置默认 Result Validation guard 不在此重复接入 —— `runOutputPhase` 已经按
// `outcome.kind` 做 content 选取(pass/degrade/handoff 的正文分支已在 output.ts
// 落地),此处再叠加会造成双重降级前缀;`createResultValidationGuardrail` 仍作为
// 可复用工具导出，供自定义 Engine 组装或测试使用。
      if (this.guardrails.turnStop.length > 0) {
        const turnStopGuardDecision = await runGuardrails(this.guardrails.turnStop, {
          point: "turnStop",
          correlation: normalizedContext.correlation,
          ...(normalizedContext.subject !== undefined
            ? { subject: normalizedContext.subject }
            : {}),
          data: {
            candidateAnswer: validationState.candidateAnswer,
            validation: validationState.validation,
          },
        });
        if (turnStopGuardDecision.kind === "block") {
          throw EngineError.fromUnknown(
            new Error(
              turnStopGuardDecision.userVisibleReason ?? turnStopGuardDecision.reason,
            ),
            "HOOK_EXECUTION_FAILED",
          );
        }
        if (
          (turnStopGuardDecision.kind === "degrade" ||
            turnStopGuardDecision.kind === "annotate") &&
          validationState.candidateAnswer !== undefined
        ) {
          const prefix =
            turnStopGuardDecision.kind === "degrade"
              ? `[${turnStopGuardDecision.userVisibleReason}]\n\n`
              : `[${turnStopGuardDecision.prefix}]\n\n`;
          if (!validationState.candidateAnswer.content.startsWith(prefix)) {
            validationState.candidateAnswer = {
              ...validationState.candidateAnswer,
              content: `${prefix}${validationState.candidateAnswer.content}`,
            };
          }
        }
      }

      yield* enterPhase("output");
      const usage = orchestrator.getUsage();
      const outputMetadata = applyTurnOutcome(
        {
          toolCalls,
          durationMs: Date.now() - startTs,
          tokenUsage: {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.tokens,
            ...(usage.cachedPromptTokens > 0
              ? { cached: usage.cachedPromptTokens }
              : {}),
          },
          ...(generatedImagesBucket.length > 0
            ? { generatedImages: generatedImagesBucket.slice() }
            : {}),
          ...(generatedMediaBucket.length > 0
            ? { generatedMedia: generatedMediaBucket.slice() }
            : {}),
        },
        {
          validationPassed: isValidationPassing(validationState.validation),
          steps: validationState.steps,
          toolCalls,
        },
      );
      const output = await runOutputPhase(validationState, phaseEnv, outputMetadata);
// 当 ContextBudgetBroker 决策为 degrade 时，把
// userVisibleReason 真实前缀到最终回答，让用户看见降级说明而非静默缩水。
      if (
        contextBudgetDegradeReason !== undefined &&
        typeof output.content === "string"
      ) {
        const prefix = `[降级说明] ${contextBudgetDegradeReason}\n\n`;
        if (!output.content.startsWith(prefix)) {
          output.content = `${prefix}${output.content}`;
        }
      }
// turnStart guardrail(ADR-0006 D4)annotate/degrade 决策的前缀说明，
// 同一模式：真实前缀到最终回答，而不是静默丢弃（此前 safetyState.violations
// 计算后从未被消费）。
      if (
        turnStartGuardAnnotation !== undefined &&
        typeof output.content === "string"
      ) {
        const prefix = `[${turnStartGuardAnnotation}]\n\n`;
        if (!output.content.startsWith(prefix)) {
          output.content = `${prefix}${output.content}`;
        }
      }
      const finalUsage = orchestrator.getUsage();
      output.metadata = {
        ...output.metadata,
        durationMs: Date.now() - startTs,
        tokenUsage: {
          input: finalUsage.promptTokens,
          output: finalUsage.completionTokens,
          total: finalUsage.tokens,
          ...(finalUsage.cachedPromptTokens > 0
            ? { cached: finalUsage.cachedPromptTokens }
            : {}),
        },
      };
      yield* flushPendingUsageTelemetry();
      yield* exitPhase("output");
 // 关键顺序：先把本轮 assistant 回复落到 MemorySystem，再 yield done。
 // 否则消费方一拿到 done 就 break 出 for-await，async generator 不会推进到
 // append 调用，多轮上下文会断裂。
      await this.memorySystem.append(
        normalizedContext.correlation.sessionId,
        {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          content: typeof output.content === "string" ? output.content : JSON.stringify(output.content),
          timestamp: Date.now(),
          anchored: false,
        },
        adapterContext,
      );
      yield withStreamEnvelope({ type: "done", output }, normalizedContext);
    } catch (error) {
      for (const chunk of collectToolLoopChunksForTerminalFlush(
        toolLoopEventOutbox,
        this.config.runtime.streamingOutput === true,
        normalizedContext,
      )) {
        yield chunk;
      }
      const wrapped =
        error instanceof EngineError
          ? error
          : new InternalEngineError(
              "ENGINE_RUN_FAILED",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      yield withStreamEnvelope({ type: "error", error: wrapped }, normalizedContext);
      yield withStreamEnvelope(
        {
          type: "done",
          output: {
            type: "text",
            content: wrapped.message,
            steps: [],
            metadata: applyTurnOutcome(
              {
                toolCalls,
                durationMs: Date.now() - startTs,
                tokenUsage: { input: 0, output: 0, total: 0 },
              },
              {
                validationPassed: false,
                steps: [],
                toolCalls,
                runFailed: true,
              },
            ),
            correlation: normalizedContext.correlation,
            ...(normalizedContext.subject !== undefined
              ? { subject: normalizedContext.subject }
              : {}),
            deliveryMode: "streaming",
          },
        },
        normalizedContext,
      );
    } finally {
      runHandle.release();
      this.activeRunPrompts.delete(normalizedContext.correlation.traceId);
      this.activeRunTurnPolicies.delete(normalizedContext.correlation.traceId);
      this.activeRunUsageSinks.delete(normalizedContext.correlation.traceId);
      this.activeRunUsageTelemetrySinks.delete(normalizedContext.correlation.traceId);
      this.activeRunIdFactories.delete(normalizedContext.correlation.traceId);
      this.activeRunCurrentPhaseStepIds.delete(normalizedContext.correlation.traceId);
      this.activeRunExecutionContexts.delete(normalizedContext.correlation.traceId);
      this.activeRunEventOutbox.delete(normalizedContext.correlation.traceId);
      this.activeRunToolCallSinks.delete(normalizedContext.correlation.traceId);
      this.activeRunDeltaOutbox.delete(normalizedContext.correlation.traceId);
      this.activeRunGeneratedImages.delete(normalizedContext.correlation.traceId);
      this.activeRunGeneratedMedia.delete(normalizedContext.correlation.traceId);
      this.activeRunToolLoopTimingControls.delete(normalizedContext.correlation.traceId);
      this.activeRunModelRouters.delete(normalizedContext.correlation.traceId);
    }
  }

 /**
 * 取消指定 session 的执行。
 *
 * @param sessionId 会话 ID
 * @param reason 可选的取消原因（会透传到 `AbortSignal.reason`）
 */
  async cancel(sessionId: string, reason?: string): Promise<void> {
    await this.sessionManager.cancel(sessionId, reason);
  }

 /**
 * 释放引擎资源。
 *
 * 会遍历当前活动会话执行 `cancel`，再清空 Hook 与 tokenizer 缓存，最后 dispose 所有 provider。
 *
 * @returns 资源清理完成后返回
 */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const session of this.sessionManager.listSessions()) {
      await this.sessionManager.cancel(session.id, "engine-dispose");
    }
    this.hooks.clear();
    this.tokenizer.dispose?.();
    for (const provider of this.providers.values()) {
      await provider.dispose?.();
    }
  }

  private ensureAvailable(): void {
    if (this.disposed) {
      throw new Error("Engine has been disposed");
    }
  }

  private *emitPhaseStart(
    phase: EnginePhase,
    context: ExecutionContext,
    stepId?: string,
  ): Iterable<StreamChunk> {
    this.observability.emit(
      engineEventFromContext(context, {
        timestamp: Date.now(),
        phase,
        type: "phase_enter",
        payload: {},
      }),
    );
 // 结构化 chunk：下游消费方通过 `chunk.type === 'phase-enter'` 做穷举式
 // switch，无需依赖 progress.message 后缀字符串。
    yield withStreamEnvelope(
      {
        type: "phase-enter",
        phase,
        ...(stepId !== undefined ? { stepId } : {}),
      },
      context,
    );
 // 兼容性 chunk：现有 CLI / 已知下游仍按 `progress` 渲染 phase 文案。
    yield withStreamEnvelope(
      {
        type: "progress",
        phase,
        message: `${phase} started`,
      },
      context,
    );
  }

  private *emitPhaseEnd(
    phase: EnginePhase,
    context: ExecutionContext,
    stepId?: string,
  ): Iterable<StreamChunk> {
    this.observability.emit(
      engineEventFromContext(context, {
        timestamp: Date.now(),
        phase,
        type: "phase_exit",
        payload: {},
      }),
    );
    yield withStreamEnvelope(
      {
        type: "phase-exit",
        phase,
        ...(stepId !== undefined ? { stepId } : {}),
        ok: true,
      },
      context,
    );
    yield withStreamEnvelope(
      {
        type: "progress",
        phase,
        message: `${phase} finished`,
      },
      context,
    );
  }
}
