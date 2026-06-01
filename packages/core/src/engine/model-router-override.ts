import type { ModelRouter } from "../modules/model-router";
import type { ProviderAdapter } from "../modules/provider";
import type { ModelRoute, SessionScope } from "../types";
import type { CapabilityCheckResult } from "../modules/model-router";

/**
 * 包一层 ModelRouter，按 `SessionScope.modelOverride` 对 `resolve` 的结果做覆盖。
 *
 * 优先级（从高到低）：
 * 1. 调用方显式 `resolve({ task, override })` 的 `override` —— 保留 ModelRouter
 * 原有 API 的"per-call 显式覆盖"语义；
 * 2. `scope.modelOverride.byCapability[tag]` —— 按 capability tag 精确覆盖；
 * 3. `scope.modelOverride.all` —— 简写，对所有 tag 一并覆盖；
 * 4. `base.resolve(...)` —— 回退到 `EngineConfig.models.capabilityMapping`。
 *
 * 若 scope 未提供 `modelOverride` 或字段均为空，直接返回 `base`，不引入间接调用开销。
 *
 * `checkCapabilities` 透传给 base —— 这是启动期一次性的 provider 健康检查，
 * 不受 per-call scope 影响。
 */
export function applyModelOverride(
  base: ModelRouter,
  override: SessionScope["modelOverride"] | undefined,
): ModelRouter {
  if (!override) return base;
  const all = override.all;
  const byCapability = override.byCapability;
  const hasByCap = byCapability !== undefined && Object.keys(byCapability).length > 0;
  if (!all && !hasByCap) return base;

  return {
    resolve(input: string | { task: string; override?: ModelRoute }): ModelRoute {
      if (typeof input === "object" && input.override) {
        return input.override;
      }
      const tag = typeof input === "string" ? input : input.task;
      if (hasByCap) {
        const hit = byCapability![tag];
        if (hit) return hit;
      }
      if (all) return all;
      return base.resolve(input);
    },
    async checkCapabilities(providers: ProviderAdapter[]): Promise<CapabilityCheckResult> {
      return base.checkCapabilities(providers);
    },
  };
}
