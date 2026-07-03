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
import type { GatingPolicy } from "../../types/gating-policy";
import {
  scoreToolStrategies,
  selectVisibleTools,
  type ScoredToolContributions,
} from "./activator";
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
  gatingPolicy?: TurnValue<GatingPolicy> | undefined;
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
  const gatingPolicy = resolveTurnValue(deps.gatingPolicy, turn);
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
    ...(gatingPolicy !== undefined ? { gatingPolicy } : {}),
    ...(discoveryExpansion !== undefined ? { discoveryExpansion } : {}),
  };
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

/**
 * 工具激活 Profile（A 概念对齐：tool 接入统一激活 seam）。
 *
 * 决策层由统一 core 的 `semanticRecall` 承担：策略**只跑一次**产出候选贡献，
 * 缓存到 per-turn WeakMap；`placement` 复用缓存的贡献做 merge/topK/回落/discovery
 * 选择，绝不把策略（含向量检索）跑第二遍。`DefaultToolActivator` 的选择逻辑
 * 已抽为 `selectVisibleTools`，成为本 placement 的内部实现。
 */
export const createToolActivationProfile = (
  deps: ToolActivationProfileDeps = {},
): ActivationProfile<"tool"> => {
  const scoredByTurn = new WeakMap<ActivationTurn<"tool">, ScoredToolContributions>();
  const scoreForTurn = async (
    turn: ActivationTurn<"tool">,
  ): Promise<{ ctx: ToolActivationContext; scored: ScoredToolContributions }> => {
    const ctx = contextFor(deps, turn);
    const cached = scoredByTurn.get(turn);
    if (cached !== undefined) {
      return { ctx, scored: cached };
    }
    const scored = await scoreToolStrategies(ctx, strategiesFor(deps));
    scoredByTurn.set(turn, scored);
    return { ctx, scored };
  };
  return {
    getActivation: () => ({ mode: "semantic" }),
    semanticRecall: {
      async recall(_kind, turn) {
        const { ctx, scored } = await scoreForTurn(turn);
        return recallHitsFromContributions(scored.raw, ctx.agentVisibleTools);
      },
    },
    placement: {
      async place({ turn }) {
        const { ctx, scored } = await scoreForTurn(turn);
        return selectVisibleTools(ctx, scored, deps.topK ?? undefined).visibleTools;
      },
    },
  };
};
