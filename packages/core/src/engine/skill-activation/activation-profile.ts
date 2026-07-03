import type { Tokenizer } from "../../prompt/tokenizer";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import type { SkillDescriptor } from "../../types";
import {
  DEFAULT_ADAPTER_CALL_CONTEXT,
  type AdapterCallContext,
} from "../../types/context";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { ActivationDecision, ActivationProfile, ActivationTurn } from "../activation";
import { DefaultSkillActivator } from "./activator";
import { EmbeddingLlmCandidateStrategy } from "./strategies/embedding-llm";
import { StickyPinningStrategy } from "./strategies/sticky-pinning";
import type {
  ActivationBudget,
  ActivationContext,
  CandidateContribution,
  CandidateStrategy,
  PinningStrategy,
  PinnedContribution,
  SkillRegistryView,
} from "./types";
import type { StickyManager } from "./sticky";

export interface SkillActivationProfileDeps {
  tokenizer: Tokenizer;
  stickyManager: StickyManager;
  budget: ActivationBudget;
  sessionId: string;
  currentTurn: number;
  semanticRetrieval?: SemanticRetrievalFacade | undefined;
  observability?: ObservabilityEmitter | undefined;
  adapterContext?: AdapterCallContext | undefined;
  candidateStrategies?: CandidateStrategy[] | undefined;
  candidateTopK?: number | undefined;
}

const createRegistryView = (
  turn: ActivationTurn<"skill">,
): SkillRegistryView => ({
  list: () => turn.registry.list("skill"),
  get: (_kind, name) =>
    turn.registry.list("skill").find((skill) => skill.name === name) ?? null,
});

const createActivationContext = (
  deps: SkillActivationProfileDeps,
  turn: ActivationTurn<"skill">,
): ActivationContext => ({
  currentInput: {
    content: turn.query ?? "",
    metadata: { modality: "text", size: (turn.query ?? "").length },
  },
  contextWindow: { entries: [], tokenCount: 0, limit: 0 },
  sessionId: deps.sessionId,
  currentTurn: deps.currentTurn,
  snapshotSkillRefs: [],
  registry: createRegistryView(turn),
  stickyManager: deps.stickyManager,
  observability: deps.observability ?? new DefaultObservabilityEmitter(),
  signal: turn.signal ?? new AbortController().signal,
  budget: deps.budget,
  query: turn.query ?? "",
  correlation: (deps.adapterContext ?? DEFAULT_ADAPTER_CALL_CONTEXT).correlation,
  ...(deps.semanticRetrieval !== undefined
    ? { semanticRetrieval: deps.semanticRetrieval }
    : {}),
  ...(deps.adapterContext?.subject !== undefined
    ? { subject: deps.adapterContext.subject }
    : {}),
});

class DecisionPinningStrategy implements PinningStrategy {
  readonly name = "activation-core";

  constructor(
    private readonly decisions: readonly ActivationDecision<"skill">[],
    private readonly turn: ActivationTurn<"skill">,
  ) {}

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const contributions: PinnedContribution[] = [];
    const explicitlyPinned = new Set<string>();

    for (const skillName of this.turn.explicitNames ?? []) {
      const skill = ctx.registry.get("skill", skillName);
      if (!skill || skill.deprecated === true) {
        continue;
      }
      explicitlyPinned.add(skillName);
      contributions.push({ skillName, reason: "explicit-skill-mention" });
    }

    for (const decision of this.decisions) {
      if (decision.descriptor.deprecated === true) {
        continue;
      }
      if (decision.source === "always") {
        contributions.push({ skillName: decision.name, reason: "always" });
        continue;
      }
      if (decision.source === "manual" && !explicitlyPinned.has(decision.name)) {
        contributions.push({
          skillName: decision.name,
          reason: "explicit-skill-mention",
        });
        continue;
      }
      if (decision.source === "pin") {
        contributions.push({ skillName: decision.name, reason: "snapshot-ref" });
      }
    }

    return contributions;
  }
}

class DecisionCandidateStrategy implements CandidateStrategy {
  readonly name = "activation-core";

  constructor(
    private readonly decisions: readonly ActivationDecision<"skill">[],
    private readonly cachedContributions: readonly CandidateContribution[],
  ) {}

  async score(): Promise<CandidateContribution[]> {
    const activeSemanticNames = new Set(
      this.decisions
        .filter(
          (decision) =>
            decision.active &&
            decision.source === "semantic" &&
            decision.descriptor.deprecated !== true,
        )
        .map((decision) => decision.name),
    );
    const cached = this.cachedContributions.filter((contribution) =>
      activeSemanticNames.has(contribution.skillName),
    );
    if (cached.length > 0) {
      return cached;
    }

    return this.decisions
      .filter(
        (decision) =>
          decision.active &&
          decision.source === "semantic" &&
          decision.descriptor.deprecated !== true,
      )
      .map((decision) => ({
        skillName: decision.name,
        score: decision.score,
        reason: decision.reasons[0] ?? "semantic",
      }));
  }
}

export const createSkillActivationProfile = (
  deps: SkillActivationProfileDeps,
): ActivationProfile<"skill"> => {
  const candidateStrategies = deps.candidateStrategies ?? [
    new EmbeddingLlmCandidateStrategy(),
  ];
  const candidateContributionsByTurn = new WeakMap<
    ActivationTurn<"skill">,
    CandidateContribution[]
  >();

  return {
    getActivation: (skill) => {
      switch (skill.trigger?.type) {
        case "always":
          return { mode: "always" };
        case "explicit":
          return { mode: "manual" };
        case "semantic":
        case undefined:
          return { mode: "semantic" };
      }
    },
    placement: {
      place: async ({ turn, decisions }) => {
        const ctx = createActivationContext(deps, turn);
        const activator = new DefaultSkillActivator({
          pinningStrategies: [
            new DecisionPinningStrategy(decisions, turn),
            new StickyPinningStrategy(),
          ],
          candidateStrategies: [
            new DecisionCandidateStrategy(
              decisions,
              candidateContributionsByTurn.get(turn) ?? [],
            ),
          ],
          tokenizer: deps.tokenizer,
          adapterContext: deps.adapterContext ?? DEFAULT_ADAPTER_CALL_CONTEXT,
          ...(deps.candidateTopK !== undefined
            ? { candidateTopK: deps.candidateTopK }
            : {}),
        });
        const result = await activator.activate(ctx);
        return [
          ...result.pinned.map((item) => item.skill),
          ...result.candidates.map((item) => item.skill),
        ];
      },
    },
    semanticRecall: {
      recall: async (_kind, turn) => {
        const ctx = createActivationContext(deps, turn);
        const contributions = (
          await Promise.all(
            candidateStrategies.map((strategy) => strategy.score(ctx)),
          )
        ).flat();
        candidateContributionsByTurn.set(turn, contributions);
        const skillsByName = new Map<string, SkillDescriptor>(
          turn.registry.list("skill").map((skill) => [skill.name, skill]),
        );
        return contributions
          .filter((contribution) => skillsByName.has(contribution.skillName))
          .map((contribution) => ({
            name: contribution.skillName,
            score: contribution.score,
            reason: contribution.reason,
          }));
      },
    },
  };
};
