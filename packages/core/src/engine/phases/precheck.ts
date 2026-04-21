import { ProviderError } from "../../errors";
import { envelopeNeedsTextToImage } from "../../utils/input-vision";
import type { PhaseEnvironment } from "./index";
import type { SafetyPhaseOutput } from "./safety";
import type { IntentResult } from "../../types";

export interface PrecheckPhaseOutput extends SafetyPhaseOutput {
  intent: IntentResult;
}

/**
 * 阶段 4：前置校验。
 *
 * 会对 intent / planning / validation / output 四档主干 capability 的
 * Provider 可达性做一次集中预检，尽早暴露配置缺失，避免后续阶段抛错。
 *
 * @throws {ProviderError.unavailable} 当任一主干 capability 解析到的
 *   Provider 不在 `env.providers` 注册表中时抛出。
 */
const PRECHECK_CAPABILITIES = [
  "intent",
  "planning",
  "validation",
  "output",
] as const;

export const runPrecheckPhase = async (
  state: PrecheckPhaseOutput,
  env: PhaseEnvironment,
): Promise<PrecheckPhaseOutput> => {
  if (envelopeNeedsTextToImage(state.input)) {
    const route = env.modelRouter.resolve("text-to-image");
    if (!env.providers.has(route.provider)) {
      throw ProviderError.unavailable(route.provider);
    }
  }

  // intent 必检；planning / validation / output 仅在 capabilityMapping 已配置时才检查，
  // 这样 simple 路径仍能在只配置 intent 的最小配置下工作。
  const mapping = env.config.models.capabilityMapping;
  for (const capability of PRECHECK_CAPABILITIES) {
    if (capability !== "intent" && !mapping[capability]) {
      continue;
    }
    const route = env.modelRouter.resolve(capability);
    if (!env.providers.has(route.provider)) {
      throw ProviderError.unavailable(route.provider);
    }
  }
  await env.runtimeState.update(state.context.sessionId, { currentPhase: "precheck" });
  return state;
};

