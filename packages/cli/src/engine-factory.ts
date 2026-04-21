import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  DefaultObservabilityEmitter,
  Engine,
  InMemoryMemorySystem,
  type EngineConfig,
  type EngineDependencies,
  type ExecutionContext,
  type MemorySystem,
  type MemorySystemFactoryDeps,
  type ObservabilityEmitter,
  type ProviderAdapter,
  type ProviderConnectionConfig,
  type TaskNode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "@tachu/core";
import { buildApprovalPrompt } from "./approval";
import {
  AnthropicProviderAdapter,
  FsMemorySystem,
  JsonlEmitter,
  LocalFsVectorStore,
  MockProviderAdapter,
  OpenAIProviderAdapter,
  QwenProviderAdapter,
  toolExecutors,
  withDefaultGate,
  type ToolExecutor,
} from "@tachu/extensions";
import type { DescriptorRegistry } from "@tachu/core";

/**
 * 工厂配置选项。
 */
export interface EngineFactoryOptions {
  /** 工作目录（用于解析相对路径） */
  cwd?: string;
  /** 覆盖 Provider 列表（不指定时按 config 中的 capabilityMapping 推断） */
  providers?: ProviderAdapter[];
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
 * 把通用 `ProviderConnectionConfig` 映射成 OpenAI adapter 可直接消费的选项，
 * 剔除 `undefined` 字段避免触发 `exactOptionalPropertyTypes` 报错。
 */
function toOpenAIProviderOptions(
  conn: ProviderConnectionConfig | undefined,
): ConstructorParameters<typeof OpenAIProviderAdapter>[0] {
  if (!conn) return undefined;
  const out: Record<string, unknown> = {};
  if (conn.apiKey !== undefined) out.apiKey = conn.apiKey;
  if (conn.baseURL !== undefined) out.baseURL = conn.baseURL;
  if (conn.organization !== undefined) out.organization = conn.organization;
  if (conn.project !== undefined) out.project = conn.project;
  if (conn.timeoutMs !== undefined) out.timeoutMs = conn.timeoutMs;
  if (conn.extra !== undefined) out.extra = conn.extra;
  return out as ConstructorParameters<typeof OpenAIProviderAdapter>[0];
}

/**
 * 把通用 `ProviderConnectionConfig` 映射成 Anthropic adapter 选项。
 */
function toAnthropicProviderOptions(
  conn: ProviderConnectionConfig | undefined,
): ConstructorParameters<typeof AnthropicProviderAdapter>[0] {
  if (!conn) return undefined;
  const out: Record<string, unknown> = {};
  if (conn.apiKey !== undefined) out.apiKey = conn.apiKey;
  if (conn.baseURL !== undefined) out.baseURL = conn.baseURL;
  if (conn.timeoutMs !== undefined) out.timeoutMs = conn.timeoutMs;
  if (conn.extra !== undefined) out.extra = conn.extra;
  return out as ConstructorParameters<typeof AnthropicProviderAdapter>[0];
}

/**
 * 把 `ProviderConnectionConfig` 映射为 {@link QwenProviderAdapter} 选项。
 * `baseURL` → OpenAI 兼容根路径；`extra.dashScopeOrigin` / `extra.workspaceId` 等供 DashScope 原生文生图与业务空间使用。
 */
function toQwenProviderOptions(
  conn: ProviderConnectionConfig | undefined,
): ConstructorParameters<typeof QwenProviderAdapter>[0] {
  if (!conn) return undefined;
  const out: Record<string, unknown> = {};
  if (conn.apiKey !== undefined) out.apiKey = conn.apiKey;
  if (conn.baseURL !== undefined) out.compatibleBaseUrl = conn.baseURL;
  if (conn.timeoutMs !== undefined) out.timeoutMs = conn.timeoutMs;
  const rawExtra = conn.extra;
  if (rawExtra && typeof rawExtra === "object" && !Array.isArray(rawExtra)) {
    const ex = rawExtra as Record<string, unknown>;
    if (typeof ex.dashScopeOrigin === "string") {
      out.dashScopeOrigin = ex.dashScopeOrigin;
    }
    if (typeof ex.workspaceId === "string") {
      out.workspaceId = ex.workspaceId;
    }
    if (typeof ex.imageTaskPollIntervalMs === "number") {
      out.imageTaskPollIntervalMs = ex.imageTaskPollIntervalMs;
    }
    if (typeof ex.modelListCacheTtlMs === "number") {
      out.modelListCacheTtlMs = ex.modelListCacheTtlMs;
    }
    const {
      dashScopeOrigin: _a,
      workspaceId: _b,
      imageTaskPollIntervalMs: _c,
      modelListCacheTtlMs: _d,
      ...openAiExtra
    } = ex;
    if (Object.keys(openAiExtra).length > 0) {
      out.extra = openAiExtra;
    }
  }
  return out as ConstructorParameters<typeof QwenProviderAdapter>[0];
}

/**
 * 根据 provider 名称构建对应的 ProviderAdapter 实例。
 *
 * @param providerName provider 标识符
 * @param connections `config.providers` 映射（可选）
 * @returns ProviderAdapter 实例
 */
function buildProviderAdapter(
  providerName: string,
  connections?: EngineConfig["providers"],
): ProviderAdapter {
  const conn = connections?.[providerName.toLowerCase()];
  switch (providerName.toLowerCase()) {
    case "openai":
      return new OpenAIProviderAdapter(toOpenAIProviderOptions(conn));
    case "anthropic":
      return new AnthropicProviderAdapter(toAnthropicProviderOptions(conn));
    case "qwen":
      return new QwenProviderAdapter(toQwenProviderOptions(conn));
    case "mock":
      return new MockProviderAdapter();
    default:
      return new MockProviderAdapter();
  }
}

/**
 * 从 EngineConfig 中推断需要的 Provider 列表。
 *
 * @param config 引擎配置
 * @returns ProviderAdapter 列表
 */
function inferProviders(config: EngineConfig): ProviderAdapter[] {
  const providerNames = new Set<string>();

  // 从 capabilityMapping 中收集 provider 名称
  for (const route of Object.values(config.models.capabilityMapping)) {
    if (typeof route === "object" && route !== null && "provider" in route) {
      providerNames.add((route as { provider: string }).provider);
    }
  }

  // 从 fallbackOrder 中收集
  for (const name of config.models.providerFallbackOrder) {
    providerNames.add(name);
  }

  if (providerNames.size === 0) {
    providerNames.add("mock");
  }

  return Array.from(providerNames)
    .filter((name) => name !== "noop")
    .map((name) => buildProviderAdapter(name, config.providers));
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
  const cwd = options.cwd ?? process.cwd();
  const providers = options.providers ?? inferProviders(config);

  // VectorStore：使用本地文件持久化
  const vectorStorePath = join(cwd, ".tachu", "vectors.json");
  const vectorStore = new LocalFsVectorStore({
    filePath: vectorStorePath,
    indexLimit: config.memory.vectorIndexLimit,
  });

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

  // 工具执行器（Task executor 通过 extensions toolExecutors 提供）
  //
  // 工作区沙箱白名单装配（多层叠加，从默认到用户配置）：
  //   1. cwd（即 workspaceRoot）——默认始终允许；
  //   2. `os.tmpdir()`——平台临时目录默认放行，方便 AI 写入 `/tmp/...`、
  //      macOS 的 `/var/folders/...` 等临时文件，避免频繁撞到"路径越界"；
  //   3. `safety.allowedWriteRoots`——用户在 tachu.config.ts 显式声明的
  //      额外根目录（相对路径会被 resolve 到 cwd 之下再注入）。
  //
  // 另见：`TaskNode.metadata.approvalGranted` 的一次性豁免路径——那条通道是
  // 运行时审批产生的，与这里的静态白名单相互独立、相互补充。
  const allowedRoots = buildAllowedRoots(cwd, config.safety.allowedWriteRoots ?? []);
  // 合并内置与外部（MCP / 自定义）工具执行器。外部同名项覆盖内置，与
  // `scanDescriptors` 的 "用户覆盖内置" 策略保持一致。
  const mergedExecutors: Record<string, ToolExecutor> = {
    ...toolExecutors,
    ...(options.extraToolExecutors ?? {}),
  };
  const baseTaskExecutor = buildTaskExecutor(cwd, mergedExecutors, allowedRoots);
  // Default Tool Gate：仅在 `safety.defaultGate: true` 时 opt-in。
  // 包装后由 core 的 `InternalSubflowRegistry`（在 Engine 构造器里）外层再套
  // layered executor，所以最终调用链为：
  //   layered → withDefaultGate → buildTaskExecutor（tool 具体执行）
  const taskExecutor = config.safety.defaultGate === true
    ? withDefaultGate(baseTaskExecutor)
    : baseTaskExecutor;

  const memorySystem = buildMemorySystemFactory(config, cwd);

  const deps: EngineDependencies = {
    providers,
    vectorStore,
    observability,
    taskExecutor,
    memorySystem,
  };
  if (options.registry !== undefined) {
    deps.registry = options.registry;
  }

  const approvalHook = resolveApprovalHook(options);
  if (approvalHook !== undefined) {
    deps.onBeforeToolCall = approvalHook;
  }

  return new Engine(config, deps);
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
 * - `"fs"`（默认）→ 返回一个 factory 回调，核心引擎在构造期传入 tokenizer /
 *   modelRouter / providers / vectorStore 后装配 `FsMemorySystem`（包内组合
 *   `InMemoryMemorySystem`）。文件根目录来自 `config.memory.persistDir`（相对
 *   路径基于 cwd）。
 * - `"memory"` → 返回一个 factory 回调，直接 `new InMemoryMemorySystem(...)`，
 *   保持纯进程内行为（CLI 用户显式关闭持久化时选用）。
 *
 * 返回 factory 而非实例，使 extensions 无需复制 core 内部依赖的构造逻辑。
 */
function buildMemorySystemFactory(
  config: EngineConfig,
  cwd: string,
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
  return (deps) => {
    const inner = new InMemoryMemorySystem(
      deps.config,
      deps.tokenizer,
      deps.modelRouter,
      deps.providers,
      deps.vectorStore,
    );
    return new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: deps.config.memory.compressionThreshold,
    });
  };
}

