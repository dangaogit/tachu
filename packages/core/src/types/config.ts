/**
 * 路由到具体模型的解析结果。
 */
export interface ModelRoute {
  provider: string;
  model: string;
  params?: Record<string, unknown> | undefined;
}

/**
 * 单个 Provider 的连接配置。
 *
 * 所有字段均为可选——不填则沿用 SDK 默认：
 *   - `apiKey`      回退到 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 等环境变量
 *   - `baseURL`     回退到 SDK 自己的默认（OpenAI 还会读取 `OPENAI_BASE_URL`
 *                   / Anthropic 读取 `ANTHROPIC_BASE_URL`）
 *   - `organization`/`project` 仅 OpenAI 有意义
 *   - `timeoutMs`   provider 级请求超时
 */
export interface ProviderConnectionConfig {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
  /** 额外透传给底层 SDK 的原始选项（谨慎使用；结构由具体 adapter 解释）*/
  extra?: Record<string, unknown>;
}

/**
 * 每个已知 Provider 的连接配置集合。
 *
 * 键名必须与 `models.capabilityMapping[*].provider` / `providerFallbackOrder`
 * 中使用的 provider id 保持一致（例如 `openai` / `anthropic`）。未列出的
 * provider 继续使用无参构造。
 */
export interface ProvidersConfig {
  openai?: ProviderConnectionConfig;
  anthropic?: ProviderConnectionConfig;
  [provider: string]: ProviderConnectionConfig | undefined;
}

/**
 * 单个 MCP Server 的声明式配置。
 *
 * 兼容性约定——字段命名对齐 OpenAI Agents SDK MCP 与通用 MCP 客户端
 * 的约定（`mcp.json` / `mcp_servers` 风格），方便直接从既有客户端配置复制：
 *
 * - `command` + `args` + `env` + `cwd` → stdio transport
 * - `url` + `headers` → SSE transport
 *
 * 若同时给出 `command` 与 `url`，显式 `transport` 具有最高优先级；
 * 未显式声明时：存在 `url` → `sse`；否则 → `stdio`。
 *
 * 额外的 tachu 自有扩展字段（非主流客户端约定）已通过前缀或语义上的
 * "纯数值/布尔"避免与未来社区字段冲突：
 *
 * - `disabled` 软开关；`true` 时装配阶段跳过该 server，保留配置体便于临时禁用
 * - `timeoutMs` 映射到 `McpStdioAdapter`/`McpSseAdapter` 的
 *   `defaultTimeoutMs`（单次工具调用超时）。省略时取 adapter 默认 30s；
 *   显式 `0` 关闭 adapter 层超时（仅依赖调用方 AbortSignal）
 * - `connectTimeoutMs` 限制 `adapter.connect()` 的等待时长，省略时默认 15s
 * - `allowTools` / `denyTools` 工具级白/黑名单（按 MCP 原始工具名匹配）
 * - `tags` 统一追加到所有该 server 工具的 `ToolDescriptor.tags`
 * - `requiresApproval` 强制把该 server 的所有工具视作 `requiresApproval=true`，
 *   以便外层沙箱/审批闸门统一处理（与 `ToolDescriptor.requiresApproval` OR 运算）
 * - `description` 面向 LLM 的一行摘要（形如 `"remoteKb 负责检索项目文档"`）。
 *   装配时会自动拼到该 server 每个工具的 `description` 前面，让规划阶段更易
 *   判断该工具是否命中用户意图。
 * - `keywords` 触发关键词；配合 `expandOnKeywordMatch` 构成"按需暴露工具"
 *   的惰性装配——用户当轮输入命中任一关键词才把该 server 的工具灌入
 *   Registry；否则保持不可见以压缩 prompt 与提高选择准确度。
 * - `expandOnKeywordMatch` 是否开启上述惰性装配。默认 `false`，保持"总是暴露"
 *   的向后兼容语义；置 `true` 后必须配合非空 `keywords`（schema 校验强制）。
 */
export interface McpServerConfig {
  /**
   * 显式 transport。
   *
   * 默认推断规则：显式填写优先；否则存在 `url` 视为 `"sse"`；否则 `"stdio"`。
   */
  transport?: "stdio" | "sse";

