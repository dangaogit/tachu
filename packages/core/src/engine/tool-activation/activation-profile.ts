import type {
  ActivationProfile,
  ActivationTurn,
  SemanticRecallHit,
} from "../activation";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { DescriptorRegistry } from "../../registry";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import type { DiscoveryExpansionConfig } from "../../types/config";
import {
  DEFAULT_ADAPTER_CALL_CONTEXT,
  type ExecutionSubject,
} from "../../types/context";
import type { ToolDescriptor } from "../../types/descriptor";
import type { TurnPolicy } from "../../types/turn-policy";
import { DefaultToolActivator } from "./activator";
import { createDefaultToolCandidateStrategies } from "./default-strategies";
import type { ToolPolicySource } from "./strategies/host-rule";
import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "./types";

type TurnValue<T> = T | ((turn: ActivationTurn<"tool">) => T | undefined);

export interface ToolActivationProfileDeps {
  strategies?: readonly ToolCandidateStrategy[] | undefined;
  topK?: number | undefined;
  policySource?: ToolPolicySource | undefined;
  embeddingMinScore?: number | undefined;
  semanticRetrieval?: SemanticRetrievalFacade | undefined;
  turnPolicy?: TurnValue<TurnPolicy> | undefined;
  discoveryExpansion?: TurnValue<DiscoveryExpansionConfig> | undefined;
  disableAllStrategies?: TurnValue<boolean> | undefined;
  subject?: TurnValue<ExecutionSubject> | undefined;
}

const PROMOTE_SCORE_BOOST = 1;

const noopObservability: ObservabilityEmitter = {
  on: () => () => {},
  off: () => {},
  emit: () => {},
  setMasker: () => {},
};

const resolveTurnValue = <T>(
  value: TurnValue<T> | undefined,
  turn: ActivationTurn<"tool">,
): T | undefined =>
  typeof value === "function"
    ? (value as (turn: ActivationTurn<"tool">) => T | undefined)(turn)
    : value;

const strategiesFor = (deps: ToolActivationProfileDeps): ToolCandidateStrategy[] => {
  if (deps.strategies !== undefined) {
    return [...deps.strategies];
  }
  const options: {
    policySource?: ToolPolicySource;
    embeddingMinScore?: number;
  } = {};
  if (deps.policySource !== undefined) {
    options.policySource = deps.policySource;
  }
  if (deps.embeddingMinScore !== undefined) {
    options.embeddingMinScore = deps.embeddingMinScore;
  }
  return createDefaultToolCandidateStrategies(options);
};

const observabilityFor = (turn: ActivationTurn<"tool">): ObservabilityEmitter =>
  turn.observability === undefined
    ? noopObservability
    : {
        ...noopObservability,
        emit: turn.observability.emit,
      };

const contextFor = (
  deps: ToolActivationProfileDeps,
  turn: ActivationTurn<"tool">,
): ToolActivationContext => {
  const subject = resolveTurnValue(deps.subject, turn);
  const disableAllStrategies = resolveTurnValue(deps.disableAllStrategies, turn);
  const turnPolicy = resolveTurnValue(deps.turnPolicy, turn);
  const discoveryExpansion = resolveTurnValue(deps.discoveryExpansion, turn);
  return {
    query: turn.query ?? "",
    agentVisibleTools: turn.registry.list("tool"),
    registry: turn.registry as unknown as DescriptorRegistry,
    observability: observabilityFor(turn),
    signal: turn.signal ?? new AbortController().signal,
    correlation: {
      ...DEFAULT_ADAPTER_CALL_CONTEXT.correlation,
      ...(turn.correlation ?? {}),
    },
    ...(deps.semanticRetrieval !== undefined
      ? { semanticRetrieval: deps.semanticRetrieval }
      : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(disableAllStrategies !== undefined ? { disableAllStrategies } : {}),
    ...(turnPolicy !== undefined ? { turnPolicy } : {}),
    ...(discoveryExpansion !== undefined ? { discoveryExpansion } : {}),
  };
};

const scoreStrategies = async (
  ctx: ToolActivationContext,
  strategies: readonly ToolCandidateStrategy[],
): Promise<Array<ToolCandidateContribution & { strategy: string }>> => {
  if (ctx.disableAllStrategies === true || strategies.length === 0) {
    return [];
  }
  const raw: Array<ToolCandidateContribution & { strategy: string }> = [];
  await Promise.all(
    strategies.map(async (strategy) => {
      try {
        const contributions = await strategy.score(ctx);
        for (const contribution of contributions) {
          raw.push({ ...contribution, strategy: strategy.name });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.observability.emit({
          timestamp: Date.now(),
          correlation: ctx.correlation,
          subject: ctx.subject,
          phase: "planning",
          type: "tool_activation_strategy_failed",
          payload: { strategy: strategy.name, error: message },
        });
      }
    }),
  );
  return raw;
};

const recallHitsFromContributions = (
  contributions: ReadonlyArray<ToolCandidateContribution & { strategy: string }>,
  tools: readonly ToolDescriptor[],
): SemanticRecallHit[] => {
  const visibleNames = new Set(tools.map((tool) => tool.name));
  const merged = new Map<
    string,
    { score: number; reason: string; excluded: boolean }
  >();

  for (const contribution of contributions) {
    if (!visibleNames.has(contribution.toolName)) continue;
    const score =
      contribution.score + (contribution.promote ? PROMOTE_SCORE_BOOST : 0);
    const reason = `${contribution.strategy}:${contribution.reason}`;
    const existing = merged.get(contribution.toolName);
    if (!existing) {
      merged.set(contribution.toolName, {
        score,
        reason,
        excluded: Boolean(contribution.exclude),
      });
      continue;
    }
    if (score > existing.score) {
      existing.score = score;
      existing.reason = reason;
    }
    if (contribution.exclude) {
      existing.excluded = true;
      existing.reason = contribution.exclude.reason;
    }
  }

  return [...merged.entries()]
    .filter(([, candidate]) => !candidate.excluded)
    .map(([name, candidate]) => ({
      name,
      score: candidate.score,
      reason: candidate.reason,
    }));
};

export const createToolActivationProfile = (
  deps: ToolActivationProfileDeps = {},
): ActivationProfile<"tool"> => ({
  getActivation: () => ({ mode: "semantic" }),
  semanticRecall: {
    async recall(_kind, turn) {
      const ctx = contextFor(deps, turn);
      const contributions = await scoreStrategies(ctx, strategiesFor(deps));
      return recallHitsFromContributions(contributions, ctx.agentVisibleTools);
    },
  },
  placement: {
    async place({ turn }) {
      const activatorOptions =
        deps.topK === undefined
          ? { strategies: strategiesFor(deps) }
          : { strategies: strategiesFor(deps), topK: deps.topK };
      const activator = new DefaultToolActivator(activatorOptions);
      const result = await activator.activate(contextFor(deps, turn));
      return result.visibleTools;
    },
  },
});
