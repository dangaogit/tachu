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

 // 跨回合持续（Loaded Skill Persistence）：把「已 load 但不在进程 registry」的 sticky
 // 技能（典型即宿主 discovery 技能），经 `skillDiscovery.load` 无状态物化成含正文的完整
 // descriptor，并入本轮 activation 的技能全集——activation 的 registry 视图 `get` 从
 // `list` 派生，故 `StickyPinningStrategy` 即可按 name 把它 pin 成 Active Skill、注入 T0
 // 正文，与 registry 技能一视同仁。范围严格限定 sticky-active ∖ registry（有界，
 // ≤ sticky slots）；不缓存 → 永远反映宿主最新 owner-aware 正文；load 失败静默跳过 +
 // warning，sticky 条目随 TTL 自愈。宿主未提供 `load` 时零影响，行为与既有一致。
  const stickyExternalSkills = await resolveStickyExternalSkills(params, stickyList.active);

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
      registry: {
        list: (kind) =>
          stickyExternalSkills.length > 0
            ? mergeSkillDescriptors(params.registry.list(kind), stickyExternalSkills)
            : params.registry.list(kind),
      },
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

  const activeSkills = pinned.map((item) => item.skill);
  const availableSkills = candidates.map((item) => item.skill);

 // L2 索引并入：把宿主 `scope.skillDiscovery.list()` 回的技能元数据（仅
 // name+description(+tags)）追加到 availableSkills，作为「可发现目录」呈现。
 // 严格元数据级——`instructions` 为空、`activation.mode = "semantic"`——它们只在
 // "Available Skills" 段以 name+desc 渲染，**永不**进入 activeSkills、不注入正文。
 // 去重键为 name：已在 active / available / 进程 registry 中的技能以既有条目为准
 // （registry 权威），发现项只补充 registry 之外的技能（典型即宿主的「我的技能」）。
 // provider 抛错时降级为「无发现项」并发一条 warning，绝不阻断本轮。
  const discovered = await resolveDiscoveredEntries(params);
  if (discovered.length > 0) {
    const seen = new Set<string>([
      ...activeSkills.map((skill) => skill.name),
      ...availableSkills.map((skill) => skill.name),
      ...params.registry.list("skill").map((skill) => skill.name),
    ]);
    for (const entry of discovered) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      availableSkills.push(discoveryMetadataDescriptor(entry));
    }
  }

  return {
    activeSkills,
    availableSkills,
    skillSimilarityMap: new Map(
      candidates.map((item) => [item.skill.name, item.score]),
    ),
    alwaysSkillNames: detail?.alwaysSkillNames ?? new Set<string>(),
    stickySkillNames: detail?.stickySkillNames ?? new Set<string>(),
  };
};

/** registry 优先并入 external：追加 external 中 name 不在 registry 的完整描述符。 */
const mergeSkillDescriptors = (
  base: SkillDescriptor[],
  external: SkillDescriptor[],
): SkillDescriptor[] => {
  const names = new Set(base.map((skill) => skill.name));
  return [...base, ...external.filter((skill) => !names.has(skill.name))];
};

/**
 * 物化「sticky-active ∖ registry」的技能正文（Loaded Skill Persistence 的数据来源）。
 * 仅对已 load 进 sticky 且不在进程 registry 的 name 调 `skillDiscovery.load`（有界、
 * 无状态、去重）；load 返回 null / 抛错时静默跳过（sticky 条目随 TTL 自愈），抛错额外
 * 发一条 warning。宿主未提供 `load` 时回空数组，activation 行为与既有完全一致。
 */
const resolveStickyExternalSkills = async (
  params: ResolveRunSkillsParams,
  stickyActive: readonly { skillName: string }[],
): Promise<SkillDescriptor[]> => {
  const load = params.scope?.skillDiscovery?.load;
  if (load === undefined || stickyActive.length === 0) {
    return [];
  }
  const registryNames = new Set(
    params.registry.list("skill").map((skill) => skill.name),
  );
  const resolved: SkillDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of stickyActive) {
    const name = entry.skillName;
    if (registryNames.has(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    try {
      const loaded = await load(name);
      if (loaded) {
        resolved.push(loaded);
      }
    } catch (error) {
      params.observability.emit(
        engineEventFromAdapterContext(params.adapterContext, {
          timestamp: Date.now(),
          phase: "planning",
          type: "warning",
          payload: {
            reason: "skill_discovery_load_failed",
            skill: name,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }
  return resolved;
};

/** 把 L2 发现条目物化为「仅元数据」skill 描述符（空正文、语义激活、不自动生效）。 */
const discoveryMetadataDescriptor = (entry: {
  name: string;
  description: string;
  tags?: string[] | undefined;
}): SkillDescriptor => ({
  kind: "skill",
  name: entry.name,
  description: entry.description,
  instructions: "",
  activation: { mode: "semantic" },
  ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
});

/** 读取宿主 `skillDiscovery.list()`；缺省回空数组，抛错则降级并发 warning。 */
const resolveDiscoveredEntries = async (
  params: ResolveRunSkillsParams,
): Promise<Array<{ name: string; description: string; tags?: string[] | undefined }>> => {
  const list = params.scope?.skillDiscovery?.list;
  if (list === undefined) {
    return [];
  }
  try {
    const entries = await list();
    return entries.filter(
      (entry) =>
        typeof entry?.name === "string" &&
        entry.name.length > 0 &&
        typeof entry.description === "string",
    );
  } catch (error) {
    params.observability.emit(
      engineEventFromAdapterContext(params.adapterContext, {
        timestamp: Date.now(),
        phase: "planning",
        type: "warning",
        payload: {
          reason: "skill_discovery_list_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return [];
  }
};
