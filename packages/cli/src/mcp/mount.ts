import { isAbsolute, resolve as resolvePath } from "node:path";
import type {
  EngineConfig,
  McpToolAdapter,
  ObservabilityEmitter,
  ToolDescriptor,
} from "@tachu/core";
import { McpSseAdapter, McpStdioAdapter, type ToolExecutor } from "@tachu/extensions";

/**
 * `EngineConfig.mcpServers` 的类型别名。
 *
 * 直接通过索引从 `EngineConfig` 取字段，避免对 core 新加的 `McpServerConfig` /
 * `McpServersConfig` export 名形成硬耦合（后续 core 重命名时不用再同步改
 * CLI 端的 import 路径）。
 */
type McpServersConfigType = NonNullable<EngineConfig["mcpServers"]>;
type McpServerConfigType = NonNullable<McpServersConfigType[string]>;

/** 默认连接超时，对齐主流 MCP 客户端的常用默认值。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** MCP 工具名 namespace 分隔符。采用 `<serverId>__<tool>` 风格避免冲突。 */
const TOOL_NAME_NAMESPACE_SEP = "__";

/**
 * 按 serverId + transport + config 创建 McpToolAdapter 的工厂签名。
 *
 * 引入工厂而非直接 `new McpStdioAdapter(...)` 的目的：单元测试可以注入
 * in-memory mock 避免真实 spawn / 网络连接；宿主也能在后续注入自定义
 * transport（如 WebSocket）而不需要再改 mount 逻辑。
 */
export type McpAdapterFactory = (
  serverId: string,
  transport: "stdio" | "sse",
  config: ResolvedMcpServerConfig,
) => McpToolAdapter;

/**
 * 装配期把 `McpServerConfig` 规范化后的形态：
 *
 * - `transport` 已推断完毕
 * - `cwd` 已按宿主 cwd 展开成绝对路径
 * - `timeoutMs` / `connectTimeoutMs` 已套用默认值
 */
export interface ResolvedMcpServerConfig {
  serverId: string;
  transport: "stdio" | "sse";
  /** stdio */
  command?: string;
  /** stdio */
  args?: string[];
  /** stdio */
  env?: Record<string, string>;
  /** stdio：绝对路径 */
  cwd?: string;
  /** sse */
  url?: string;
  /** sse */
  headers?: Record<string, string>;
  /** 单次 callTool 超时；`0` 关闭 adapter 层超时 */
  timeoutMs: number;
  /** 连接超时；`0` 关闭 */
  connectTimeoutMs: number;
  allowTools: readonly string[];
  denyTools: readonly string[];
  tags: readonly string[];
  requiresApproval: boolean;
  /** 面向 LLM 的 server 级一行摘要，装配时会拼到该 server 每个工具的 `description` 前。 */
  description?: string;
  /** 触发关键词（与 expandOnKeywordMatch 搭配启用惰性装配）。 */
  keywords: readonly string[];
  /** 惰性装配开关；开启后仅在命中 keywords 时才注册该 server 的工具。 */
  expandOnKeywordMatch: boolean;
}

/**
 * `mountMcpServers` 装配选项。
 */
export interface MountMcpServersOptions {
  /** 宿主 cwd；stdio `cwd` 相对路径会基于此展开。 */
  cwd: string;
  /** 可观测事件发射器；未注入时使用 console.warn 兜底。 */
  observability?: ObservabilityEmitter;
  /** Adapter 工厂；测试注入 mock 时使用。默认构造 `McpStdioAdapter` / `McpSseAdapter`。 */
  adapterFactory?: McpAdapterFactory;
}

/**
 * 单个 server 的装配摘要（成功或失败都会被记录）。
 */
