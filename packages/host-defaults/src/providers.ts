import type {
  EngineConfig,
  ProviderAdapter,
  ProviderConnectionConfig,
} from "@tachu/core";
import {
  AnthropicProviderAdapter,
  MockProviderAdapter,
  OpenAIProviderAdapter,
  QwenProviderAdapter,
} from "@tachu/extensions/providers";

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
 * 根据 provider 名称构建对应的 ProviderAdapter 实例（delegate 到 @tachu/extensions）。
 */
export function buildProviderAdapter(
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
      throw new Error(
        `unknown provider "${providerName}"; supported built-ins: openai, anthropic, qwen, mock. Use a custom ProviderAdapter via createEngine(..., { providers }) or choose "mock" explicitly for development.`,
      );
  }
}

/**
 * 从 EngineConfig 中推断需要的 Provider 列表。
 */
export function inferProviders(config: EngineConfig): ProviderAdapter[] {
  const providerNames = new Set<string>();

  for (const route of Object.values(config.models.capabilityMapping)) {
    if (typeof route === "object" && route !== null && "provider" in route) {
      providerNames.add((route as { provider: string }).provider);
    }
  }

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