  /** stdio：启动命令（绝对路径或 PATH 可见的命令名）。 */
  command?: string;
  /** stdio：命令行参数。 */
  args?: string[];
  /**
   * stdio：传递给子进程的环境变量映射。
   *
   * 注意：SDK 并不会自动继承父进程 `process.env`，如需沿用需显式透传
   * （典型写法：`env: { ...process.env, TOKEN: "..." }`）。
   */
  env?: Record<string, string>;
  /** stdio：子进程工作目录（相对路径由宿主按自身 cwd 展开）。 */
  cwd?: string;

  /** sse：服务端 URL（必须是有效的 http/https 地址）。 */
  url?: string;
  /** sse：附加到握手与请求的自定义 header（如 `Authorization`）。 */
  headers?: Record<string, string>;

  /** 软开关；`true` 时跳过装配但保留配置，方便临时禁用。 */
  disabled?: boolean;

  /** 单次 `callTool` 超时（毫秒）；`0` 关闭 adapter 层超时。 */
  timeoutMs?: number;
  /** 连接超时（毫秒）；默认 15_000，`0` 关闭。 */
  connectTimeoutMs?: number;

  /** 工具白名单（按 MCP 原始工具名）。未声明 = 允许全部。 */
  allowTools?: string[];
  /** 工具黑名单（按 MCP 原始工具名）。与白名单共存时白名单优先过滤，再过黑名单。 */
  denyTools?: string[];

  /** 广播到该 server 所有工具的 tag 列表，便于 Registry 检索。 */
  tags?: string[];
  /**
   * 强制把该 server 所有工具标记为 `requiresApproval=true`。
   *
   * 适合面向"凡是外部 MCP 都需要审批"的安全策略；与具体工具 descriptor
   * 自身的 `requiresApproval` 做逻辑 OR。
   */
  requiresApproval?: boolean;

  /**
   * 面向 LLM 的一行摘要，装配时会拼到该 server 每个工具的 `description`
   * 前面（形如 `"[remoteKb: 项目文档检索示例接口] <原 description>"`）。
   *
   * 也用于 `--debug` 输出和 `/help` 类诊断命令。
   */
  description?: string;

  /**
   * 触发该 server 工具暴露的关键词列表（大小写不敏感，按子串匹配当轮用户输入）。
   *
   * - `expandOnKeywordMatch: false`（默认）：`keywords` 仅作元信息展示，不影响装配
   * - `expandOnKeywordMatch: true`：仅当用户当轮输入命中任一 keyword 时，
   *   该 server 的工具才会被注册进 `DescriptorRegistry`；否则工具不可见
   *
   * 设计目的：MCP server 可能暴露几十个工具 + 巨大 `inputSchema`，每轮都塞
   * 进 prompt 会严重拖慢 prefill 并干扰意图路由。把它们按关键词惰性挂载能
   * 显著降低常规对话的 prompt 大小，需要时再按需展开。
   */
  keywords?: string[];

  /**
   * 是否启用 `keywords` 惰性装配。默认 `false`（保持"总是暴露"语义）。
   *
   * 启用后必须提供非空 `keywords`；`validateEngineConfig` 会在配置阶段
   * 显式拒绝不合规的组合。
   */
  expandOnKeywordMatch?: boolean;
}

/**
 * MCP Server 配置集合。
 *
 * 键名即 `serverId`——同时也是 namespaced 工具名的前缀（典型形式
 * `<serverId>__<toolName>`），用于多 server 场景下避免冲突。命名约束：
 * 仅允许 `[a-zA-Z0-9_-]{1,48}`；违反约束会在 `validateEngineConfig`
 * 阶段显式抛 `ValidationError`。
 */
export interface McpServersConfig {
  [serverId: string]: McpServerConfig | undefined;
}

/**
 * Agentic 工具循环（`tool-use` 内置 Sub-flow）的执行约束。
 *
 * ADR-0002 阶段 2 引入：让 "LLM → 工具调用 → LLM → 最终回复" 这条循环在 core 层
 * 有明确的边界与默认值，避免无限循环、并发爆炸、缺失审批。
 */
