import type { EngineConfig, ProviderConnectionConfig } from "@tachu/core";

/**
 * CLI 参数中与 provider 连接相关的子集。
 *
 * 每个字段对应一个命令行 flag；citty 把未指定的 flag 解析为空字符串。
 */
export interface ProviderCliOverrides {
  provider?: string;
  "api-base"?: string;
  "api-key"?: string;
  organization?: string;
}

/**
 * 根据命令行参数推断要作用于哪个 provider。
 *
 * 优先级：
 *   1. `--provider` 显式指定
 *   2. `config.models.capabilityMapping['high-reasoning'].provider`
 *   3. `config.models.providerFallbackOrder[0]`
 */
function resolveTargetProvider(
  config: EngineConfig,
  args: ProviderCliOverrides,
): string | undefined {
  const explicit = (args.provider ?? "").trim();
  if (explicit) return explicit.toLowerCase();
  const mapped = config.models.capabilityMapping["high-reasoning"]?.provider;
  if (mapped) return mapped.toLowerCase();
  const fallback = config.models.providerFallbackOrder[0];
  return fallback ? fallback.toLowerCase() : undefined;
}

/**
 * 把 `--api-base` / `--api-key` / `--organization` 这类 CLI flag 合并到
 * `config.providers[<provider>]` 中。
 *
 * - 仅当用户确实传入非空字符串时才覆盖，保持 `undefined` 语义
 * - 已有的其它字段（例如配置文件里写好的 timeoutMs）不会被清除
 * - `mock` provider 的连接参数无意义，直接跳过
 *
 * @param config 原始引擎配置
 * @param args CLI 参数（object-literal 即可，字段与命令定义一致）
 * @returns 一份新的 `EngineConfig`，原对象不被修改
 */
export function applyProviderConnectionOverrides(
  config: EngineConfig,
  args: ProviderCliOverrides,
): EngineConfig {
  const apiBase = (args["api-base"] ?? "").trim();
  const apiKey = (args["api-key"] ?? "").trim();
  const org = (args.organization ?? "").trim();
  if (!apiBase && !apiKey && !org) {
    return config;
  }
  const target = resolveTargetProvider(config, args);
  if (!target || target === "mock") {
    return config;
  }
  const existing = config.providers?.[target] ?? {};
  const merged: ProviderConnectionConfig = { ...existing };
  if (apiBase) merged.baseURL = apiBase;
  if (apiKey) merged.apiKey = apiKey;
  if (org) merged.organization = org;
  return {
    ...config,
    providers: {
      ...(config.providers ?? {}),
      [target]: merged,
    },
  };
}
