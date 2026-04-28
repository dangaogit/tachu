import { randomUUID } from "node:crypto";
import { EngineError } from "../errors";
import {
  DefaultHookRegistry,
  DefaultModelRouter,
  DefaultObservabilityEmitter,
  DefaultSafetyModule,
  InMemoryMemorySystem,
  InMemoryRuntimeState,
  InMemorySessionManager,
  NoopProvider,
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
  EngineOutput,
  ExecutionContext,
  GeneratedImage,
  InputEnvelope,
  OutputMetadata,
  StreamChunk,
  ToolCallRecord,
} from "../types";
import { adapterCallContextFromExecution } from "../types/context";
import {
  createDefaultEngineConfig,
  envelopeNeedsTextToImage,
  envelopeNeedsVision,
  validateEngineConfig,
} from "../utils";
import { InMemoryVectorStore, type VectorStore } from "../vector";
import { ExecutionOrchestrator } from "./orchestrator";
import { TaskScheduler, type TaskExecutor } from "./scheduler";
import {
  INTERNAL_SUBFLOW_NAMES,
  InternalSubflowRegistry,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "./subflows";
import {
  runExecutionPhase,
  runGraphCheckPhase,
  runIntentPhase,
  runOutputPhase,
  runPlanningPhase,
  runPrecheckPhase,
  runSafetyPhase,
  runSessionPhase,
  runValidationPhase,
  type PhaseEnvironment,
  type ValidationPhaseOutput,
} from "./phases";
import {
  DELTA_STREAM_END,
  DeltaStreamQueue,
} from "./delta-stream-queue";

function enqueueUsageChunk(
  deltaQueue: DeltaStreamQueue | undefined,
  orchestrator: ExecutionOrchestrator,
): void {
  if (!deltaQueue) {
    return;
  }
  const u = orchestrator.getUsage();
  deltaQueue.enqueue({
    type: "usage",
    tokens: u.tokens,
    toolCalls: u.toolCalls,
    wallTimeMs: u.wallTimeMs,
  });
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
 *   modelRouter / providers / vectorStore 后再组装（持久化实现典型路径）
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
   * `tool-use` 工具审批回调（ADR-0002 Stage 4）。
   *
   * 触发条件：`ToolDescriptor.requiresApproval === true` 或
   * `config.runtime.toolLoop.requireApprovalGlobal === true`。
   * 未注入时一律自动批准，等价于旧行为。
   */
  onBeforeToolCall?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
}

/**
 * Tachu 核心引擎。
 *
 * 该类负责组装运行时依赖并串联 9 阶段主干流程，支持流式与非流式执行、
 * 会话级取消传播、Hook 扩展以及资源释放。
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
  private readonly scheduler: TaskScheduler;
  private readonly taskExecutor: TaskExecutor;
  private readonly internalSubflows: InternalSubflowRegistry;
  private disposed = false;
  /**
   * 活跃 runStream 的预组装 Prompt 缓存，按 `traceId` 索引。
   *
   * 由 `runStream` 在 Phase 6 预热阶段写入、在 `finally` 里清理；`buildLayeredTaskExecutor`
   * 读取它并作为 `prebuiltPrompt` 传递给内置 Sub-flow（典型即 direct-answer）。
   *
   * 以 `traceId` 为键而非 `sessionId`：同一 session 可能有并发取消后的重试，
   * 用 traceId 区分每一次具体执行，避免旧 trace 污染新 trace 的 prompt。
   */
  private readonly activeRunPrompts = new Map<string, AssembledPrompt>();

  /**
   * 活跃 runStream 的 usage 回流回调缓存，按 `traceId` 索引（D1-LOW-04）。
   *
   * 与 `activeRunPrompts` 同生命周期：`runStream` 创建 orchestrator 后写入，
   * `finally` 清理；内置 Sub-flow（direct-answer 等）据此把真实 usage 汇回主干。
   */
  private readonly activeRunUsageSinks = new Map<
    string,
    (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }) => void
  >();

  /**
   * 活跃 runStream 的 ExecutionContext（ADR-0002）。
   *
   * `tool-use` 内置 Sub-flow 执行工具时需要把它传给 TaskExecutor，以保持预算、
   * 权限、traceId 等信息与主干一致。与 `activeRunPrompts` 同生命周期。
   */
  private readonly activeRunExecutionContexts = new Map<string, ExecutionContext>();

  /**
   * 活跃 runStream 的 Agentic Loop 事件 outbox（ADR-0002）。
   *
   * `tool-use` 在执行过程中通过 `onToolLoopEvent` 把 loop-step / tool-call-*
   * 事件 push 进本 outbox；`runStream` 的 execution phase 结束后一次性 flush，
   * 按时间顺序 yield 给调用方。
   *
   * 本实现选择"批量 flush 而不是实时 yield"是因为 execution phase 是
   * `await runExecutionPhase` 的同步等待，async generator 不能在 await 中
   * 穿插 yield。批量 flush 足以覆盖现阶段 CLI / SDK 的需求；实时 live stream
   * 的优化留到后续阶段（将 TaskScheduler 改造为 async generator 后再开放）。
   */
  private readonly activeRunEventOutbox = new Map<string, StreamChunk[]>();

  /**
   * 活跃 runStream 的 ToolCallRecord outbox（ADR-0002）。
   *
   * `tool-use` 的每次工具调用（成功或失败）都会 push 一条记录；Engine 会在
   * execution phase 结束后与主干的 `toolCalls` 合并，最终反映在
   * `EngineOutput.metadata.toolCalls` 中。
   */
  private readonly activeRunToolCallSinks = new Map<string, ToolCallRecord[]>();

  /**
   * 活跃 runStream 的 direct-answer 正文 delta 队列（`runtime.streamingOutput`）。
   */
  private readonly activeRunDeltaOutbox = new Map<string, DeltaStreamQueue>();

  /**
   * 活跃 runStream 的文生图 / 图像编辑产物 sink（P1-1）。
   *
   * 由 `runStream` 在 orchestrator 就绪后初始化为空数组、`finally` 清理；内置
   * `direct-answer` 子流程在 Provider 返回含 images 的 `ChatResponse` 时把列表
   * 合并到本 sink。Output phase 结束前会一次性写入
   * `EngineOutput.metadata.generatedImages`。
   */
  private readonly activeRunGeneratedImages = new Map<string, GeneratedImage[]>();

  /**
   * `tool-use` 工具审批回调（ADR-0002 Stage 4）。
   *
   * 注入时机：Engine 构造期；运行期不可变。未注入视作自动批准，保持旧行为。
   */
  private readonly onBeforeToolCall?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;

  constructor(config: EngineConfig, dependencies?: EngineDependencies) {
    this.config = validateEngineConfig(config ?? createDefaultEngineConfig());
    this.vectorStore =
      dependencies?.vectorStore ??
      new InMemoryVectorStore({ indexLimit: this.config.memory.vectorIndexLimit });
    this.registry =
      dependencies?.registry ??
      new DescriptorRegistry({
        vectorStore: this.vectorStore,
        reservedNames: INTERNAL_SUBFLOW_NAMES,
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
        traceId: "engine-init",
        sessionId: "engine-init",
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
    // TaskExecutor 装配：
    //   - 无论业务是否注入自定义 executor，内置 Sub-flow（`direct-answer` 等）
    //     必须由引擎内部的 `InternalSubflowRegistry` 拦截执行；否则业务自定义 executor
    //     会把 `type === 'sub-flow'` 视为未知类型而抛错，简单意图分支会整条失败。
    //   - 非内置 Sub-flow 的任务（tool / agent / 业务 Sub-flow）继续按业务自定义
    //     executor 或默认占位 executor 处理。
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
   *   1. `config.memory.maxContextTokens` 显式配置（>0 时生效）
   *   2. 回退到 128_000（覆盖绝大多数主流长文 LLM）
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
   * 暴露 MemorySystem 实例 —— 供宿主（CLI / 服务端）在需要时直接读写会话上下文。
   *
   * 典型使用场景：
   * - CLI `/history` / `/export` 命令：`engine.getMemorySystem().load(sid)` 读
   *   `ContextWindow.entries` 展示历史
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
   * 以 `input.content` 的字符串化形态作为查询，`config.memory.recallTopK` 作为 topK（默认 5）。
   * 召回失败不阻塞主流程，返回空数组并通过 observability 事件告警，避免向量库抖动
   * 影响用户请求。
   */
  private async recallForRun(
    input: InputEnvelope,
    sessionId: string,
  ): Promise<MemoryEntry[]> {
    const topK = this.config.memory.recallTopK ?? 5;
    if (topK <= 0) {
      return [];
    }
    const query = this.extractRecallQuery(input);
    if (query.length === 0) {
      return [];
    }
    try {
      return await this.memorySystem.recall(sessionId, query, topK);
    } catch (error) {
      this.observability.emit({
        timestamp: Date.now(),
        traceId: "engine-runtime",
        sessionId,
        phase: "prompt",
        type: "warning",
        payload: {
          message: "memory recall failed; continuing without recalled entries",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      return [];
    }
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
      ref: task.ref,
      input: task.input,
      output: `[executed:${task.type}] ${task.ref}`,
    });
  }

  /**
   * 构造"分层"TaskExecutor：先尝试命中内置 Sub-flow，未命中时回落到业务/占位 executor。
   *
   * 规则：
   *   - `type === 'sub-flow'` 且 `ref` 命中 `InternalSubflowRegistry` → 执行内置 Sub-flow
   *   - 其它情况 → 交给 `fallback`（业务自定义或占位 executor）处理
   *
   * 这样设计保证：
   *   1. 业务侧即便注入了只处理 `tool` 的 executor（见 `@tachu/cli` 的 `buildTaskExecutor`），
   *      `direct-answer` 仍能正确执行，simple 路径不会整条失败
   *   2. 业务侧无需了解内置 Sub-flow 的存在，协议层自行兜底
   *   3. 内置 Sub-flow 的 context 由引擎集中装配，避免业务侧重复拼装依赖
   */
  /**
   * 对外暴露的 layered TaskExecutor 工厂。
   *
   * 业务侧（典型为 `@tachu/cli` 的 `buildTaskExecutor`、或宿主自己实现的 executor）
   * 可以用本 helper 把自身 TaskExecutor 包裹成"先尝试内置 Sub-flow，未命中再落到业务
   * executor"的两层结构，从而复用引擎内置的 `direct-answer` 等子流程。
   *
   * ADR-0001 §决定4 承诺对外暴露这个 helper；详见 D1-LOW-20。
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
        const prebuiltPrompt = this.activeRunPrompts.get(context.traceId);
        const onProviderUsage = this.activeRunUsageSinks.get(context.traceId);
        const executionContext = this.activeRunExecutionContexts.get(context.traceId);
        const eventOutbox = this.activeRunEventOutbox.get(context.traceId);
        const toolCallSink = this.activeRunToolCallSinks.get(context.traceId);
        const onToolLoopEvent = eventOutbox
          ? (chunk: StreamChunk): void => {
              eventOutbox.push(chunk);
            }
          : undefined;
        const onToolCall = toolCallSink
          ? (record: ToolCallRecord): void => {
              toolCallSink.push(record);
            }
          : undefined;
        const deltaQueue = this.activeRunDeltaOutbox.get(context.traceId);
        const onAssistantDelta =
          deltaQueue !== undefined && this.config.runtime.streamingOutput
            ? (text: string): void => {
                deltaQueue.enqueue({ type: "delta", content: text });
              }
            : undefined;
        const generatedImagesSink = this.activeRunGeneratedImages.get(context.traceId);
        const onGeneratedImages = generatedImagesSink
          ? (images: GeneratedImage[]): void => {
              for (const img of images) {
                generatedImagesSink.push(img);
              }
            }
          : undefined;
        return internalSubflows.execute(task.ref, task.input, {
          config: this.config,
          providers: this.providers,
          modelRouter: this.modelRouter,
          memorySystem: this.memorySystem,
          observability: this.observability,
          signal,
          traceId: context.traceId,
          sessionId: context.sessionId,
          adapterContext: adapterCallContextFromExecution(context),
          ...(prebuiltPrompt !== undefined ? { prebuiltPrompt } : {}),
          ...(onProviderUsage !== undefined ? { onProviderUsage } : {}),
          registry: this.registry,
          taskExecutor: fallback,
          ...(executionContext !== undefined ? { executionContext } : {}),
          ...(onToolLoopEvent !== undefined ? { onToolLoopEvent } : {}),
          ...(onToolCall !== undefined ? { onToolCall } : {}),
          ...(onAssistantDelta !== undefined ? { onAssistantDelta } : {}),
          ...(onGeneratedImages !== undefined ? { onGeneratedImages } : {}),
          ...(this.onBeforeToolCall !== undefined
            ? { onBeforeToolCall: this.onBeforeToolCall }
            : {}),
        });
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
  async run(input: InputEnvelope, context: ExecutionContext): Promise<EngineOutput> {
    let output: EngineOutput | undefined;
    for await (const chunk of this.runStream(input, context)) {
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
  ): AsyncIterable<StreamChunk> {
    this.ensureAvailable();
    const normalizedContext: ExecutionContext = {
      ...context,
      requestId: context.requestId || randomUUID(),
      traceId: context.traceId || randomUUID(),
      startedAt: context.startedAt ?? Date.now(),
      budget: {
        ...context.budget,
      },
    };

    await this.sessionManager.resolve(normalizedContext.sessionId);
    const runHandle = this.sessionManager.beginRun(
      normalizedContext.sessionId,
      normalizedContext.requestId,
    );
    const activeSignal = runHandle.signal;

    const toolCalls: OutputMetadata["toolCalls"] = [];
    const startTs = Date.now();
    const orchestrator = new ExecutionOrchestrator(
      this.config,
      { traceId: normalizedContext.traceId, sessionId: normalizedContext.sessionId },
      this.observability,
    );

    // D1-LOW-04：把各阶段 Provider.chat 返回的真实 usage 汇回 orchestrator，
    // 保证预算熔断、可观测事件均基于真值而非 Prompt 估算值。
    const usageSink = (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }): void => {
      orchestrator.recordModelUsage(usage.promptTokens, usage.completionTokens);
      enqueueUsageChunk(
        this.activeRunDeltaOutbox.get(normalizedContext.traceId),
        orchestrator,
      );
    };
    this.activeRunUsageSinks.set(normalizedContext.traceId, usageSink);
    this.activeRunExecutionContexts.set(normalizedContext.traceId, normalizedContext);
    // ADR-0002：为本轮 `tool-use` 子流程预留事件 / 工具调用 outbox；
    // execution 阶段结束后主干 flush 到 yield 流与 metadata。
    const toolLoopEventOutbox: StreamChunk[] = [];
    const toolLoopToolCalls: ToolCallRecord[] = [];
    this.activeRunEventOutbox.set(normalizedContext.traceId, toolLoopEventOutbox);
    this.activeRunToolCallSinks.set(normalizedContext.traceId, toolLoopToolCalls);
    const generatedImagesBucket: GeneratedImage[] = [];
    this.activeRunGeneratedImages.set(normalizedContext.traceId, generatedImagesBucket);

    const adapterContext = adapterCallContextFromExecution(normalizedContext);
    const phaseEnv: PhaseEnvironment = {
      config: this.config,
      registry: this.registry as DescriptorRegistry,
      sessionManager: this.sessionManager,
      memorySystem: this.memorySystem,
      runtimeState: this.runtimeState,
      modelRouter: this.modelRouter,
      providers: this.providers,
      safetyModule: this.safetyModule,
      observability: this.observability,
      hooks: this.hooks,
      scheduler: this.scheduler,
      activeAbortSignal: activeSignal,
      adapterContext,
      onProviderUsage: usageSink,
    };

    try {
      yield* this.emitPhaseStart("session", normalizedContext);
      const sessionState = await runSessionPhase(input, normalizedContext, phaseEnv);
      yield* this.emitPhaseEnd("session", normalizedContext);

      yield* this.emitPhaseStart("safety", normalizedContext);
      const safetyState = await runSafetyPhase(sessionState.input, sessionState.context, phaseEnv);
      yield* this.emitPhaseEnd("safety", normalizedContext);

      yield* this.emitPhaseStart("intent", normalizedContext);
      const intentState = await runIntentPhase(safetyState, phaseEnv);
      yield* this.emitPhaseEnd("intent", normalizedContext);

      /** Intent 阶段可能写入 `textToImage`（LLM 或兜底启发式），装配 Prompt 须与之后各阶段共用同一条 input。 */
      const effectiveInput = intentState.input;

      // 所有请求（含 simple）统一穿过前置校验阶段，
      // 以保证 Rules / 安全策略 / Provider 可达性校验对所有路径生效一致。
      yield* this.emitPhaseStart("precheck", normalizedContext);
      const precheckState = await runPrecheckPhase(intentState, phaseEnv);
      yield* this.emitPhaseEnd("precheck", normalizedContext);

      yield* this.emitPhaseStart("planning", normalizedContext);
      const planningState = await runPlanningPhase(precheckState, phaseEnv);
      orchestrator.setPlanningResult(planningState.planning);
      if (this.config.runtime.planMode) {
        const topPlan = planningState.planning.plans[0];
        if (topPlan) {
          yield { type: "plan-preview", phase: "planning", plan: topPlan };
        }
        const action = await this.hooks.fire("afterPlanning", {
          point: "afterPlanning",
          timestamp: Date.now(),
          traceId: normalizedContext.traceId,
          sessionId: normalizedContext.sessionId,
          data: planningState.planning,
        });
        if (action?.type === "deny" || action?.type === "abort") {
          throw EngineError.fromUnknown(
            new Error(action.reason ?? "afterPlanning hook 拒绝了当前计划"),
            "HOOK_EXECUTION_FAILED",
          );
        }
      }
      yield* this.emitPhaseEnd("planning", normalizedContext);

      yield* this.emitPhaseStart("graph-check", normalizedContext);
      const graphState = await runGraphCheckPhase(planningState, phaseEnv);
      yield* this.emitPhaseEnd("graph-check", normalizedContext);

      const distributed = this.contextDistributor.distribute(
        {
          rules: this.registry.list("rule"),
          constraints: this.config.safety,
          taskResults: {},
        },
        graphState.planning.plans[0]?.tasks ?? [],
        graphState.planning.plans[0]?.edges ?? [],
      );
      graphState.planning.plans[0]?.tasks.forEach((task) => {
        task.contextSlice = distributed.get(task.id);
      });

      if (envelopeNeedsTextToImage(effectiveInput)) {
        orchestrator.recordModelUsage(0, 0);
        this.activeRunPrompts.set(normalizedContext.traceId, {
          messages: [],
          tools: [],
          tokenCount: 0,
          appliedCuts: ["text-to-image: skipped full prompt assemble"],
        });
      } else {
        let route = this.modelRouter.resolve("intent");
        if (envelopeNeedsVision(effectiveInput)) {
          try {
            route = this.modelRouter.resolve("vision");
          } catch {
            /* `vision` 未配置 */
          }
        }
        const recalledEntries = await this.recallForRun(
          effectiveInput,
          normalizedContext.sessionId,
        );
        const assembled = await this.promptAssembler.assemble({
          phase: "planning",
          model: route.model,
          tokenizer: this.tokenizer,
          modelCapabilities: {
            supportedModalities: envelopeNeedsVision(effectiveInput) ? ["text", "image"] : ["text"],
            maxContextTokens: this.resolveMaxContextTokens(),
            supportsFunctionCalling: true,
            supportsStreaming: true,
          },
          currentInput: effectiveInput,
          activeRules: this.registry.list("rule"),
          activeSkills: this.registry.list("skill"),
          availableTools: this.registry.list("tool"),
          contextWindow: await this.memorySystem.load(
            normalizedContext.sessionId,
            adapterContext,
          ),
          recalledEntries: recalledEntries.map((entry) => ({
            content:
              typeof entry.content === "string"
                ? entry.content
                : JSON.stringify(entry.content),
          })),
        });
        orchestrator.recordModelUsage(assembled.tokenCount, 0);
        this.activeRunPrompts.set(normalizedContext.traceId, assembled);
      }

      yield* this.emitPhaseStart("execution", normalizedContext);

      let executionState: Awaited<ReturnType<typeof runExecutionPhase>>;
      if (this.config.runtime.streamingOutput) {
        const deltaQueue = new DeltaStreamQueue();
        this.activeRunDeltaOutbox.set(normalizedContext.traceId, deltaQueue);
        // Prompt 组装等已在 execution 前计入 orchestrator，补发首帧 usage 供 UI 实时展示
        enqueueUsageChunk(deltaQueue, orchestrator);
        const execPromise = runExecutionPhase(
          graphState,
          phaseEnv,
          ({ taskId, status, output }) => {
            if (status === "completed") {
              toolCalls.push({
                name: taskId,
                durationMs: 0,
                success: true,
              });
              if (output && typeof output === "object") {
                orchestrator.recordToolCall();
                enqueueUsageChunk(deltaQueue, orchestrator);
              }
            }
            if (status === "failed") {
              toolCalls.push({
                name: taskId,
                durationMs: 0,
                success: false,
              });
            }
            if (output !== undefined) {
              this.observability.emit({
                timestamp: Date.now(),
                traceId: normalizedContext.traceId,
                sessionId: normalizedContext.sessionId,
                phase: "execution",
                type: "tool_call_end",
                payload: { taskId, status },
              });
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
          graphState,
          phaseEnv,
          ({ taskId, status, output }) => {
            if (status === "completed") {
              toolCalls.push({
                name: taskId,
                durationMs: 0,
                success: true,
              });
              if (output && typeof output === "object") {
                orchestrator.recordToolCall();
              }
            }
            if (status === "failed") {
              toolCalls.push({
                name: taskId,
                durationMs: 0,
                success: false,
              });
            }
            if (output !== undefined) {
              this.observability.emit({
                timestamp: Date.now(),
                traceId: normalizedContext.traceId,
                sessionId: normalizedContext.sessionId,
                phase: "execution",
                type: "tool_call_end",
                payload: { taskId, status },
              });
            }
          },
        );
      }

      for (const step of executionState.steps) {
        yield {
          type: "progress",
          phase: "execution",
          message: `${step.name}: ${step.status}`,
        };
      }
      // ADR-0002：把 `tool-use` 子流程累积的 loop/tool 事件按时间顺序 yield 出去。
      // 这些事件来自子流程的 `onToolLoopEvent` 回调（存入 outbox），因为 execution
      // phase 采用 `await runExecutionPhase` 同步等待，无法在执行中实时 yield。
      for (const chunk of toolLoopEventOutbox) {
        yield chunk;
      }
      // 同步 tool-use 子流程记录的工具调用元数据到主干 metadata。
      for (const record of toolLoopToolCalls) {
        toolCalls.push(record);
        if (record.success) {
          orchestrator.recordToolCall();
        }
      }
      yield* this.emitPhaseEnd("execution", normalizedContext);

      // 结果验证对所有请求统一执行。
      // 对 simple 路径（单步 direct-answer）而言，validation 退化为"步骤成功 → 通过"的确定性判断，
      // 但这条判断链路与 complex 路径同构，保证预算熔断 / Hook / 可观测事件覆盖一致。
      yield* this.emitPhaseStart("validation", normalizedContext);
      const validationState: ValidationPhaseOutput = await runValidationPhase(executionState, phaseEnv);
      if (!validationState.validation.passed) {
        const switched = orchestrator.switchToNextPlan(
          validationState.validation.diagnosis?.reason ?? "validation-failed",
        );
        if (switched) {
          orchestrator.markReplanRequest("validation requested alternative plan");
        }
      }
      yield* this.emitPhaseEnd("validation", normalizedContext);

      yield* this.emitPhaseStart("output", normalizedContext);
      const usage = orchestrator.getUsage();
      const output = await runOutputPhase(validationState, phaseEnv, {
        toolCalls,
        durationMs: Date.now() - startTs,
        tokenUsage: {
          input: usage.tokens,
          output: 0,
          total: usage.tokens,
        },
        ...(generatedImagesBucket.length > 0
          ? { generatedImages: generatedImagesBucket.slice() }
          : {}),
      });
      yield* this.emitPhaseEnd("output", normalizedContext);
      yield { type: "done", output };
      await this.memorySystem.append(
        normalizedContext.sessionId,
        {
          role: "assistant",
          content: typeof output.content === "string" ? output.content : JSON.stringify(output.content),
          timestamp: Date.now(),
          anchored: false,
        },
        adapterContext,
      );
    } catch (error) {
      const wrapped =
        error instanceof EngineError
          ? error
          : new InternalEngineError(
              "ENGINE_RUN_FAILED",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      yield { type: "error", error: wrapped };
      yield {
        type: "done",
        output: {
          type: "text",
          content: wrapped.message,
          status: "failed",
          steps: [],
          metadata: {
            toolCalls,
            durationMs: Date.now() - startTs,
            tokenUsage: { input: 0, output: 0, total: 0 },
          },
          traceId: normalizedContext.traceId,
          deliveryMode: "streaming",
        },
      };
    } finally {
      runHandle.release();
      this.activeRunPrompts.delete(normalizedContext.traceId);
      this.activeRunUsageSinks.delete(normalizedContext.traceId);
      this.activeRunExecutionContexts.delete(normalizedContext.traceId);
      this.activeRunEventOutbox.delete(normalizedContext.traceId);
      this.activeRunToolCallSinks.delete(normalizedContext.traceId);
      this.activeRunDeltaOutbox.delete(normalizedContext.traceId);
      this.activeRunGeneratedImages.delete(normalizedContext.traceId);
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

  private *emitPhaseStart(phase: string, context: ExecutionContext): Iterable<StreamChunk> {
    this.observability.emit({
      timestamp: Date.now(),
      traceId: context.traceId,
      sessionId: context.sessionId,
      phase,
      type: "phase_enter",
      payload: {},
    });
    yield {
      type: "progress",
      phase,
      message: `${phase} started`,
    };
  }

  private *emitPhaseEnd(phase: string, context: ExecutionContext): Iterable<StreamChunk> {
    this.observability.emit({
      timestamp: Date.now(),
      traceId: context.traceId,
      sessionId: context.sessionId,
      phase,
      type: "phase_exit",
      payload: {},
    });
    yield {
      type: "progress",
      phase,
      message: `${phase} finished`,
    };
  }
}