export interface ToolLoopConfig {
  /**
   * 单次请求里 LLM 思考 + 工具调用的最大往返步数。
   *
   * 超出上限则 `tool-use` 子流程抛 `TOOL_LOOP_STEPS_EXHAUSTED`。
   * 默认 25，满足代码编辑等复杂多步工作流；防止 runaway 同时覆盖更深任务链。
   */
  maxSteps?: number;
  /**
   * 单轮中并发执行工具的上限（LLM 请求多工具时生效）。
   *
   * `1` 表示强制串行；`>= 2` 允许并发。默认 `4`，与 `runtime.maxConcurrency`
   * 解耦，方便对 Agentic Loop 单独收紧。
   */
  parallelism?: number;
  /**
   * 全局覆盖：是否把所有工具视作 `requiresApproval=true`，强制走审批闸门。
   *
   * 默认 `false`；仅依赖 ToolDescriptor 自身的 `requiresApproval` 字段。
   * 若设为 `true`，工具 `withDefaultGate` 会对每一次调用都发起审批请求。
   */
  requireApprovalGlobal?: boolean;
  /**
   * 短任务路由策略（性能优化）。
   *
   * 当本轮 `tool-use` 子流程满足以下条件时，将能力路由从 `high-reasoning`
   * 降级到指定的 `capability`（典型为 `fast-cheap`），以显著降低 wall time：
   *   - `input.toolNames.length` ≤ `maxToolNames`（典型 1）
   *   - `input.prompt.length` ≤ `maxPromptChars`（典型 120）
   *
   * 命中条件意味着这是一次"简单工具调用 + 简短结果总结"的链路，无需上 `gpt-4o`
   * 之类的强推理模型；切到 `gpt-4o-mini` 等廉价模型可把 5-6s/轮 的延迟压到 1-2s。
   *
   * 多工具组合 / 长 prompt 不命中条件时，仍走 `high-reasoning` → `intent` →
   * `fast-cheap` 的原有回退顺序，保持复杂任务质量。
   */
  shortTaskRoute?: {
    /** 是否启用短任务路由降级。默认 `false`（关闭以保持向后兼容）。 */
    enabled?: boolean;
    /** 命中后路由到的能力标签。默认 `"fast-cheap"`。必须能在 `capabilityMapping` 中找到对应映射。 */
    capability?: string;
    /** 命中条件：`input.toolNames` 数量上限（含）。默认 `1`。 */
    maxToolNames?: number;
    /** 命中条件：`input.prompt` 字符长度上限（含）。默认 `120`。 */
    maxPromptChars?: number;
  };
}

/**
 * 引擎配置。
 */
