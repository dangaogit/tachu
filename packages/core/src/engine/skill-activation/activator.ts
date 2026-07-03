import { ValidationError } from "../../errors";
import type { GatingPolicy } from "../../types/gating-policy";
import type { Tokenizer } from "../../prompt/tokenizer";
import type { AdapterCallContext } from "../../types";
import { engineEventFromAdapterContext } from "../turn-outcome";
import { AlwaysActivationPinningStrategy } from "./strategies/always-activation";
import { ExplicitSkillPinningStrategy } from "./strategies/explicit-skill-pinning";
import { SnapshotRefsPinningStrategy } from "./strategies/snapshot-refs";
import { StickyPinningStrategy } from "./strategies/sticky-pinning";
import { GatingPolicyPinningStrategy } from "./strategies/gating-policy-pinning";
import {
  countCandidateSkillTokens,
  countPinnedSkillTokens,
  DEFAULT_CANDIDATE_TOP_K,
} from "./budget";
import type {
  ActivatedCandidateSkill,
  ActivatedPinnedSkill,
  ActivationContext,
  ActivationResult,
  ActivationSource,
  CandidateContribution,
  CandidateStrategy,
  ExcludedSkill,
  PinningStrategy,
  PinnedContribution,
  SkillActivator,
  SkillActivatorOptions,
} from "./types";

interface MergedPinned {
  skillName: string;
  sources: ActivationSource[];
  reasonKind: "snapshot-ref" | "always" | "sticky" | "promote" | "explicit" | "gating-pin";
  stickyAddedTurn?: number;
}

interface MergedCandidate {
  skillName: string;
  score: number;
  sources: ActivationSource[];
}

const classifyPinnedTier = (
  sources: ActivationSource[],
): ActivatedPinnedSkill["tier"] => {
  if (sources.some((source) => source.reason === "explicit-skill-mention")) {
    return "t0-snapshot";
  }
  if (sources.some((source) => source.reason === "snapshot-ref")) {
    return "t0-snapshot";
  }
  if (sources.some((source) => source.reason === "always")) {
    return "t0-always";
  }
  if (sources.some((source) => source.reason.startsWith("promote:"))) {
    return "t0-promote";
  }
  return "t0-sticky";
};

const mergePinnedContributions = (
  contributions: Array<PinnedContribution & { strategy: string }>,
): MergedPinned[] => {
  const merged = new Map<string, MergedPinned>();
  for (const contribution of contributions) {
    const existing = merged.get(contribution.skillName);
    const source: ActivationSource = {
      strategy: contribution.strategy,
      reason: contribution.reason,
    };
    if (!existing) {
      merged.set(contribution.skillName, {
        skillName: contribution.skillName,
        sources: [source],
        reasonKind:
          contribution.reason === "snapshot-ref"
            ? "snapshot-ref"
            : contribution.reason === "explicit-skill-mention"
              ? "explicit"
              : contribution.reason === "gating-policy:pin"
                ? "gating-pin"
                : contribution.reason === "always"
                  ? "always"
                  : contribution.reason.startsWith("promote:")
                    ? "promote"
                    : "sticky",
      });
      continue;
    }
    existing.sources.push(source);
  }
  return [...merged.values()];
};

const applyGatingPolicySkillFilter = (
  mergedPinned: MergedPinned[],
  mergedCandidates: MergedCandidate[],
  gatingPolicy: GatingPolicy | undefined,
  emitWarning: (reason: string, details: Record<string, unknown>) => void,
): { pinned: MergedPinned[]; candidates: MergedCandidate[] } => {
  if (!gatingPolicy) {
    return { pinned: mergedPinned, candidates: mergedCandidates };
  }
  const explicit = new Set(gatingPolicy.explicitSkills);
  const exclude = new Set(gatingPolicy.excludeSkills);
  for (const skillName of explicit) {
    if (exclude.has(skillName)) {
      emitWarning("gating-policy:explicit-overrides-exclude", { skillName });
    }
  }
  for (const skillName of gatingPolicy.pinSkills) {
    if (exclude.has(skillName) && !explicit.has(skillName)) {
      emitWarning("gating-policy:skill-conflict", { skillName });
    }
  }
  const keepSkill = (skillName: string): boolean =>
    explicit.has(skillName) || !exclude.has(skillName);
  return {
    pinned: mergedPinned.filter((item) => keepSkill(item.skillName)),
    candidates: mergedCandidates.filter((item) => keepSkill(item.skillName)),
  };
};

