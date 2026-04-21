import { ValidationError } from "../errors";
import type {
  EngineConfig,
  McpServerConfig,
  McpServersConfig,
  ModelRoute,
  ProviderConnectionConfig,
  ProvidersConfig,
} from "../types";

const DEFAULT_CONFIG: EngineConfig = {
  registry: {
    descriptorPaths: [".tachu/rules", ".tachu/skills", ".tachu/tools", ".tachu/agents"],
    enableVectorIndexing: true,
  },
  runtime: {
    planMode: false,
    maxConcurrency: 4,
    defaultTaskTimeoutMs: 30_000,
    failFast: false,
    toolLoop: {
      maxSteps: 8,
      parallelism: 4,
      requireApprovalGlobal: false,
    },
    streamingOutput: true,
  },
  memory: {
    contextTokenLimit: 12_000,
    compressionThreshold: 0.8,
    headKeep: 6,
    tailKeep: 8,
    archivePath: ".tachu/archive/memory.jsonl",
    vectorIndexLimit: 10_000,
    maxContextTokens: 128_000,
    recallTopK: 5,
    persistence: "fs",
    persistDir: ".tachu/memory",
  },
  budget: {
    maxTokens: 80_000,
    maxToolCalls: 40,
    maxWallTimeMs: 300_000,
  },
  safety: {
    maxInputSizeBytes: 10 * 1024 * 1024,
    maxRecursionDepth: 10,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [
      "ignore previous instructions",
      "system override",
      "reveal hidden prompt",
      "bypass safety",
    ],
    defaultGate: false,
    allowedWriteRoots: [],
  },
  models: {
    capabilityMapping: {
      "high-reasoning": { provider: "noop", model: "dev-large" },
      "fast-cheap": { provider: "noop", model: "dev-small" },
      intent: { provider: "noop", model: "dev-medium" },
      planning: { provider: "noop", model: "dev-large" },
      validation: { provider: "noop", model: "dev-medium" },
    },
    providerFallbackOrder: ["noop"],
  },
  observability: {
    enabled: true,
    maskSensitiveData: true,
  },
  hooks: {
    writeHookTimeout: 5_000,
    failureBehavior: "continue",
  },
};

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ValidationError.invalidConfig(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
};

const asNumber = (
  value: unknown,
  field: string,
  fallback: number,
  options?: { min?: number; max?: number },
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw ValidationError.invalidConfig(`${field} 必须是数字`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw ValidationError.invalidConfig(`${field} 必须 >= ${options.min}`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw ValidationError.invalidConfig(`${field} 必须 <= ${options.max}`);
  }
  return value;
};

const asBoolean = (value: unknown, field: string, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw ValidationError.invalidConfig(`${field} 必须是布尔值`);
  }
  return value;
};

const asString = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw ValidationError.invalidConfig(`${field} 必须是字符串`);
  }
  return value;
};

const asStringArray = (
  value: unknown,
  field: string,
  fallback: string[],
): string[] => {
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw ValidationError.invalidConfig(`${field} 必须是字符串数组`);
  }
  return value;
};

const OPTIONAL_STRING_KEYS = [
  "apiKey",
  "baseURL",
  "organization",
  "project",
] as const satisfies readonly (keyof ProviderConnectionConfig)[];

const parseProviderConnection = (
  value: unknown,
  field: string,
): ProviderConnectionConfig => {
  const raw = asRecord(value, field);
  const out: ProviderConnectionConfig = {};
  for (const key of OPTIONAL_STRING_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string") {
        throw ValidationError.invalidConfig(`${field}.${key} 必须是字符串`);
      }
      out[key] = raw[key] as string;
    }
  }
  if (raw.timeoutMs !== undefined) {
    out.timeoutMs = asNumber(raw.timeoutMs, `${field}.timeoutMs`, 0, { min: 1 });
  }
  if (raw.extra !== undefined) {
    if (!raw.extra || typeof raw.extra !== "object" || Array.isArray(raw.extra)) {
      throw ValidationError.invalidConfig(`${field}.extra 必须是对象`);
    }
    out.extra = raw.extra as Record<string, unknown>;
  }
  return out;
};

