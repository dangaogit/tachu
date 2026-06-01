import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  DEFAULT_ADAPTER_CALL_CONTEXT,
  DefaultObservabilityEmitter,
  Engine,
  InMemoryMemorySystem,
  type AdapterCallContext,
  type EngineConfig,
  type EngineDependencies,
  type ExecutionContext,
  type MemoryEntry,
  type MemorySystem,
  type MemorySystemFactoryDeps,
  type ObservabilityEmitter,
  type TaskNode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "@tachu/core";
import {
  FsMemorySystem,
  JsonlEmitter,
  ProjectionOutbox,
  ProjectionWorker,
  toolExecutors,
  withDefaultGate,
  type ToolExecutor,
} from "@tachu/extensions";
import { buildHostEngineDependencies, type ProjectionStack } from "@tachu/host-defaults";
import type { DescriptorRegistry } from "@tachu/core";
import { buildApprovalPrompt } from "./approval";

export { assertCapabilityProvided } from "@tachu/host-defaults";

/**
 * 工厂配置选项。
 */
export interface EngineFactoryOptions {
 /** 工作目录（用于解析相对路径） */
  cwd?: string;
 /** 覆盖 Provider 列表（不指定时按 config 中的 capabilityMapping 推断） */
  providers?: import("@tachu/core").ProviderAdapter[];
 /** 已构建好的 DescriptorRegistry（不指定时使用 Engine 内部默认值） */
  registry?: DescriptorRegistry;
 /** 是否开启 JSONL 可观测性事件输出（默认跟随 config.observability.enabled） */
  observability?: ObservabilityEmitter;
 /**
 * 自定义工具审批回调。
 *
 * 未提供时，CLI 会根据当前运行环境装配默认实现：TTY 交互下弹出 `y/N` 提示；
 * 非 TTY 或 `NO_TTY=1` 环境下默认拒绝（避免无人值守批准破坏性操作）。
 * 传入 `null` 可显式关闭审批（自动批准）。
 */
  onBeforeToolCall?:
    | ((request: ToolApprovalRequest) => Promise<ToolApprovalDecision>)
    | null;
 /**
 * 额外注入的 Tool 执行器映射，典型来源是 MCP 装配产物
 * （`mountMcpServers().executors`）。
 *
 * 合并规则：以**内置执行器为底，外部执行器覆盖同名项**。语义原因：
 * 一旦用户在 `.tachu/tools` 或 `mcpServers` 里声明了同名工具，应当视为
 * 用户的显式意图覆盖内置实现（与 `scanDescriptors` 的"用户覆盖内置"
 * 策略保持一致）。若发生同名覆盖，调用方应自行在可观测层广播警告。
 */
  extraToolExecutors?: Readonly<Record<string, ToolExecutor>>;
}

/**
 * Lifecycle hooks for assets that {@link createEngine} owns but the Engine
 * itself does not (e.g. the projection {@link ProjectionWorker} and its
 * underlying {@link ProjectionOutbox}). Hosts call `flush()` before exit to
 * drain pending memory→vector-index projections and `stop()` to shut down the
 * background flush timer.
 */
export interface EngineProjectionLifecycle {
  start(): void;
  stop(): Promise<void>;
  flush(sessionId?: string): Promise<{ sessions: number; projected: number; failed: number }>;
 /**
 * Resolved projection stack ({@link ProjectionStack}). `undefined` when no
 * embedding-capable provider is wired (the engine still runs, but memory
 * projection is disabled — a `projection.disabled` warning is emitted on
 * the observability bus).
 */
  stack: ProjectionStack | undefined;
}

export interface CreateEngineResult {
  engine: Engine;
  projection: EngineProjectionLifecycle;
}

/**
 * 组装 Engine 实例，注入 extensions 中的 Provider、VectorStore、工具执行器和可观测性。
 *
 * @param config 引擎配置
 * @param options 工厂选项
 * @returns 完整装配的 Engine 实例
 *
 * @example
 * ```ts
 * const config = await loadConfig();
 * const registry = await scanDescriptors(".tachu");
 * const engine = createEngine(config, { registry });
 * ```
 */
export function createEngine(config: EngineConfig, options: EngineFactoryOptions = {}): Engine {
  return createEngineWithProjection(config, options).engine;
}

/**
 * Same as {@link createEngine} but also returns the projection lifecycle
 * (worker + outbox) wired into the engine's {@link FsMemorySystem}.
 *
 * CLI hosts use this when they need to `await projection.flush()` on shutdown
 * or surface the worker for `/projection-status`-style diagnostics. Pure
 * Engine-only callers can continue using {@link createEngine} unchanged.
 */