const mergeCandidateContributions = (
  contributions: Array<CandidateContribution & { strategy: string }>,
): MergedCandidate[] => {
  const merged = new Map<string, MergedCandidate>();
  for (const contribution of contributions) {
    const source: ActivationSource = {
      strategy: contribution.strategy,
      reason: contribution.reason,
      score: contribution.score,
    };
    const existing = merged.get(contribution.skillName);
    if (!existing) {
      merged.set(contribution.skillName, {
        skillName: contribution.skillName,
        score: contribution.score,
        sources: [source],
      });
      continue;
    }
    existing.score = Math.max(existing.score, contribution.score);
    existing.sources.push(source);
  }
  return [...merged.values()];
};

export interface DefaultSkillActivatorParams extends SkillActivatorOptions {
  tokenizer: Tokenizer;
  adapterContext: AdapterCallContext;
}

export class DefaultSkillActivator implements SkillActivator {
  private readonly pinningStrategies: PinningStrategy[];
  private readonly candidateStrategies: CandidateStrategy[];
  private readonly candidateTopK: number;
  private readonly tokenizer: Tokenizer;
  private readonly adapterContext: AdapterCallContext;

  constructor(params: DefaultSkillActivatorParams) {
    this.pinningStrategies = params.pinningStrategies;
    this.candidateStrategies = params.candidateStrategies;
    this.candidateTopK = params.candidateTopK ?? DEFAULT_CANDIDATE_TOP_K;
    this.tokenizer = params.tokenizer;
    this.adapterContext = params.adapterContext;
  }

