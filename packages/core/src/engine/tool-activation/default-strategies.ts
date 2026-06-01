import type { ToolCandidateStrategy } from "./types";
import { IntentTurnPolicyToolStrategy } from "./strategies/intent-turn-policy";
import { NameMatchToolCandidateStrategy } from "./strategies/name-match";
import { DescriptorEmbeddingToolCandidateStrategy } from "./strategies/descriptor-embedding";
import { HostRuleToolCandidateStrategy, type ToolPolicySource } from "./strategies/host-rule";

/**
 * Default tool candidate strategy stack ().
 *
 * Order is deterministic and documented:
 * 1. HostRule — host policy (allow/deny). Runs first so deny can
 * short-circuit downstream contributions.
 * 2. IntentTurnPolicy — turn-level include/exclude from intent.
 * 3. NameMatch — explicit name / displayName / tag mentions. Cheap.
 * 4. DescriptorEmbed — semantic activation via host-supplied SemanticIndex.
 *
 * Strategies without supporting host injection (e.g. no policy source, no
 * semantic index) are simply omitted from the array.
 */
export const createDefaultToolCandidateStrategies = (options?: {
  policySource?: ToolPolicySource;
  embeddingMinScore?: number;
}): ToolCandidateStrategy[] => {
  const strategies: ToolCandidateStrategy[] = [];
  if (options?.policySource !== undefined) {
    strategies.push(new HostRuleToolCandidateStrategy(options.policySource));
  }
  strategies.push(new IntentTurnPolicyToolStrategy());
  strategies.push(new NameMatchToolCandidateStrategy());
  strategies.push(
    new DescriptorEmbeddingToolCandidateStrategy(
      options?.embeddingMinScore !== undefined
        ? { minScore: options.embeddingMinScore }
        : {},
    ),
  );
  return strategies;
};