export function createEngineWithProjection(
  config: EngineConfig,
  options: EngineFactoryOptions = {},
): CreateEngineResult {
  const cwd = options.cwd ?? process.cwd();

 // / legacy file-backed text embedding has been retired
 // from production wiring. Projection + retrieval now goes through
 // `EmbeddingRuntime` + `LocalFsVectorIndexAdapter` (or Qdrant) resolved by
 // `host-defaults` and wired through `buildMemorySystemFactory` below.

 // Observability
  let observability: ObservabilityEmitter;
  if (options.observability) {
    observability = options.observability;
  } else if (config.observability.enabled) {
    const jsonlPath = join(cwd, ".tachu", "events.jsonl");
    observability = new JsonlEmitter({ filePath: jsonlPath });
  } else {
    observability = new DefaultObservabilityEmitter();
  }

  const hostResult = buildHostEngineDependencies(config, {
    observability,
    cwd,
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
  });

 // 工具执行器（Task executor 通过 extensions toolExecutors 提供）
  const allowedRoots = buildAllowedRoots(cwd, config.safety.allowedWriteRoots ?? []);
  const mergedExecutors: Record<string, ToolExecutor> = {
    ...toolExecutors,
    ...(options.extraToolExecutors ?? {}),
  };
  const baseTaskExecutor = buildTaskExecutor(cwd, mergedExecutors, allowedRoots);
  const taskExecutor = config.safety.defaultGate === true
    ? withDefaultGate(baseTaskExecutor)
    : baseTaskExecutor;

  const projectionLifecycle = createProjectionLifecycle();
  const memorySystem = buildMemorySystemFactory(
    config,
    cwd,
    hostResult.projectionStack,
    projectionLifecycle,
  );

  const deps: EngineDependencies = {
    ...hostResult.engineDependencies,
    observability,
    taskExecutor,
    memorySystem,
  } as EngineDependencies;
  if (options.registry !== undefined) {
    deps.registry = options.registry;
  }

  const approvalHook = resolveApprovalHook(options);
  if (approvalHook !== undefined) {
    deps.onBeforeToolCall = approvalHook;
  }

  projectionLifecycle.attachStack(hostResult.projectionStack);
  return { engine: new Engine(config, deps), projection: projectionLifecycle.public };
}

interface InternalProjectionLifecycle {
  attachWorker(worker: ProjectionWorker | undefined): void;
  attachStack(stack: ProjectionStack | undefined): void;
  readonly public: EngineProjectionLifecycle;
}

function createProjectionLifecycle(): InternalProjectionLifecycle {
  let worker: ProjectionWorker | undefined;
  let stack: ProjectionStack | undefined;
  const api: EngineProjectionLifecycle = {
    start() {
      worker?.start();
    },
    async stop() {
      await worker?.stop();
    },
    async flush(sessionId?: string) {
      if (!worker) return { sessions: 0, projected: 0, failed: 0 };
      return worker.flush(sessionId);
    },
    get stack() {
      return stack;
    },
  };
  return {
    attachWorker(next) {
      worker = next;
    },
    attachStack(next) {
      stack = next;
    },
    public: api,
  };
}

/**
 * 根据调用方偏好解析最终的 `onBeforeToolCall`。
 *
 * - 显式传入 `null`：关闭审批（自动批准，等价于不注入回调）
 * - 显式传入函数：原样使用
 * - 未传：使用默认 CLI 审批（TTY 交互 y/N，非 TTY 默认拒绝）
 */
function resolveApprovalHook(
  options: EngineFactoryOptions,
): ((request: ToolApprovalRequest) => Promise<ToolApprovalDecision>) | undefined {
  if (options.onBeforeToolCall === null) return undefined;
  if (typeof options.onBeforeToolCall === "function") {
    return options.onBeforeToolCall;
  }
  return buildApprovalPrompt();
}

/**
 * 根据 `config.memory.persistence` 决定 MemorySystem 装配方式。
 *
 * / 模式下额外装配 {@link ProjectionOutbox} +
 * {@link ProjectionWorker}，并把 `host-defaults` 解析出来的 projection
 * stack（embedding runtime + vector index adapter）通过
 * `projectMemoryRefs(...)` 绑定到 `projectionProject` 回调上。这样 archive
 * 路径就走"outbox 入队 + worker flush"的生产语义，而不是退役的
 * `inner.project()` 文本捷径。
 */
