import type { ContextWindow } from "../../modules/memory";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { SkillDescriptor } from "../../types";
import type { InputEnvelope } from "../../types";
import type { TurnPolicy } from "../../types/turn-policy";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import type { ExecutionCorrelation, ExecutionSubject } from "../../types/context";
import type { StickyManager } from "./sticky";

export interface ActivationBudget {
  t0Limit: number;
  t1Limit: number;
}

export interface SkillRegistryView {
  list(kind: "skill"): SkillDescriptor[];
  get(kind: "skill", name: string): SkillDescriptor | null;
}

export interface ActivationContext {
  currentInput: InputEnvelope;
  contextWindow: ContextWindow;
  sessionId: string;
  currentTurn: number;
  snapshotSkillRefs: ReadonlyArray<string>;
  registry: SkillRegistryView;
  stickyManager: StickyManager;
 /** Policy-aware semantic retrieval. */
  semanticRetrieval?: SemanticRetrievalFacade;
  observability: ObservabilityEmitter;
  signal: AbortSignal;
  budget: ActivationBudget;
  query: string;
 /** Correlation passed through to facade `AdapterCallContext`. */
  correlation?: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
 /** Normalized turn policy from intent. */
  turnPolicy?: TurnPolicy;
}

export interface PinnedContribution {
  skillName: string;
  reason: string;
}

export interface CandidateContribution {
  skillName: string;
  score: number;
  reason: string;
  promote?: { reason: string };
}

export interface PinningStrategy {
  readonly name: string;
  pin(ctx: ActivationContext): Promise<PinnedContribution[]>;
}

export interface CandidateStrategy {
  readonly name: string;
  score(ctx: ActivationContext): Promise<CandidateContribution[]>;
}

export type ExcludedReason =
  | "deprecated"
  | "explicit-trigger-not-matched"
  | "below-topK"
  | "budget-trimmed-t1"
  | "budget-trimmed-sticky";

export interface ActivationSource {
  strategy: string;
  reason: string;
  score?: number;
}

export interface ActivatedPinnedSkill {
  skill: SkillDescriptor;
  tokens: number;
  sources: ActivationSource[];
  tier: "t0-snapshot" | "t0-always" | "t0-sticky" | "t0-promote";
  stickyAddedTurn?: number;
}

export interface ActivatedCandidateSkill {
  skill: SkillDescriptor;
  score: number;
  sources: ActivationSource[];
}

export interface ExcludedSkill {
  name: string;
  reason: ExcludedReason;
  score?: number;
}

export interface ActivationBudgetUsage {
  t0Limit: number;
  t0Used: number;
  t1Limit: number;
  t1Used: number;
  trimmed: Array<{ name: string; tier: "t1" | "t0-sticky" }>;
}

export interface ActivationTrace {
  strategyFailures: Array<{ strategy: string; error: string }>;
}

export interface ActivationResult {
  query: string;
  pinned: ActivatedPinnedSkill[];
  candidates: ActivatedCandidateSkill[];
  excluded: ExcludedSkill[];
  budget: ActivationBudgetUsage;
  timing: {
    totalMs: number;
    perStrategyMs: Record<string, number>;
  };
  trace: ActivationTrace;
  alwaysSkillNames: Set<string>;
  stickySkillNames: Set<string>;
}

export interface SkillActivatorOptions {
  pinningStrategies: PinningStrategy[];
  candidateStrategies: CandidateStrategy[];
  candidateTopK?: number;
}

export interface SkillActivator {
  activate(ctx: ActivationContext): Promise<ActivationResult>;
}
