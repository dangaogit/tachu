import { Glob } from "bun";
import type {
  Activation,
  ActivationDecisionSource,
  ActivationDecision,
  ActivationProfile,
  ActivationPlane,
  ActivationResult,
  ActivationTrace,
  ActivationTurn,
  DescriptorKind,
  SemanticRecallHit,
} from "./types";

type ContributionSource = "exclude" | "pin" | "deterministic" | "semantic" | "inactive";

interface Contribution {
  active: boolean;
  plane: ActivationPlane;
  source: ActivationDecisionSource;
  score: number;
  reason: string;
  precedence: ContributionSource;
}

const ACTIVATION_PRECEDENCE: Record<ContributionSource, number> = {
  inactive: 0,
  semantic: 1,
  deterministic: 2,
  pin: 3,
  exclude: 4,
};

const assertNever = (value: never): never => {
  throw new Error(`Unhandled activation mode: ${JSON.stringify(value)}`);
};

const inactiveContribution = (): Contribution => ({
  active: false,
  plane: "inactive",
  source: "inactive",
  score: 0,
  reason: "inactive",
  precedence: "inactive",
});

const deterministicContribution = (
  source: Extract<ActivationDecisionSource, "always" | "manual" | "path">,
): Contribution => ({
  active: true,
  plane: "deterministic",
  source,
  score: 1,
  reason: source,
  precedence: "deterministic",
});

const semanticContribution = (score = 0.5): Contribution => ({
  active: true,
  plane: "semantic",
  source: "semantic",
  score,
  reason: "semantic",
  precedence: "semantic",
});

const pinContribution = (): Contribution => ({
  active: true,
  plane: "pinned",
  source: "pin",
  score: 1,
  reason: "pin",
  precedence: "pin",
});

const excludeContribution = (): Contribution => ({
  active: false,
  plane: "excluded",
  source: "exclude",
  score: 0,
  reason: "exclude",
  precedence: "exclude",
});

const hasPathMatch = (
  globs: readonly string[],
  contextFilePaths: readonly string[] | undefined,
): boolean =>
  (contextFilePaths ?? []).some((path) =>
    globs.some((glob) => new Glob(glob).match(path)),
  );

const deterministicGate = <K extends DescriptorKind>(
  descriptorName: string,
  activation: Activation,
  turn: ActivationTurn<K>,
): Contribution | null => {
  switch (activation.mode) {
    case "always":
      return deterministicContribution("always");
    case "manual":
      if (turn.explicitNames?.has(descriptorName) === true) {
        return deterministicContribution("manual");
      }
      return null;
    case "semantic":
      return null;
    case "path":
      if (hasPathMatch(activation.globs, turn.contextFilePaths)) {
        return deterministicContribution("path");
      }
      return null;
    default:
      return assertNever(activation);
  }
};

const mergeContributions = (contributions: readonly Contribution[]): Contribution =>
  [...contributions].sort(
    (left, right) =>
      ACTIVATION_PRECEDENCE[right.precedence] - ACTIVATION_PRECEDENCE[left.precedence],
  )[0] ?? inactiveContribution();

const decideDescriptor = <K extends DescriptorKind>(
  kind: K,
  descriptor: ActivationDecision<K>["descriptor"],
  profile: ActivationProfile<K>,
  turn: ActivationTurn<K>,
  semanticScores: ReadonlyMap<string, number>,
): ActivationDecision<K> => {
  const activation = profile.getActivation(descriptor);
  const contributions = [inactiveContribution()];
  const deterministic = deterministicGate(descriptor.name, activation, turn);
  if (deterministic) {
    contributions.push(deterministic);
  }
  if (
    activation.mode === "semantic" &&
    turn.semanticActiveNames?.has(descriptor.name) === true
  ) {
    contributions.push(semanticContribution(semanticScores.get(descriptor.name)));
  }
  if (turn.pinnedNames?.has(descriptor.name) === true) {
    contributions.push(pinContribution());
  }
  if (turn.excludedNames?.has(descriptor.name) === true) {
    contributions.push(excludeContribution());
  }
  const winner = mergeContributions(contributions);
  return {
    kind,
    name: descriptor.name,
    descriptor,
    activation,
    active: winner.active,
    plane: winner.plane,
    source: winner.source,
    score: winner.score,
    reasons: [winner.reason],
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const collectSemanticRecall = async <K extends DescriptorKind>(
  kind: K,
  profile: ActivationProfile<K>,
  turn: ActivationTurn<K>,
): Promise<{
  activeNames: ReadonlySet<string>;
  scores: ReadonlyMap<string, number>;
  trace: ActivationTrace;
}> => {
  const activeNames = new Set(turn.semanticActiveNames ?? []);
  const scores = new Map<string, number>();
  for (const name of activeNames) {
    scores.set(name, 0.5);
  }
  const trace: ActivationTrace = {};
  if (!profile.semanticRecall) {
    return { activeNames, scores, trace };
  }
  let hits: readonly SemanticRecallHit[] = [];
  try {
    hits = await profile.semanticRecall.recall(kind, turn);
  } catch (error) {
    trace.recallDegraded = { error: errorMessage(error) };
    return { activeNames, scores, trace };
  }
  for (const hit of hits) {
    activeNames.add(hit.name);
    scores.set(hit.name, Math.max(scores.get(hit.name) ?? 0, hit.score));
  }
  return { activeNames, scores, trace };
};

export const activateDescriptors = async <K extends DescriptorKind>(
  kind: K,
  profile: ActivationProfile<K>,
  turn: ActivationTurn<K>,
): Promise<ActivationResult<K>> => {
  const recall = await collectSemanticRecall(kind, profile, turn);
  const decisionTurn: ActivationTurn<K> = {
    ...turn,
    semanticActiveNames: recall.activeNames,
  };
  const decisions = turn.registry
    .list(kind)
    .map((descriptor) =>
      decideDescriptor(kind, descriptor, profile, decisionTurn, recall.scores),
    );
  const activeDescriptors = decisions
    .filter((decision) => decision.active)
    .map((decision) => decision.descriptor);
  const placement = await profile.placement.place({
    kind,
    turn,
    decisions,
    activeDescriptors,
  });
  const active = Array.isArray(placement) ? placement : placement.active;
  const detail = Array.isArray(placement) ? undefined : placement.detail;

  return {
    kind,
    active,
    decisions,
    trace: recall.trace,
    ...(detail !== undefined ? { detail } : {}),
  };
};
