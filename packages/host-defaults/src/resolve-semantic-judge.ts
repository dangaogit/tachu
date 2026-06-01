import {
  ProviderSemanticJudgeAdapter,
  type EngineConfig,
  type ProviderAdapter,
  type SemanticJudgeAdapter,
} from "@tachu/core";

export function resolveSemanticJudge(
  config: EngineConfig,
  providers: readonly ProviderAdapter[],
): SemanticJudgeAdapter | undefined {
  const validationMapping = (
    config.models.capabilityMapping as Record<string, { provider?: string; model?: string } | undefined>
  ).validation;
  const preferredId = validationMapping?.provider;
  const provider =
    (preferredId ? providers.find((item) => item.id === preferredId) : undefined) ??
    providers.find((item) => typeof item.chat === "function");
  if (!provider) return undefined;
  const model = validationMapping?.model ?? "validation-default";
  return new ProviderSemanticJudgeAdapter({
    provider,
    model,
    ...(config.validation?.semanticJudgeSystemPromptBase
      ? { systemPromptBase: config.validation.semanticJudgeSystemPromptBase }
      : {}),
  });
}