export interface MountedMcpServerSummary {
  serverId: string;
  transport: "stdio" | "sse";
  /** 连接 + listTools 耗时（毫秒） */
  durationMs: number;
  /** 连接后 listTools 返回的工具数量（含 allow/deny 过滤前原始计数） */
  toolsListed: number;
  /** 经 allow/deny 过滤后最终注册的工具数量 */
  toolsRegistered: number;
  /** 装配结果 */
  status: "ok" | "disabled" | "failed";
  /** 失败原因（`status=failed` 时非空） */
  error?: string;
  /** 本 server 是否启用了 `expandOnKeywordMatch` 惰性装配 */
  gated: boolean;
  /** 惰性装配的触发关键词（仅 `gated=true` 时非空） */
  keywords: readonly string[];
  /** 面向 LLM 的 server 级描述（若配置） */
  description?: string;
}

/**
 * 惰性装配的单组描述符（按 serverId 聚合）。
 *
 * 用于 `setupMcpServersFromConfig` 在每轮对话开始时按 keywords 动态注册 /
 * 注销该组 descriptors 到 DescriptorRegistry。
 */
export interface GatedMcpGroup {
  serverId: string;
  /** 触发关键词（小写匹配输入；任一命中即激活整组） */
  keywords: readonly string[];
  /** 面向 LLM 的 server 级描述（若配置） */
  description?: string;
  /** 该组所有工具的描述符（已 namespaced，尚未注册到 registry） */
  descriptors: ReadonlyArray<ToolDescriptor>;
}

/**
 * `mountMcpServers` 返回值。
 */
export interface MountedMcpServers {
  /** 每个 serverId 的装配摘要 */
  servers: ReadonlyArray<MountedMcpServerSummary>;
  /**
   * 常驻工具描述符——立即注册到 Registry（与 v0.1 语义一致）。
   *
   * 来源：未启用 `expandOnKeywordMatch` 的 MCP server 的全部工具。
   */
  descriptors: ReadonlyArray<ToolDescriptor>;
  /**
   * 惰性工具描述符——按 serverId 聚合；仅在当轮输入命中对应 keywords 时
   * 才注册到 Registry；否则保持不可见以压缩 prompt。
   */
  gatedGroups: ReadonlyArray<GatedMcpGroup>;
  /**
   * 要合并进 engine-factory 的 toolExecutor 映射（key 与 descriptor.name 一致）。
   *
   * 注：不论是否 gated，executors 都**全量返回**。engine-factory 合并后整个
   * 进程生命周期可用；gating 只影响 Registry 中 LLM 可见性，不影响后端执行路径。
   */
  executors: Readonly<Record<string, ToolExecutor>>;
  /**
   * 断开全部已连接 adapter；幂等调用安全。
   *
   * 典型在 CLI 命令 finally 分支、engine.dispose 之后调用。单个 adapter
   * 断开失败仅打一条 observability warning，不抛出。
   */
  disconnectAll(): Promise<void>;
}

/**
 * 从 `tachu.config.ts` 的 `mcpServers` 装配出一组 MCP 适配器，并把它们的
 * 工具注入到 DescriptorRegistry / TaskExecutor 的最小协议装配层。
 *
 * 行为要点（生产级）：
 * - **单个 server 失败不阻塞其他**：连接 / listTools 超时或抛错时，仅把该
 *   server 标记为 `status: "failed"`，不影响其他 server 的可用性；同时
 *   emit `warning` 事件便于可观测性后端告警。
 * - **连接超时**：`adapter.connect()` 外层套 `connectTimeoutMs` AbortController
 *   +`Promise.race`；超时后尝试 `disconnect` 释放部分建立的 transport。
 * - **工具 namespace**：所有工具的 `descriptor.name` 统一改写为
 *   `<serverId>__<origToolName>`，防止多 server 间冲突；原始工具名保存在
 *   executors 的 closure 里，执行时透传给 adapter。
 * - **允许/拒绝 + 审批透传**：`allowTools` / `denyTools` 在装配期过滤工具；
 *   `requiresApproval: true` 与 `ToolDescriptor.requiresApproval` 做 OR。
 * - **abortSignal 透传**：wrapper 执行器把 `ToolExecutionContext.abortSignal`
 *   直接传给 `adapter.executeTool({ signal })`，实现取消传播到 MCP 协议。
 *
 * @param raw `EngineConfig.mcpServers`（可为 undefined）
 * @param options 装配选项
 * @returns 已装配的 adapters 聚合结果
 */