/** serverId 命名约束：仅允许 `[a-zA-Z0-9_-]{1,48}`，与 LLM function-call 安全前缀兼容。 */
const MCP_SERVER_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;

const asStringMap = (
  value: unknown,
  field: string,
): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ValidationError.invalidConfig(`${field} 必须是 string→string 映射`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw ValidationError.invalidConfig(`${field}.${k} 必须是字符串`);
    }
    out[k] = v;
  }
  return out;
};

const parseMcpServer = (value: unknown, field: string): McpServerConfig => {
  const raw = asRecord(value, field);
  const out: McpServerConfig = {};

  if (raw.transport !== undefined) {
    if (raw.transport !== "stdio" && raw.transport !== "sse") {
      throw ValidationError.invalidConfig(
        `${field}.transport 非法值："${String(raw.transport)}"；允许：stdio | sse`,
        { field: `${field}.transport`, value: raw.transport },
      );
    }
    out.transport = raw.transport;
  }

  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      throw ValidationError.invalidConfig(`${field}.command 必须是非空字符串`);
    }
    out.command = raw.command;
  }
  if (raw.args !== undefined) {
    if (
      !Array.isArray(raw.args) ||
      raw.args.some((item) => typeof item !== "string")
    ) {
      throw ValidationError.invalidConfig(`${field}.args 必须是字符串数组`);
    }
    out.args = [...(raw.args as string[])];
  }
  if (raw.env !== undefined) {
    out.env = asStringMap(raw.env, `${field}.env`);
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string") {
      throw ValidationError.invalidConfig(`${field}.cwd 必须是字符串`);
    }
    out.cwd = raw.cwd;
  }

  if (raw.url !== undefined) {
    if (typeof raw.url !== "string" || raw.url.trim() === "") {
      throw ValidationError.invalidConfig(`${field}.url 必须是非空字符串`);
    }
    try {
      // 仅做语法校验；值本身保留原样，不做规范化。
      // eslint-disable-next-line no-new
      new URL(raw.url);
    } catch {
      throw ValidationError.invalidConfig(
        `${field}.url 不是合法 URL："${raw.url}"`,
        { field: `${field}.url`, value: raw.url },
      );
    }
    out.url = raw.url;
  }
  if (raw.headers !== undefined) {
    out.headers = asStringMap(raw.headers, `${field}.headers`);
  }

  if (raw.disabled !== undefined) {
    out.disabled = asBoolean(raw.disabled, `${field}.disabled`, false);
  }
  if (raw.timeoutMs !== undefined) {
    out.timeoutMs = asNumber(raw.timeoutMs, `${field}.timeoutMs`, 0, { min: 0 });
  }
  if (raw.connectTimeoutMs !== undefined) {
    out.connectTimeoutMs = asNumber(
      raw.connectTimeoutMs,
      `${field}.connectTimeoutMs`,
      0,
      { min: 0 },
    );
  }
  if (raw.allowTools !== undefined) {
    out.allowTools = asStringArray(raw.allowTools, `${field}.allowTools`, []);
  }
  if (raw.denyTools !== undefined) {
    out.denyTools = asStringArray(raw.denyTools, `${field}.denyTools`, []);
  }
  if (raw.tags !== undefined) {
    out.tags = asStringArray(raw.tags, `${field}.tags`, []);
  }
  if (raw.requiresApproval !== undefined) {
    out.requiresApproval = asBoolean(
      raw.requiresApproval,
      `${field}.requiresApproval`,
      false,
    );
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") {
      throw ValidationError.invalidConfig(`${field}.description 必须是字符串`);
    }
    out.description = raw.description;
  }
  if (raw.keywords !== undefined) {
    out.keywords = asStringArray(raw.keywords, `${field}.keywords`, []);
  }
  if (raw.expandOnKeywordMatch !== undefined) {
    out.expandOnKeywordMatch = asBoolean(
      raw.expandOnKeywordMatch,
      `${field}.expandOnKeywordMatch`,
      false,
    );
  }
  // 语义交叉校验：启用惰性装配时必须给出非空 keywords；否则装配阶段永远不会
  // 激活该 server，配置意图明显有误，直接在此拒绝，避免静默行为。
  if (
    out.expandOnKeywordMatch === true &&
    (!out.keywords || out.keywords.length === 0)
  ) {
    throw ValidationError.invalidConfig(
      `${field}: expandOnKeywordMatch=true 必须同时声明非空 keywords`,
      { field: `${field}.keywords` },
    );
  }

  // 必备字段的形态闭环：根据 (显式/推断出的) transport 校验 required 字段。
  const transport =
    out.transport ?? (typeof out.url === "string" ? "sse" : "stdio");
  if (transport === "stdio") {
    if (!out.command) {
      throw ValidationError.invalidConfig(
        `${field}: stdio transport 必须声明 command（形如 "npx" / "node" / "bunx"）`,
        { field },
      );
    }
  } else {
    if (!out.url) {
      throw ValidationError.invalidConfig(
        `${field}: sse transport 必须声明 url（形如 "http://host:port/sse"）`,
        { field },
      );
    }
  }

  return out;
};

