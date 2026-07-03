import type { Activation, DescriptorMap } from "../../types/descriptor";

export type DescriptorKind = keyof DescriptorMap;

export type { Activation };

export type ActivationPlane =
  | "excluded"
  | "pinned"
  | "deterministic"
  | "semantic"
  | "inactive";

export type ActivationDecisionSource =
  | "exclude"
  | "pin"
  | "always"
  | "manual"
  | "path"
  | "semantic"
  | "inactive";

export interface ActivationTurn<K extends DescriptorKind = DescriptorKind> {
  query?: string | undefined;
  registry: {
    list(kind: K): DescriptorMap[K][];
  };
  explicitNames?: ReadonlySet<string> | undefined;
  pinnedNames?: ReadonlySet<string> | undefined;
  excludedNames?: ReadonlySet<string> | undefined;
  contextFilePaths?: readonly string[] | undefined;
  semanticActiveNames?: ReadonlySet<string> | undefined;
  observability?: { emit: (event: unknown) => void } | undefined;
  correlation?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  kind?: K | undefined;
}

export interface ActivationDecision<K extends DescriptorKind = DescriptorKind> {
  kind: K;
  name: string;
  descriptor: DescriptorMap[K];
  activation: Activation;
  active: boolean;
  plane: ActivationPlane;
  source: ActivationDecisionSource;
  score: number;
  reasons: readonly string[];
}

export interface PlacementAdapter<K extends DescriptorKind> {
  place(input: {
    kind: K;
    turn: ActivationTurn<K>;
    decisions: readonly ActivationDecision<K>[];
    activeDescriptors: readonly DescriptorMap[K][];
  }): DescriptorMap[K][] | Promise<DescriptorMap[K][]>;
}

export interface SemanticRecallHit {
  name: string;
  score: number;
  reason?: string | undefined;
}

export interface SemanticRecall<K extends DescriptorKind = DescriptorKind> {
  recall(kind: K, turn: ActivationTurn<K>): Promise<readonly SemanticRecallHit[]>;
}

export interface ActivationProfile<K extends DescriptorKind> {
  getActivation(descriptor: DescriptorMap[K]): Activation;
  placement: PlacementAdapter<K>;
  semanticRecall?: SemanticRecall<K> | undefined;
}

export interface ActivationTrace {
  recallDegraded?: { error: string } | undefined;
}

export interface ActivationResult<K extends DescriptorKind = DescriptorKind> {
  kind: K;
  active: DescriptorMap[K][];
  decisions: readonly ActivationDecision<K>[];
  trace: ActivationTrace;
}