/**
 * 构建符合 core `TaskExecutor` 签名的适配器，桥接 extensions 工具执行器。
 *
 * 注意：引擎会在调用本 executor 之前先经过 `InternalSubflowRegistry` 拦截
 * 内置 Sub-flow（如 `direct-answer`），因此这里只需要处理 `tool` 类型；
 * 其它未知类型视为显式失败，方便后续 Agent / 业务 Sub-flow 迁移时明确暴露缺口。
 *
 * @param cwd 工作目录
 * @param executors 工具执行器映射
 * @returns TaskExecutor 函数
 */
/**
 * @internal 对外稳定性不作保证。公开仅为单元测试直接断言沙箱策略装配。
 */
export function buildTaskExecutor(
  cwd: string,
  executors: Record<string, ToolExecutor>,
  allowedRoots: readonly string[],
): (task: TaskNode, context: ExecutionContext, signal: AbortSignal) => Promise<unknown> {
  return async (task: TaskNode, context: ExecutionContext, signal: AbortSignal): Promise<unknown> => {
    if (task.type === "tool") {
      const executor = executors[task.ref];
      if (executor) {
        // 本次调用是否已获得用户显式审批：由 `@tachu/core` 的 tool-use
        // sub-flow 在 `onBeforeToolCall` 返回 approve 后写入 `task.metadata`。
        // 我们把这条信号翻译成 `ToolExecutionContext.sandboxWaived`，让下游
        // 路径校验（`resolveAllowedPath`）一次性放行该次调用。
        const sandboxWaived = task.metadata?.approvalGranted === true;
        const toolContext = {
          abortSignal: signal,
          workspaceRoot: cwd,
          allowedRoots,
          sandboxWaived,
          session: {
            id: context.sessionId,
            status: "active" as const,
            createdAt: context.startedAt ?? Date.now(),
            lastActiveAt: Date.now(),
          },
        };
        return executor(task.input, toolContext);
      }
      throw new Error(`工具执行器未找到：${task.ref}`);
    }
    throw new Error(`不支持的任务类型：${task.type}`);
  };
}