export async function mountMcpServers(
  raw: McpServersConfigType | undefined,
  options: MountMcpServersOptions,
): Promise<MountedMcpServers> {
  // raw ?? {} 的字面量 `{}` 会让 TS 把 entries 的 value 缩窄为 never；
  // 显式 cast 回 McpServersConfigType，保留真正的 value 类型。
  const entries = Object.entries(
    (raw ?? {}) as McpServersConfigType,
  ) as Array<[string, McpServerConfigType | undefined]>;
  const adapterFactory = options.adapterFactory ?? defaultAdapterFactory;

  const summaries: MountedMcpServerSummary[] = [];
  const descriptors: ToolDescriptor[] = [];
  const gatedGroups: GatedMcpGroup[] = [];
  const executors: Record<string, ToolExecutor> = {};
  const connected: Array<{ serverId: string; adapter: McpToolAdapter }> = [];

  for (const [serverId, rawServer] of entries) {
    if (!rawServer) {
      continue;
    }
    if (rawServer.disabled === true) {
      summaries.push({
        serverId,
        transport: inferTransport(rawServer),
        durationMs: 0,
        toolsListed: 0,
        toolsRegistered: 0,
        status: "disabled",
        gated: false,
        keywords: [],
        ...(typeof rawServer.description === "string"
          ? { description: rawServer.description }
          : {}),
      });
      continue;
    }

    const resolved = resolveServerConfig(serverId, rawServer, options.cwd);
    const startedAt = Date.now();
    let adapter: McpToolAdapter | null = null;

    try {
      adapter = adapterFactory(serverId, resolved.transport, resolved);
      await withConnectTimeout(
        adapter.connect(resolved.transport === "sse" ? resolved.url ?? "" : ""),
        resolved.connectTimeoutMs,
        serverId,
      );
      const remoteTools = await adapter.listTools();
      const filtered = remoteTools.filter((tool) =>
        shouldAcceptTool(tool.name, resolved.allowTools, resolved.denyTools),
      );

      const groupDescriptors: ToolDescriptor[] = [];
      for (const remote of filtered) {
        const namespacedName = buildNamespacedName(serverId, remote.name);
        if (executors[namespacedName]) {
          emitWarning(options.observability, serverId, {
            message: `跳过重名工具 ${namespacedName}（同 serverId 下出现 ${remote.name} 的重复声明）`,
          });
          continue;
        }
        const descriptor = wrapDescriptor(namespacedName, remote, resolved);
        groupDescriptors.push(descriptor);
        executors[namespacedName] = buildMcpExecutor({
          adapter,
          serverId,
          namespacedName,
          remoteName: remote.name,
        });
      }

      if (resolved.expandOnKeywordMatch && resolved.keywords.length > 0) {
        gatedGroups.push({
          serverId,
          keywords: resolved.keywords,
          ...(resolved.description !== undefined
            ? { description: resolved.description }
            : {}),
          descriptors: groupDescriptors,
        });
      } else {
        descriptors.push(...groupDescriptors);
      }

      connected.push({ serverId, adapter });
      summaries.push({
        serverId,
        transport: resolved.transport,
        durationMs: Date.now() - startedAt,
        toolsListed: remoteTools.length,
        toolsRegistered: groupDescriptors.length,
        status: "ok",
        gated: resolved.expandOnKeywordMatch && resolved.keywords.length > 0,
        keywords: resolved.keywords,
        ...(resolved.description !== undefined
          ? { description: resolved.description }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (adapter) {
        // 尽力回收；吞掉二次错误，防止污染主要 failure。
        await adapter.disconnect().catch(() => undefined);
      }
      emitWarning(options.observability, serverId, {
        message: `连接 MCP server ${serverId} 失败：${message}`,
      });
      summaries.push({
        serverId,
        transport: resolved.transport,
        durationMs: Date.now() - startedAt,
        toolsListed: 0,
        toolsRegistered: 0,
        status: "failed",
        error: message,
        gated: resolved.expandOnKeywordMatch && resolved.keywords.length > 0,
        keywords: resolved.keywords,
        ...(resolved.description !== undefined
          ? { description: resolved.description }
          : {}),
      });
    }
  }

  let disposed = false;
  const disconnectAll = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await Promise.all(
      connected.map(async ({ serverId, adapter }) => {
        try {
          await adapter.disconnect();
        } catch (err) {
          emitWarning(options.observability, serverId, {
            message: `断开 MCP server ${serverId} 失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }),
    );
  };

  return {
    servers: summaries,
    descriptors,
    gatedGroups,
    executors,
    disconnectAll,
  };
}

/**
 * 判定 `input` 是否命中任一 keyword（大小写不敏感，按子串匹配）。
 *
 * 设计取舍：
 * - 不做分词、词干归一，保持"所见即所得"，方便用户调试
 * - 中英混写的关键词都能直接写（"文档" / "docs"），因为 JS 的 `toLowerCase`
 *   对中文是 no-op，对英文做小写归一
 * - 输入非字符串时（比如结构化 JSON prompt），先 `JSON.stringify` 再匹配；
 *   这也让 keywords 可以命中嵌套字段里的业务关键词
 */
export const matchesKeywords = (
  input: unknown,
  keywords: readonly string[],
): boolean => {
  if (keywords.length === 0) return false;
  const text = (typeof input === "string" ? input : JSON.stringify(input ?? ""))
    .toLowerCase();
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
};

const defaultAdapterFactory: McpAdapterFactory = (_serverId, transport, config) => {
  if (transport === "sse") {
    return new McpSseAdapter({
      url: config.url ?? "",
      serverId: config.serverId,
      ...(config.headers ? { headers: config.headers } : {}),
      defaultTimeoutMs: config.timeoutMs,
    });
  }
  return new McpStdioAdapter({
    command: config.command ?? "",
    serverId: config.serverId,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    defaultTimeoutMs: config.timeoutMs,
  });
};

const inferTransport = (server: McpServerConfigType): "stdio" | "sse" => {
  if (server.transport) return server.transport;
  return typeof server.url === "string" && server.url.length > 0 ? "sse" : "stdio";
};

const resolveServerConfig = (
  serverId: string,
  server: McpServerConfigType,
  hostCwd: string,
): ResolvedMcpServerConfig => {
  const transport = inferTransport(server);
  const resolved: ResolvedMcpServerConfig = {
    serverId,
    transport,
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : 30_000,
    connectTimeoutMs:
      typeof server.connectTimeoutMs === "number"
        ? server.connectTimeoutMs
        : DEFAULT_CONNECT_TIMEOUT_MS,
    allowTools: server.allowTools ? [...server.allowTools] : [],
    denyTools: server.denyTools ? [...server.denyTools] : [],
    tags: server.tags ? [...server.tags] : [],
    requiresApproval: server.requiresApproval === true,
    keywords: server.keywords ? [...server.keywords] : [],
    expandOnKeywordMatch: server.expandOnKeywordMatch === true,
  };

  if (server.command !== undefined) resolved.command = server.command;
  if (server.args !== undefined) resolved.args = [...server.args];
  if (server.env !== undefined) resolved.env = { ...server.env };
  if (server.cwd !== undefined) {
    resolved.cwd = isAbsolute(server.cwd) ? server.cwd : resolvePath(hostCwd, server.cwd);
  }
  if (server.url !== undefined) resolved.url = server.url;
  if (server.headers !== undefined) resolved.headers = { ...server.headers };
  if (server.description !== undefined) resolved.description = server.description;

  return resolved;
};

const shouldAcceptTool = (
  name: string,
  allow: readonly string[],
  deny: readonly string[],
): boolean => {
  if (allow.length > 0 && !allow.includes(name)) return false;
  if (deny.includes(name)) return false;
  return true;
};

/**
 * 构造 namespaced 工具名，默认形如 `remoteKb__readDoc`。
 *
 * 对外暴露（`export`）是为了让 CLI 命令层在审计日志、错误提示里复用
 * 同一个命名规则；同时方便用户在 `.tachu/rules` / skills 里按该前缀引用
 * 具体的 MCP 工具。
 */
export const buildNamespacedName = (serverId: string, toolName: string): string =>
  `${serverId}${TOOL_NAME_NAMESPACE_SEP}${toolName}`;

const wrapDescriptor = (
  namespacedName: string,
  remote: ToolDescriptor,
  server: ResolvedMcpServerConfig,
): ToolDescriptor => {
  const tagSet = new Set<string>();
  for (const t of remote.tags ?? []) tagSet.add(t);
  for (const t of server.tags) tagSet.add(t);
  tagSet.add(`mcp:${server.serverId}`);

  // 把 server 级 description 拼到工具 description 前：LLM 看到 namespaced
  // 工具时能立即理解其所属业务域，提升规划阶段的路由准确度。
  const descriptionPrefix = server.description
    ? `[${server.serverId}: ${server.description}] `
    : "";
  const composedDescription = `${descriptionPrefix}${remote.description ?? ""}`;

  const descriptor: ToolDescriptor = {
    ...remote,
    name: namespacedName,
    description: composedDescription,
    requiresApproval: remote.requiresApproval === true || server.requiresApproval,
    execute: `mcp:${server.serverId}:${remote.name}`,
    tags: [...tagSet],
  };
  return descriptor;
};

interface BuildMcpExecutorOptions {
  adapter: McpToolAdapter;
  serverId: string;
  namespacedName: string;
  remoteName: string;
}

const buildMcpExecutor = ({
  adapter,
  serverId,
  namespacedName,
  remoteName,
}: BuildMcpExecutorOptions): ToolExecutor => {
  return async (input, context) => {
    try {
      return await adapter.executeTool(remoteName, input ?? {}, {
        signal: context.abortSignal,
        requestId: buildRequestId(serverId, context),
      });
    } catch (err) {
      // 附加 namespaced name 便于观测端定位；不吃掉原始错误信息。
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP 工具调用失败 ${namespacedName}：${message}`);
    }
  };
};

const buildRequestId = (
  serverId: string,
  context: { session: { id: string } },
): string => {
  return `mcp-${serverId}-${context.session.id}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

/**
 * 把 `adapter.connect()` 套上连接超时。`connectTimeoutMs <= 0` 时直接返回
 * 原 promise（相当于关闭超时）。
 */
const withConnectTimeout = async <T>(
  p: Promise<T>,
  timeoutMs: number,
  serverId: string,
): Promise<T> => {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`MCP server ${serverId} 连接超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const emitWarning = (
  observability: ObservabilityEmitter | undefined,
  serverId: string,
  payload: Record<string, unknown>,
): void => {
  if (observability) {
    observability.emit({
      timestamp: Date.now(),
      traceId: `mcp-mount-${serverId}`,
      sessionId: "mcp-mount",
      phase: "mcp-mount",
      type: "warning",
      payload: { serverId, ...payload },
    });
  } else {
    // 退化到 stderr，避免 CLI 静默吞错。
    const message =
      typeof payload.message === "string"
        ? payload.message
        : JSON.stringify(payload);
    console.warn(`[tachu][mcp][${serverId}] ${message}`);
  }
};