const parseMcpServers = (value: unknown): McpServersConfig => {
  const raw = asRecord(value, "mcpServers");
  const out: McpServersConfig = {};
  for (const [serverId, rawServer] of Object.entries(raw)) {
    if (rawServer === undefined) {
      continue;
    }
    if (!MCP_SERVER_ID_RE.test(serverId)) {
      throw ValidationError.invalidConfig(
        `mcpServers.${serverId}: 非法 serverId；仅允许 [a-zA-Z0-9_-]{1,48}`,
        { field: `mcpServers.${serverId}`, value: serverId },
      );
    }
    out[serverId] = parseMcpServer(rawServer, `mcpServers.${serverId}`);
  }
  return out;
};

const parseProviders = (value: unknown): ProvidersConfig => {
  const raw = asRecord(value, "providers");
  const out: ProvidersConfig = {};
  for (const [providerName, providerRaw] of Object.entries(raw)) {
    if (providerRaw === undefined) {
      continue;
    }
    out[providerName] = parseProviderConnection(providerRaw, `providers.${providerName}`);
  }
  return out;
};

const parseCapabilityMapping = (
  value: unknown,
  fallback: Record<string, ModelRoute>,
): Record<string, ModelRoute> => {
  if (value === undefined) {
    return fallback;
  }
  const mapping = asRecord(value, "models.capabilityMapping");
  const out: Record<string, ModelRoute> = {};
  for (const [key, rawRoute] of Object.entries(mapping)) {
    const route = asRecord(rawRoute, `models.capabilityMapping.${key}`);
    const provider = asString(
      route.provider,
      `models.capabilityMapping.${key}.provider`,
      "",
    );
    const model = asString(route.model, `models.capabilityMapping.${key}.model`, "");
    if (!provider || !model) {
      throw ValidationError.invalidConfig(`models.capabilityMapping.${key} 缺少 provider/model`);
    }
    out[key] = {
      provider,
      model,
      params:
        route.params && typeof route.params === "object"
          ? (route.params as Record<string, unknown>)
          : undefined,
    };
  }
  return out;
};

/**
 * 校验并规范化引擎配置。
 */
