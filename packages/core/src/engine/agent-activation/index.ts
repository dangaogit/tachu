import type { AgentDescriptor } from "../../types";
import type {
  ActivationProfile,
  ActivationTurn,
  PlacementAdapter,
  SemanticRecall,
} from "../activation";

export interface AgentActivationProfileDeps {
  semanticRecall?: SemanticRecall<"agent"> | undefined;
}

type AgentScoreLookup = (turn: ActivationTurn<"agent">) => ReadonlyMap<string, number> | undefined;

const compareBySemanticScore =
  (scores: ReadonlyMap<string, number>) =>
  (left: AgentDescriptor, right: AgentDescriptor): number => {
    const leftScore = scores.get(left.name);
    const rightScore = scores.get(right.name);
    if (leftScore === undefined && rightScore === undefined) return 0;
    if (leftScore === undefined) return 1;
    if (rightScore === undefined) return -1;
    return rightScore - leftScore;
  };

const createAgentPlacementAdapter = (
  scoreLookup?: AgentScoreLookup,
): PlacementAdapter<"agent"> => ({
  place: ({ turn, activeDescriptors }) => {
    const active = [...activeDescriptors];
    const scores = scoreLookup?.(turn);
    if (!scores || scores.size === 0) {
      return active;
    }
    return active.sort(compareBySemanticScore(scores));
  },
});

export const createAgentActivationProfile = (
  deps: AgentActivationProfileDeps = {},
): ActivationProfile<"agent"> => {
  const semanticScoresByTurn = new WeakMap<ActivationTurn<"agent">, ReadonlyMap<string, number>>();
  const placement = createAgentPlacementAdapter((turn) => semanticScoresByTurn.get(turn));
  const semanticRecall = deps.semanticRecall;
  const profile: ActivationProfile<"agent"> = {
    getActivation: (_agent: AgentDescriptor) => ({ mode: "always" }),
    placement,
  };

  if (semanticRecall !== undefined) {
    profile.semanticRecall = {
      recall: async (kind, turn) => {
        const hits = await semanticRecall.recall(kind, turn);
        semanticScoresByTurn.set(
          turn,
          new Map(hits.map((hit) => [hit.name, hit.score])),
        );
        return hits;
      },
    };
  }

  return profile;
};