export interface EngineConfig {
  registry: {
    descriptorPaths: string[];
    enableVectorIndexing: boolean;
  };
  runtime: {
    planMode: boolean;
    maxConcurrency: number;
    defaultTaskTimeoutMs: number;
    failFast: boolean;
    /**
     * Agentic 工具循环默认约束（ADR-0002）。
     *
     * 省略时使用 `maxSteps=8 / parallelism=4 / requireApprovalGlobal=false` 的
     * 默认值；可通过 `tachu.config.ts` 按项目覆盖。
     */
    toolLoop?: ToolLoopConfig;
    /**
     * 为 `true` 时，`direct-answer` 子流程优先走 Provider `chatStream`（底层 `stream=true`），
     * 并通过 `StreamChunk.delta` 向宿主推送正文分片（需 Engine 注入 `onAssistantDelta`）。
     * 经 `validateEngineConfig` 时默认为 `true`；显式设为 `false` 则全程非流式 `chat()`。
     */
    streamingOutput?: boolean;
  };
  memory: {
    contextTokenLimit: number;
    compressionThreshold: number;
    headKeep: number;
    tailKeep: number;
    archivePath: string;
    vectorIndexLimit: number;
    /**
     * 主 PromptAssembler 工作时使用的 model context 上限（tokens）。
     *
     * 默认 128_000，可被具体任务/model 的能力指纹覆盖。若设置为 <= 0 则视作未配置。
     */
    maxContextTokens?: number;
    /**
     * 长期记忆召回条数上限，作为 `memorySystem.recall` 的默认 topK。
     *
     * 默认 5。
     */
    recallTopK?: number;
    /**
     * 对话历史的持久化模式（patch-02-session-persistence）。
     *
     * - `"memory"`：仅进程内 `InMemoryMemorySystem`；适合服务端按需装配自己的持久化层
     * - `"fs"`：使用 `@tachu/extensions` 的 `FsMemorySystem`，按 `sessionId` 分片写入
     *   `persistDir/<sessionId>.jsonl`，跨进程 `chat --resume` 能自动还原历史
     *
     * 默认 `"fs"`（由 `validateEngineConfig` 回填）。SDK 用户若需纯内存可显式改为
     * `"memory"`，或通过 `EngineDependencies.memorySystem` 直接注入自定义实现。
     *
     * 注意：此字段**仅由外层装配器（engine-factory / 宿主）消费**。`@tachu/core`
     * `Engine` 构造器默认不读此字段——当调用方未注入 `memorySystem` 时一律回退到
     * `InMemoryMemorySystem`。`"fs"` 的生效路径是 `@tachu/cli engine-factory` 自动
     * 通过 memorySystem factory 回调装配 `FsMemorySystem`。
     */
    persistence?: "memory" | "fs";
    /**
     * 持久化目录（`persistence === "fs"` 时生效）。
     *
     * 相对路径基于 `process.cwd()`。默认 `.tachu/memory`。文件布局：
     *
     * ```
     * <persistDir>/
     *   <sessionId-sanitized>.jsonl   # 每行一条 MemoryEntry (JSON)
     * ```
     *
     * 与 `archivePath`（向量归档，单文件）职责分离：`persistDir` 为"热路径"，
     * 每次 append 即落盘；`archivePath` 为"冷路径"，仅在 `compress()` 时触发。
     */
    persistDir?: string;
  };
  budget: {
    maxTokens: number;
    maxToolCalls: number;
    maxWallTimeMs: number;
  };
  safety: {
    maxInputSizeBytes: number;
    maxRecursionDepth: number;
    workspaceRoot: string;
    promptInjectionPatterns: string[];
    /**
     * 是否在 CLI / 宿主层启用 `@tachu/extensions` 提供的默认 Tool 闸门
     * (`withDefaultGate`)。
     *
     * 默认 `false`（opt-in）。为 `true` 时由 engine-factory 在装配 TaskExecutor 时
     * 外层套上 `withDefaultGate`，并套用 `run-shell` 默认命令黑名单等策略。
     */
    defaultGate?: boolean;
    /**
     * 额外允许工具读写的根目录白名单。
     *
     * 工作区沙箱默认只放行 `workspaceRoot`；此字段用于声明"工作区之外也允许
     * 访问"的目录（如自建缓存目录、外置资源目录等）。引擎宿主可能还会额外
     * 注入平台临时目录（典型如 `os.tmpdir()`），见 `@tachu/cli` 的
     * engine-factory 装配逻辑。
     *
     * 语义上这是**静态、长期**的白名单；面向"本次工具调用内用户明确授权一次"
     * 的场景，请看 `ToolApprovalDecision`（审批通过会让 tool-use subflow
     * 在 `TaskNode.metadata.approvalGranted` 打上标记，宿主可据此豁免沙箱）。
     *
     * 支持绝对路径；相对路径由宿主按自己的 cwd 展开再传入。留空视作未启用。
     */
    allowedWriteRoots?: string[];
    /**
     * `run-shell` 自动审批白名单（正则源字符串数组）。
     *
     * 当某次 `run-shell` 调用满足以下条件时，跳过 `onBeforeToolCall` 审批回调：
     *   1. 工具名是 `run-shell`
     *   2. `input.command` 字符串命中本数组中**任一**正则
     *   3. `input.args` 为空（数组未提供或长度 0）—— 一旦带 args，潜在风险面扩大，
     *      为安全起见仍走人工审批
     *
     * 字段为正则**源字符串**数组，由 core 在 `validateEngineConfig` 阶段编译为 RegExp。
     * 非法正则会在装配阶段显式抛 `ValidationError`，避免运行时静默失效。
     *
     * 典型默认值（init 模板写入）：`date / pwd / whoami / hostname / uname / uptime / cal / printenv`
     * 等纯只读命令。生产可按需扩充或清空。
     *
     * 留空（默认）→ 所有 `run-shell` 调用一律按 `descriptor.requiresApproval` 决定是否审批。
     */
    shellAutoApprovePatterns?: string[];
    /**
     * `run-shell` 执行器的环境变量白名单。
     *
     * 覆盖内置默认白名单（PATH / HOME / LANG / TERM / USER / SHELL /
     * NODE_ENV / BUN_INSTALL / PNPM_HOME / NPM_CONFIG_PREFIX）。
     * 同时也可通过进程环境变量 `TACHU_SHELL_ENV_ALLOWLIST`（逗号分隔）覆盖。
     */
    shellEnvAllowlist?: string[];
    /**
     * `run-shell` 执行器的危险命令黑名单（正则源字符串数组）。
     *
     * 每条 pattern 会被编译为 RegExp 并与 input.command 匹配；命中则抛
     * `ValidationError("SHELL_COMMAND_DENIED", ...)`，阻止执行。
     * 也可通过进程环境变量 `TACHU_SHELL_DENY_PATTERNS`（`||` 分隔）追加额外 pattern。
     */
    shellDenyPatterns?: string[];
  };
  models: {
    capabilityMapping: Record<string, ModelRoute>;
    providerFallbackOrder: string[];
  };
  /**
   * 各 Provider 的连接配置（可选）。
   *
   * 仅会影响内置 Provider 构造（OpenAI / Anthropic 等）。自定义 Provider 若需
   * 连接参数，请走 `createEngine(config, { providers: [...] })` 自行注入。
   */
  providers?: ProvidersConfig;
  /**
   * MCP Server 配置（可选）。
   *
   * 由宿主装配层（典型：`@tachu/cli` 的 engine-factory）在启动期读取并
   * 建立 `McpStdioAdapter` / `McpSseAdapter`，把远端工具列表注入
   * `DescriptorRegistry` 并在 `TaskExecutor` 层注册路由。
   *
   * `@tachu/core` 自身不直接消费本字段——仅负责 schema 校验。SDK 用户
   * 若绕过 CLI 自行组装，可参考 `@tachu/cli` 的 `mountMcpServers()` 实现。
   */
  mcpServers?: McpServersConfig;
  observability: {
    enabled: boolean;
    maskSensitiveData: boolean;
  };
  hooks: {
    writeHookTimeout: number;
    failureBehavior: "continue" | "abort";
  };
  /**
   * Intent 阶段分类可扩展配置。
   *
   * Core 只内置真正普遍的 complex 信号（URL / 文件路径 / 实时数据等）；
   * 领域特定的匹配规则（shell 命令名、项目文件修改动词等）由业务层通过此字段注入，
   * 与引擎内置规则取并集生效。
   */
  intent?: {
    /**
     * 额外的强 complex 正则源串（JavaScript RegExp 源，不含 `/` 围栏）。
     *
     * 每条源串会在运行时被编译为 `/pattern/ui` 并加入 complex 快速路径检测。
     * 编译失败时 `validateEngineConfig` 会以 `VALIDATION_INVALID_CONFIG` 拒绝。
     */
    additionalComplexPatterns?: string[];
    /**
     * 注入到 intent 分类 system prompt 末尾的 few-shot 示例。
     *
     * 格式与内置示例相同；由业务层补充领域样本，不改变 core prompt 本体。
     */
    fewShotExamples?: Array<{
      input: string;
      complexity: "simple" | "complex";
      intent: string;
    }>;
  };
  /**
   * Tool-use sub-flow 可扩展配置。
   *
   * Core 的 tool-use system prompt 只描述通用循环语义；领域工作流指导
   * （如编码 Agent 的"改前先读 / 改后 typecheck"）通过此字段追加，不污染 core。
   */
  toolUse?: {
    /**
     * 追加到 tool-use system prompt 末尾的补充指令。
     *
     * 典型用途：编码 Agent 的 workflow 指南、特定领域的工具使用惯例。
     */
    systemPromptSuffix?: string;
  };
}

