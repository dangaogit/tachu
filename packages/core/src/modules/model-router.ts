import { RegistryError } from "../errors";
import type { EngineConfig, ModelRoute } from "../types";
import type { ProviderAdapter } from "./provider";

/**
 * Provider 能力描述条目。
 */
export interface CapabilityProviderInfo {
  /** provider 是否已注册并可通过 `listAvailableModels` 查询。 */
  available: boolean;
  /** 该 provider 提供的模型名集合（来自 `listAvailableModels`）。 */
  models: string[];
}

/**
 * 模型能力检查结果。
 *
 * 按 D1-SEV-06 冻结方案扩展：在保留 `warnings`（向后兼容）的同时，补齐
 * `valid / providers / capabilityCoverage / missingCapabilities` 四项字段，
 * 以便上层能精确判断哪些能力标签缺失以及哪些 provider 不可用。
 */
export interface CapabilityCheckResult {
  /** 整体是否有效：当 `missingCapabilities` 为空且无不可用 provider 时为 true。 */
  valid: boolean;
  /** 已检查的 provider -> 可用性与模型集合。 */
  providers: Record<string, CapabilityProviderInfo>;
  /** 能力标签 -> 是否有可达的 provider+model。 */
  capabilityCoverage: Record<string, boolean>;
  /** 未覆盖的能力标签集合。 */
  missingCapabilities: string[];
  /** 历史/文本告警列表（保留用于日志与向后兼容）。 */
  warnings: string[];
}

/**
 * 模型路由器接口。
 */
export interface ModelRouter {
  /**
   * 根据能力标签或任务请求解析模型路由。
   *
   * @param input 能力标签或任务请求
   * @returns 解析得到的 provider/model 路由
   */
  resolve(
    input:
      | string
      | {
          task: string;
          override?: ModelRoute;
        },
  ): ModelRoute;
  /**
   * 检查能力映射是否与 Provider 实际模型能力一致。
   *
   * @param providerAdapters 已注册 Provider 适配器
   * @returns 能力检查告警结果
   */
  checkCapabilities(providerAdapters: ProviderAdapter[]): Promise<CapabilityCheckResult>;
}

/**
 * 默认模型路由实现。
 */
export class DefaultModelRouter implements ModelRouter {
  constructor(private readonly config: EngineConfig) {}

  resolve(
    input:
      | string
      | {
          task: string;
          override?: ModelRoute;
        },
  ): ModelRoute {
    if (typeof input === "object" && input.override) {
      return input.override;
    }
    const key = typeof input === "string" ? input : input.task;
    const route = this.config.models.capabilityMapping[key];
    if (!route) {
      throw RegistryError.modelNotFound(key);
    }
    return route;
  }

  async checkCapabilities(providerAdapters: ProviderAdapter[]): Promise<CapabilityCheckResult> {
    const warnings: string[] = [];
    const providers: Record<string, CapabilityProviderInfo> = {};
    const available = new Map<string, Set<string>>();

    for (const adapter of providerAdapters) {
      try {
        const models = await adapter.listAvailableModels();
        const names = models.map((model) => model.modelName);
        available.set(adapter.id, new Set(names));
        providers[adapter.id] = { available: true, models: names };
      } catch (error) {
        providers[adapter.id] = { available: false, models: [] };
        warnings.push(
          `provider ${adapter.id} 模型列表查询失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const capabilityCoverage: Record<string, boolean> = {};
    const missingCapabilities: string[] = [];

    for (const [tag, route] of Object.entries(this.config.models.capabilityMapping)) {
      const providerModels = available.get(route.provider);
      let covered = false;
      if (!providerModels) {
        warnings.push(`能力 ${tag} 映射到未知 provider: ${route.provider}`);
      } else if (!providerModels.has(route.model)) {
        warnings.push(
          `能力 ${tag} 指向模型 ${route.model}，但 provider ${route.provider} 不可用`,
        );
      } else {
        covered = true;
      }
      capabilityCoverage[tag] = covered;
      if (!covered) {
        missingCapabilities.push(tag);
      }
    }

    const allProvidersAvailable = Object.values(providers).every((info) => info.available);

    return {
      valid: missingCapabilities.length === 0 && allProvidersAvailable,
      providers,
      capabilityCoverage,
      missingCapabilities,
      warnings,
    };
  }
}