/**
 * 组装工具执行期间允许访问的根目录白名单。
 *
 * 合并顺序（保持声明顺序，先出现的优先作为"相对路径 resolve 基准"）：
 *   1. `workspaceRoot`（cwd）
 *   2. 平台**逐用户**临时目录 `os.tmpdir()`（macOS 上形如 `/var/folders/...T`，
 *      Linux 上通常是 `/tmp`，Windows 上是 `C:\\Users\\...\\Temp`）
 *   3. POSIX **共享**临时目录 `/tmp`（macOS 上是 `/private/tmp` 的 symlink；Linux
 *      上通常与 `os.tmpdir()` 重合；Windows 上一般不存在，加进来只是冗余的"无效路径"，
 *      后续 realpath 会被 catch 掉，不会产生副作用）
 *   4. 用户在 `safety.allowedWriteRoots` 里声明的额外路径
 *
 * 为什么要同时加 `os.tmpdir()` 和 `/tmp`：两者**在 macOS 上不是同一目录**。
 * 用户/模型习惯用 `/tmp/foo.txt`（通用 Unix 常识），但 macOS 的 `os.tmpdir()`
 * 是 `/var/folders/<uid>/T`。只加后者会让 `/tmp/foo.txt` 被默认沙箱拦下。
 *
 * symlink 解引用：对每个根再用 `realpathSync` 把其真实路径追加一次。典型例子
 * 是 macOS 上 `/tmp` → `/private/tmp`：如果 allowedRoots 只存原始形态，候选
 * 路径若解析成 `/private/tmp/...` 就会越界；反之亦然。两种形态都放进白名单
 * 才能让 `resolveAllowedPath` 的字符串前缀判定稳定通过。`realpathSync` 在路径
 * 不存在时会抛 ENOENT，此处捕获后只保留字面路径，不影响正常流程。
 *
 * 去重策略：以 `resolve()`（和 `realpathSync()`）后的绝对路径为键做精确去重，
 * 避免把相同目录写两遍（例如 Linux 上 `os.tmpdir() === "/tmp"`，两条路径
 * resolve 后完全相同）。
 *
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
      // 目录不存在或当前进程无权限查询 —— 只留字面形态即可，不影响后续沙箱判定；
      // 典型场景：用户在 `allowedWriteRoots` 里登记了一个尚未创建的目录，
      // 或 Windows 上 `/tmp` 根本不存在。
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
