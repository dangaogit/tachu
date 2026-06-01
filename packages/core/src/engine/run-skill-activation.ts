import type { Tokenizer } from "../prompt/tokenizer";
import type { Registry } from "../registry";
import type { EngineConfig, InputEnvelope, SessionScope, SkillDescriptor } from "../types";
import type { SemanticRetrievalFacade } from "../semantic-retrieval";
import type { AdapterCallContext } from "../types/context";
import type { ContextWindow } from "../modules/memory";
import type { ObservabilityEmitter } from "../modules/observability";
import type { SessionManager } from "../modules/session";
import { readTurnPolicy } from "./turn-policy";
import { engineEventFromAdapterContext } from "./turn-outcome";
import {
  buildActivationQuery,
  computeActivationBudget,
  createDefaultPinningStrategies,
  DefaultSkillActivator,
  type CandidateStrategy,
  type PinningStrategy,
  type StickyManager,
} from "./skill-activation";

export interface ResolvedRunSkills {
  activeSkills: SkillDescriptor[];
  availableSkills: SkillDescriptor[];
  skillSimilarityMap: Map<string, number>;
  alwaysSkillNames: Set<string>;
  stickySkillNames: Set<string>;
}

export interface ResolveRunSkillsParams {
  config: EngineConfig;
  registry: Registry;
  sessionManager: SessionManager;
  stickyManager: StickyManager;
  sessionId: string;
  currentInput: InputEnvelope;
  contextWindow: ContextWindow;
  adapterContext: AdapterCallContext;
  scope?: SessionScope;
  observability: ObservabilityEmitter;
  tokenizer: Tokenizer;
  maxContextTokens: number;
  reserveOutputTokens?: number;
  pinningStrategies?: PinningStrategy[];
  candidateStrategies?: CandidateStrategy[];
 /** Policy-aware semantic retrieval. */
  semanticRetrieval?: SemanticRetrievalFacade;
  signal: AbortSignal;
}

export const resolveRunSkills = async (
  params: ResolveRunSkillsParams,
): Promise<ResolvedRunSkills> => {
  const mode = params.config.runtime.skillActivationMode ?? "activator";
  if (mode === "legacy") {
    throw new Error(
      'runtime.skillActivationMode="legacy" was retired; use "activator"',
    );
  }

  const currentTurn = await params.sessionManager.getCurrentTurn(params.sessionId);
  const stickyList = await params.stickyManager.list(params.sessionId, currentTurn);
  for (const expired of stickyList.expired) {
    params.observability.emit(
      engineEventFromAdapterContext(params.adapterContext, {
        timestamp: Date.now(),
        phase: "planning",
        type: "skill_sticky_change",
        payload: {
          skill: expired.skillName,
          action: "expire",
          source: expired.source,
          ttlRemaining: 0,
          reason: "ttl",
        },
      }),
    );
  }

  const query = buildActivationQuery(params.currentInput, params.contextWindow);
  const budget = computeActivationBudget(
    params.config.runtime.skillBudget ?? 0.8,
    params.maxContextTokens,
    params.reserveOutputTokens ?? 4_096,
  );

  const activator = new DefaultSkillActivator({
    pinningStrategies: params.pinningStrategies ?? createDefaultPinningStrategies(),
    candidateStrategies: params.candidateStrategies ?? [],
    candidateTopK: params.config.runtime.candidateTopK ?? 20,
    tokenizer: params.tokenizer,
    adapterContext: params.adapterContext,
  });

  const activation = await activator.activate({
    currentInput: params.currentInput,
    contextWindow: params.contextWindow,
    sessionId: params.sessionId,
    currentTurn,
    snapshotSkillRefs: params.scope?.additionalSkills?.map((skill) => skill.name) ?? [],
    registry: params.registry,
    stickyManager: params.stickyManager,
    ...(params.semanticRetrieval !== undefined
      ? { semanticRetrieval: params.semanticRetrieval }
      : {}),
    correlation: params.adapterContext.correlation,
    ...(params.adapterContext.subject !== undefined
      ? { subject: params.adapterContext.subject }
      : {}),
    observability: params.observability,
    signal: params.signal,
    budget,
    query,
    turnPolicy: readTurnPolicy(params.currentInput),
  });

  return {
    activeSkills: activation.pinned.map((item) => item.skill),
    availableSkills: activation.candidates.map((item) => item.skill),
    skillSimilarityMap: new Map(
      activation.candidates.map((item) => [item.skill.name, item.score]),
    ),
    alwaysSkillNames: activation.alwaysSkillNames,
    stickySkillNames: activation.stickySkillNames,
  };
};