function buildMemorySystemFactory(
  config: EngineConfig,
  cwd: string,
  projectionStack: ProjectionStack | undefined,
  lifecycle: InternalProjectionLifecycle,
): (deps: MemorySystemFactoryDeps) => MemorySystem {
  const persistence = config.memory.persistence ?? "fs";
  if (persistence === "memory") {
    return (deps) =>
      new InMemoryMemorySystem(
        deps.config,
        deps.tokenizer,
        deps.modelRouter,
        deps.providers,
        deps.vectorStore,
      );
  }
  const configured = config.memory.persistDir ?? ".tachu/memory";
  const persistDir = isAbsolute(configured) ? configured : join(cwd, configured);
  const outboxDir = join(cwd, ".tachu", "projections");
  return (deps) => {
    const inner = new InMemoryMemorySystem(
      deps.config,
      deps.tokenizer,
      deps.modelRouter,
      deps.providers,
      deps.vectorStore,
    );
    if (projectionStack === undefined) {
 // No embedding runtime → projection stays disabled. The host-defaults
 // call site has already emitted `projection.disabled`. We deliberately
 // do NOT pass a projection outbox; FsMemorySystem then keeps the old
 // synchronous "always pending" behaviour without ever touching the
 // retired inner.project() shortcut.
      return new FsMemorySystem({
        persistDir,
        inner,
        compressionThreshold: deps.config.memory.compressionThreshold,
      });
    }

    const outbox = new ProjectionOutbox({ dir: outboxDir });
    const loadEntry: Parameters<ProjectionStack["bindProjectionProject"]>[0] = async (
      sessionId,
      ref,
    ) => {
      const entries = await inner.loadFull(sessionId);
      const entry = entries.find((item: MemoryEntry) => item.id === ref);
      if (!entry) return null;
      return { entry, content: String(entry.content) };
    };
    const adapterCtx: AdapterCallContext = DEFAULT_ADAPTER_CALL_CONTEXT;
    const projectionProject = projectionStack.bindProjectionProject(loadEntry, adapterCtx);
    const memorySystem = new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: deps.config.memory.compressionThreshold,
      projectionOutbox: outbox,
      projectionProject,
    });
    lifecycle.attachWorker(memorySystem.createProjectionWorker());
    return memorySystem;
  };
}

/**
 * @internal 对外稳定性不作保证。公开仅为单元测试直接断言沙箱策略装配。
 */
export function buildTaskExecutor(
  cwd: string,
  executors: Record<string, ToolExecutor>,
  allowedRoots: readonly string[],
): (task: TaskNode, context: ExecutionContext, signal: AbortSignal) => Promise<import("@tachu/core").TaskExecutionResult> {
  return async (task: TaskNode, context: ExecutionContext, signal: AbortSignal): Promise<import("@tachu/core").TaskExecutionResult> => {
    if (task.type === "tool") {
      const executor = executors[task.ref];
      if (executor) {
        const sandboxWaived = task.metadata?.approvalGranted === true;
        const toolContext = {
          abortSignal: signal,
          workspaceRoot: cwd,
          allowedRoots,
          sandboxWaived,
          session: {
            id: context.correlation.sessionId,
            status: "active" as const,
            createdAt: context.startedAt ?? Date.now(),
            lastActiveAt: Date.now(),
          },
        };
        try {
          return { ok: true, output: await executor(task.input, toolContext) };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "TOOL_EXECUTION_FAILED",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
              source: "tool",
            },
          };
        }
      }
      return {
        ok: false,
        error: {
          code: "TOOL_EXECUTOR_NOT_FOUND",
          message: `工具执行器未找到：${task.ref}`,
          retryable: false,
          source: "tool",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_TASK_TYPE",
        message: `不支持的任务类型：${task.type}`,
        retryable: false,
        source: "scheduler",
      },
    };
  };
}

/**
 * @internal 对外稳定性不作保证。公开仅为单元测试直接断言沙箱策略装配。
 */
export function buildAllowedRoots(
  cwd: string,
  configuredExtras: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const addIfNew = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    result.push(path);
  };
  const push = (candidate: string): void => {
    const absolute = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(cwd, candidate);
    addIfNew(absolute);
    try {
      const real = realpathSync(absolute);
      if (real !== absolute) {
        addIfNew(real);
      }
    } catch {
 // path may not exist yet
    }
  };
  push(cwd);
  push(tmpdir());
  push("/tmp");
  for (const extra of configuredExtras) {
    if (typeof extra === "string" && extra.trim().length > 0) {
      push(extra);
    }
  }
  return result;
}
