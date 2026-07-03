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

/**
 * Placement 产出。可以只返回排定后的描述符数组，或额外附带一个 kind 专属的
 * 富信息 `detail`（如 skill 的 pinned/candidate 分层、always/sticky 集合、
 * 相似度表）——`detail` 会透传到 {@link ActivationResult.detail}，供调用方
 * （如 `resolveRunSkills`）重建其对外契约，而不必让通用 core 感知 kind 细节。
 */
export type PlacementOutput<K extends DescriptorKind> =
  | DescriptorMap[K][]
  | { active: DescriptorMap[K][]; detail?: unknown };

export interface PlacementAdapter<K extends DescriptorKind> {
  place(input: {
    kind: K;
    turn: ActivationTurn<K>;
    decisions: readonly ActivationDecision<K>[];
    activeDescriptors: readonly DescriptorMap[K][];
  }): PlacementOutput<K> | Promise<PlacementOutput<K>>;
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
 /**
  * Kind 专属富信息，由 PlacementAdapter 选择性回传（见 {@link PlacementOutput}）。
  * 通用 core 不解释其结构；调用方按各自 kind 断言使用。
  */
  detail?: unknown;
}