  async activate(ctx: ActivationContext): Promise<ActivationResult> {
    const startedAt = performance.now();
    const perStrategyMs: Record<string, number> = {};
    const trace: ActivationResult["trace"] = { strategyFailures: [] };

    const pinnedRaw: Array<PinnedContribution & { strategy: string }> = [];
    for (const strategy of this.pinningStrategies) {
      try {
        const strategyStartedAt = performance.now();
        const contributions = await strategy.pin(ctx);
        perStrategyMs[strategy.name] = performance.now() - strategyStartedAt;
        for (const contribution of contributions) {
          pinnedRaw.push({ ...contribution, strategy: strategy.name });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.strategyFailures.push({ strategy: strategy.name, error: message });
        ctx.observability.emit(
          engineEventFromAdapterContext(this.adapterContext, {
            timestamp: Date.now(),
            phase: "planning",
            type: "skill_activation_strategy_failed",
            payload: { strategy: strategy.name, error: message },
          }),
        );
      }
    }

    const candidateRaw: Array<CandidateContribution & { strategy: string }> = [];
    for (const strategy of this.candidateStrategies) {
      try {
        const strategyStartedAt = performance.now();
        const contributions = await strategy.score(ctx);
        perStrategyMs[strategy.name] = performance.now() - strategyStartedAt;
        for (const contribution of contributions) {
          candidateRaw.push({ ...contribution, strategy: strategy.name });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.strategyFailures.push({ strategy: strategy.name, error: message });
        ctx.observability.emit(
          engineEventFromAdapterContext(this.adapterContext, {
            timestamp: Date.now(),
            phase: "planning",
            type: "skill_activation_strategy_failed",
            payload: { strategy: strategy.name, error: message },
          }),
        );
      }
    }

    const stickyList = await ctx.stickyManager.list(ctx.sessionId, ctx.currentTurn);
    const stickyAddedTurnByName = new Map(
      stickyList.active.map((entry) => [entry.skillName, entry.addedTurn]),
    );

    let mergedPinned = mergePinnedContributions(pinnedRaw);
    let mergedCandidates = mergeCandidateContributions(candidateRaw);

    const promoted: MergedPinned[] = [];
    const remainingCandidates: MergedCandidate[] = [];
    for (const candidate of mergedCandidates) {
      const promoteContribution = candidateRaw.find(
        (item) => item.skillName === candidate.skillName && item.promote,
      );
      if (promoteContribution?.promote) {
        promoted.push({
          skillName: candidate.skillName,
          sources: [
            ...candidate.sources,
            {
              strategy: promoteContribution.strategy,
              reason: `promote:${promoteContribution.promote.reason}`,
              score: candidate.score,
            },
          ],
          reasonKind: "promote",
        });
      } else {
        remainingCandidates.push(candidate);
      }
    }
    mergedPinned = [...mergedPinned, ...promoted];
    mergedCandidates = remainingCandidates;

    const filtered = applyGatingPolicySkillFilter(
      mergedPinned,
      mergedCandidates,
      ctx.gatingPolicy,
      (reason, details) => {
        ctx.observability.emit(
          engineEventFromAdapterContext(this.adapterContext, {
            timestamp: Date.now(),
            phase: "planning",
            type: "warning",
            payload: { reason, ...details },
          }),
        );
      },
    );
    mergedPinned = filtered.pinned;
    mergedCandidates = filtered.candidates;

    for (const pinned of mergedPinned) {
      const addedTurn = stickyAddedTurnByName.get(pinned.skillName);
      if (addedTurn !== undefined) {
        pinned.stickyAddedTurn = addedTurn;
      }
    }

    const pinnedNames = new Set(mergedPinned.map((item) => item.skillName));
    mergedCandidates = mergedCandidates.filter((item) => !pinnedNames.has(item.skillName));

    mergedCandidates.sort((left, right) => right.score - left.score);

    const belowTopK: ExcludedSkill[] = [];
    if (mergedCandidates.length > this.candidateTopK) {
      const kept = mergedCandidates.slice(0, this.candidateTopK);
      for (const dropped of mergedCandidates.slice(this.candidateTopK)) {
        belowTopK.push({
          name: dropped.skillName,
          reason: "below-topK",
          score: dropped.score,
        });
      }
      mergedCandidates = kept;
    }

    const allSkills = ctx.registry.list("skill");
    const alwaysSkillNames = new Set(
      allSkills.filter((skill) => skill.activation.mode === "always").map((skill) => skill.name),
    );
    const stickySkillNames = new Set(stickyList.active.map((entry) => entry.skillName));

    const budgetUsage: ActivationResult["budget"] = {
      t0Limit: ctx.budget.t0Limit,
      t0Used: 0,
      t1Limit: ctx.budget.t1Limit,
      t1Used: 0,
      trimmed: [],
    };

    let candidateDescriptors = mergedCandidates
      .map((item) => {
        const skill = ctx.registry.get("skill", item.skillName);
        return skill ? { ...item, skill } : null;
      })
      .filter((item): item is MergedCandidate & { skill: NonNullable<ReturnType<typeof ctx.registry.get>> } =>
        item !== null,
      );

    candidateDescriptors.sort((left, right) => left.score - right.score);
    while (
      candidateDescriptors.length > 0 &&
      countCandidateSkillTokens(
        this.tokenizer,
        candidateDescriptors.map((item) => item.skill),
      ) > ctx.budget.t1Limit
    ) {
      const removed = candidateDescriptors.shift();
      if (!removed) {
        break;
      }
      budgetUsage.trimmed.push({ name: removed.skillName, tier: "t1" });
    }

    let pinnedItems = mergedPinned
      .map((item) => {
        const skill = ctx.registry.get("skill", item.skillName);
        return skill ? { ...item, skill } : null;
      })
      .filter((item): item is MergedPinned & { skill: NonNullable<ReturnType<typeof ctx.registry.get>> } =>
        item !== null,
      );

    const protectedPinned = pinnedItems.filter(
      (item) =>
        item.reasonKind === "snapshot-ref" ||
        item.reasonKind === "always" ||
        item.reasonKind === "explicit",
    );
    let trimmablePinned = pinnedItems.filter(
      (item) => item.reasonKind === "sticky" || item.reasonKind === "promote",
    );

    trimmablePinned.sort(
      (left, right) => (left.stickyAddedTurn ?? 0) - (right.stickyAddedTurn ?? 0),
    );

    const buildPinnedDescriptors = (): Array<
      MergedPinned & { skill: NonNullable<ReturnType<typeof ctx.registry.get>> }
    > => [...protectedPinned, ...trimmablePinned];

    while (
      trimmablePinned.length > 0 &&
      countPinnedSkillTokens(
        this.tokenizer,
        buildPinnedDescriptors().map((item) => item.skill),
      ) > ctx.budget.t0Limit
    ) {
      const removed = trimmablePinned.shift();
      if (!removed) {
        break;
      }
      budgetUsage.trimmed.push({ name: removed.skillName, tier: "t0-sticky" });
    }

    pinnedItems = buildPinnedDescriptors();

    const protectedTokens = countPinnedSkillTokens(
      this.tokenizer,
      protectedPinned.map((item) => item.skill),
    );
    if (protectedTokens > ctx.budget.t0Limit) {
      throw ValidationError.outOfRangeSkillBudget(protectedTokens, ctx.budget.t0Limit);
    }

    budgetUsage.t0Used = countPinnedSkillTokens(
      this.tokenizer,
      pinnedItems.map((item) => item.skill),
    );
    budgetUsage.t1Used = countCandidateSkillTokens(
      this.tokenizer,
      candidateDescriptors.map((item) => item.skill),
    );

    const activeNames = new Set([
      ...pinnedItems.map((item) => item.skillName),
      ...candidateDescriptors.map((item) => item.skillName),
    ]);

    const excluded: ExcludedSkill[] = [...belowTopK];
    for (const trimmed of budgetUsage.trimmed) {
      excluded.push({
        name: trimmed.name,
        reason: trimmed.tier === "t1" ? "budget-trimmed-t1" : "budget-trimmed-sticky",
      });
    }

    for (const skill of allSkills) {
      if (activeNames.has(skill.name) || excluded.some((item) => item.name === skill.name)) {
        continue;
      }
      if (skill.deprecated === true) {
        excluded.push({ name: skill.name, reason: "deprecated" });
        continue;
      }
      if (skill.activation.mode === "manual") {
        excluded.push({ name: skill.name, reason: "manual-not-matched" });
      }
    }

    const pinned: ActivatedPinnedSkill[] = pinnedItems.map((item) => ({
      skill: item.skill,
      tokens: this.tokenizer.count(`### ${item.skill.name}\n${item.skill.instructions}`),
      sources: item.sources,
      tier: classifyPinnedTier(item.sources),
      ...(item.stickyAddedTurn !== undefined ? { stickyAddedTurn: item.stickyAddedTurn } : {}),
    }));

    const candidates: ActivatedCandidateSkill[] = candidateDescriptors
      .sort((left, right) => right.score - left.score)
      .map((item) => ({
        skill: item.skill,
        score: item.score,
        sources: item.sources,
      }));

    const timing = {
      totalMs: performance.now() - startedAt,
      perStrategyMs,
    };

    ctx.observability.emit(
      engineEventFromAdapterContext(this.adapterContext, {
        timestamp: Date.now(),
        phase: "planning",
        type: "skill_activation",
        payload: {
          query: ctx.query,
          pinned: pinned.map((item) => ({
            name: item.skill.name,
            tokens: item.tokens,
            sources: item.sources,
          })),
          candidates: candidates.map((item) => ({
            name: item.skill.name,
            score: item.score,
            sources: item.sources,
          })),
          excluded,
          budget: budgetUsage,
          timing,
        },
      }),
    );

    return {
      query: ctx.query,
      pinned,
      candidates,
      excluded,
      budget: budgetUsage,
      timing,
      trace,
      alwaysSkillNames,
      stickySkillNames,
    };
  }
}

export const createDefaultSkillActivator = (
  params: DefaultSkillActivatorParams,
): DefaultSkillActivator => new DefaultSkillActivator(params);

/**
 * 旧默认 pinning 策略栈（snapshot-refs / explicit / gating-pin / always-activation
 * / sticky）。
 *
 * A 概念对齐后，**生产路径**（`resolveRunSkills`）已改走统一激活 seam：前四类
 * pinning 的决策收敛进通用激活模型（由 `DecisionPinningStrategy` 依据 core 决策
 * 复原），sticky 作为 skill 专属 placement 保留。本工厂保留为**可选库工具**
 * （host 可直接驱动 `DefaultSkillActivator` 时复用），不在默认生产装配中使用。
 */
export const createDefaultPinningStrategies = (): PinningStrategy[] => [
  new SnapshotRefsPinningStrategy(),
  new ExplicitSkillPinningStrategy(),
  new GatingPolicyPinningStrategy(),
  new AlwaysActivationPinningStrategy(),
  new StickyPinningStrategy(),
];