export const validateEngineConfig = (raw: unknown): EngineConfig => {
  if (raw === undefined || raw === null) {
    return structuredClone(DEFAULT_CONFIG);
  }

  const data = asRecord(raw, "config");
  const registry = asRecord(data.registry ?? {}, "registry");
  const runtime = asRecord(data.runtime ?? {}, "runtime");
  const memory = asRecord(data.memory ?? {}, "memory");
  const budget = asRecord(data.budget ?? {}, "budget");
  const safety = asRecord(data.safety ?? {}, "safety");
  const models = asRecord(data.models ?? {}, "models");
  const observability = asRecord(data.observability ?? {}, "observability");
  const hooks = asRecord(data.hooks ?? {}, "hooks");

  return {
    registry: {
      descriptorPaths: asStringArray(
        registry.descriptorPaths,
        "registry.descriptorPaths",
        DEFAULT_CONFIG.registry.descriptorPaths,
      ),
      enableVectorIndexing: asBoolean(
        registry.enableVectorIndexing,
        "registry.enableVectorIndexing",
        DEFAULT_CONFIG.registry.enableVectorIndexing,
      ),
    },
    runtime: {
      planMode: asBoolean(runtime.planMode, "runtime.planMode", DEFAULT_CONFIG.runtime.planMode),
      maxConcurrency: asNumber(
        runtime.maxConcurrency,
        "runtime.maxConcurrency",
        DEFAULT_CONFIG.runtime.maxConcurrency,
        { min: 1 },
      ),
      defaultTaskTimeoutMs: asNumber(
        runtime.defaultTaskTimeoutMs,
        "runtime.defaultTaskTimeoutMs",
        DEFAULT_CONFIG.runtime.defaultTaskTimeoutMs,
        { min: 1_000 },
      ),
      failFast: asBoolean(runtime.failFast, "runtime.failFast", DEFAULT_CONFIG.runtime.failFast),
      toolLoop: ((): NonNullable<EngineConfig["runtime"]["toolLoop"]> => {
        const fallback = DEFAULT_CONFIG.runtime.toolLoop ?? {};
        const rawValue = runtime.toolLoop;
        if (rawValue === undefined || rawValue === null) {
          return { ...fallback };
        }
        const raw = asRecord(rawValue, "runtime.toolLoop");
        return {
          maxSteps: asNumber(
            raw.maxSteps,
            "runtime.toolLoop.maxSteps",
            fallback.maxSteps ?? 8,
            { min: 1, max: 64 },
          ),
          parallelism: asNumber(
            raw.parallelism,
            "runtime.toolLoop.parallelism",
            fallback.parallelism ?? 4,
            { min: 1, max: 16 },
          ),
          requireApprovalGlobal: asBoolean(
            raw.requireApprovalGlobal,
            "runtime.toolLoop.requireApprovalGlobal",
            fallback.requireApprovalGlobal ?? false,
          ),
        };
      })(),
      streamingOutput: asBoolean(
        runtime.streamingOutput,
        "runtime.streamingOutput",
        DEFAULT_CONFIG.runtime.streamingOutput ?? false,
      ),
    },
    memory: {
      contextTokenLimit: asNumber(
        memory.contextTokenLimit,
        "memory.contextTokenLimit",
        DEFAULT_CONFIG.memory.contextTokenLimit,
        { min: 1_024 },
      ),
      compressionThreshold: asNumber(
        memory.compressionThreshold,
        "memory.compressionThreshold",
        DEFAULT_CONFIG.memory.compressionThreshold,
        { min: 0.1, max: 1 },
      ),
      headKeep: asNumber(memory.headKeep, "memory.headKeep", DEFAULT_CONFIG.memory.headKeep, {
        min: 0,
      }),
      tailKeep: asNumber(memory.tailKeep, "memory.tailKeep", DEFAULT_CONFIG.memory.tailKeep, {
        min: 0,
      }),
      archivePath: asString(memory.archivePath, "memory.archivePath", DEFAULT_CONFIG.memory.archivePath),
      vectorIndexLimit: asNumber(
        memory.vectorIndexLimit,
        "memory.vectorIndexLimit",
        DEFAULT_CONFIG.memory.vectorIndexLimit,
        { min: 10 },
      ),
      maxContextTokens: asNumber(
        memory.maxContextTokens,
        "memory.maxContextTokens",
        DEFAULT_CONFIG.memory.maxContextTokens ?? 128_000,
        { min: 1_024 },
      ),
      recallTopK: asNumber(
        memory.recallTopK,
        "memory.recallTopK",
        DEFAULT_CONFIG.memory.recallTopK ?? 5,
        { min: 0 },
      ),
      persistence: ((): "memory" | "fs" => {
        const raw = (memory as Record<string, unknown>).persistence;
        const fallback = DEFAULT_CONFIG.memory.persistence ?? "fs";
        if (raw === "memory" || raw === "fs") {
          return raw;
        }
        if (raw === undefined || raw === null || raw === "") {
          return fallback;
        }
        throw ValidationError.invalidConfig(
          `memory.persistence 非法值："${String(raw)}"；允许：memory | fs`,
          { field: "memory.persistence", value: raw },
        );
      })(),
      persistDir: asString(
        memory.persistDir,
        "memory.persistDir",
        DEFAULT_CONFIG.memory.persistDir ?? ".tachu/memory",
      ),
    },
    budget: {
      maxTokens: asNumber(budget.maxTokens, "budget.maxTokens", DEFAULT_CONFIG.budget.maxTokens, {
        min: 1_000,
      }),
      maxToolCalls: asNumber(
        budget.maxToolCalls,
        "budget.maxToolCalls",
        DEFAULT_CONFIG.budget.maxToolCalls,
        { min: 1 },
      ),
      maxWallTimeMs: asNumber(
        budget.maxWallTimeMs,
        "budget.maxWallTimeMs",
        DEFAULT_CONFIG.budget.maxWallTimeMs,
        { min: 1_000 },
      ),
    },
    safety: {
      maxInputSizeBytes: asNumber(
        safety.maxInputSizeBytes,
        "safety.maxInputSizeBytes",
        DEFAULT_CONFIG.safety.maxInputSizeBytes,
        { min: 1_024 },
      ),
      maxRecursionDepth: asNumber(
        safety.maxRecursionDepth,
        "safety.maxRecursionDepth",
        DEFAULT_CONFIG.safety.maxRecursionDepth,
        { min: 1 },
      ),
      workspaceRoot: asString(
        safety.workspaceRoot,
        "safety.workspaceRoot",
        DEFAULT_CONFIG.safety.workspaceRoot,
      ),
      promptInjectionPatterns: asStringArray(
        safety.promptInjectionPatterns,
        "safety.promptInjectionPatterns",
        DEFAULT_CONFIG.safety.promptInjectionPatterns,
      ),
      defaultGate: asBoolean(
        safety.defaultGate,
        "safety.defaultGate",
        DEFAULT_CONFIG.safety.defaultGate ?? false,
      ),
      allowedWriteRoots: asStringArray(
        safety.allowedWriteRoots,
        "safety.allowedWriteRoots",
        DEFAULT_CONFIG.safety.allowedWriteRoots ?? [],
      ),
    },
    models: {
      capabilityMapping: parseCapabilityMapping(
        models.capabilityMapping,
        DEFAULT_CONFIG.models.capabilityMapping,
      ),
      providerFallbackOrder: asStringArray(
        models.providerFallbackOrder,
        "models.providerFallbackOrder",
        DEFAULT_CONFIG.models.providerFallbackOrder,
      ),
    },
    ...(data.providers !== undefined
      ? { providers: parseProviders(data.providers) }
      : {}),
    ...(data.mcpServers !== undefined
      ? { mcpServers: parseMcpServers(data.mcpServers) }
      : {}),
    observability: {
      enabled: asBoolean(
        observability.enabled,
        "observability.enabled",
        DEFAULT_CONFIG.observability.enabled,
      ),
      maskSensitiveData: asBoolean(
        observability.maskSensitiveData,
        "observability.maskSensitiveData",
        DEFAULT_CONFIG.observability.maskSensitiveData,
      ),
    },
    hooks: {
      writeHookTimeout: asNumber(
        hooks.writeHookTimeout,
        "hooks.writeHookTimeout",
        DEFAULT_CONFIG.hooks.writeHookTimeout,
        { min: 1 },
      ),
      failureBehavior:
        hooks.failureBehavior === "abort" || hooks.failureBehavior === "continue"
          ? hooks.failureBehavior
          : DEFAULT_CONFIG.hooks.failureBehavior,
    },
  };
};

/**
 * 获取默认配置副本。
 */
export const createDefaultEngineConfig = (): EngineConfig => structuredClone(DEFAULT_CONFIG);

