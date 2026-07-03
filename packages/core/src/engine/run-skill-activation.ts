import type { Tokenizer } from "../prompt/tokenizer";
import type { Registry } from "../registry";
import type { EngineConfig, InputEnvelope, SessionScope, SkillDescriptor } from "../types";
import type { SemanticRetrievalFacade } from "../semantic-retrieval";
import type { AdapterCallContext } from "../types/context";
import type { ContextWindow } from "../modules/memory";
import type { ObservabilityEmitter } from "../modules/observability";
import type { SessionManager } from "../modules/session";
import { readGatingPolicy } from "./gating-policy";
import { engineEventFromAdapterContext } from "./turn-outcome";
import { createActivation, type ActivationResult as SeamActivationResult } from "./activation";
import {
  buildActivationQuery,
  computeActivationBudget,
  createSkillActivationProfile,
  type ActivationResult as SkillActivationResult,
  type CandidateStrategy,
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

 // A 概念对齐：skill 也经统一激活 seam（`activateDescriptors` +
 // `createSkillActivationProfile`）激活，与 rule/tool/agent 同形。原先散落成 4 个
 // pinning 策略（snapshot-refs / explicit / gating-pin / always-activation）的决策
 // 收敛到通用激活模型：把 gatingPolicy + snapshot 折算为本轮的 explicit/pinned/
 // excluded 输入，由 core 统一决策；sticky（TTL 状态）与 budget/tier（token 预算）
 // 作为 skill 专属 placement 保留在 profile 内。富结果经 `result.detail` 回传。
  const gatingPolicy = readGatingPolicy(params.currentInput);
  const snapshotRefs = params.scope?.additionalSkills?.map((skill) => skill.name) ?? [];
  const explicitNames = new Set(gatingPolicy.explicitSkills);
  const pinnedNames = new Set([...snapshotRefs, ...gatingPolicy.pinSkills]);
  const excludedNames = new Set(gatingPolicy.excludeSkills);

  const profile = createSkillActivationProfile({
    tokenizer: params.tokenizer,
    stickyManager: params.stickyManager,
    budget,
    sessionId: params.sessionId,
    currentTurn,
    candidateStrategies: params.candidateStrategies ?? [],
    candidateTopK: params.config.runtime.candidateTopK ?? 20,
    observability: params.observability,
    adapterContext: params.adapterContext,
    ...(params.semanticRetrieval !== undefined
      ? { semanticRetrieval: params.semanticRetrieval }
      : {}),
  });

  const activation = (await createActivation({ profiles: { skill: profile } }).activate(
    "skill",
    {
      query,
      registry: { list: (kind) => params.registry.list(kind) },
      explicitNames,
      pinnedNames,
      excludedNames,
      observability: {
        emit: (event: unknown) =>
          params.observability.emit(
            event as Parameters<typeof params.observability.emit>[0],
          ),
      },
      signal: params.signal,
      correlation: params.adapterContext.correlation as unknown as Record<string, unknown>,
    },
  )) as SeamActivationResult<"skill">;

  const detail = activation.detail as SkillActivationResult | undefined;
  const pinned = detail?.pinned ?? [];
  const candidates = detail?.candidates ?? [];

  return {
    activeSkills: pinned.map((item) => item.skill),
    availableSkills: candidates.map((item) => item.skill),
    skillSimilarityMap: new Map(
      candidates.map((item) => [item.skill.name, item.score]),
    ),
    alwaysSkillNames: detail?.alwaysSkillNames ?? new Set<string>(),
    stickySkillNames: detail?.stickySkillNames ?? new Set<string>(),
  };
};
