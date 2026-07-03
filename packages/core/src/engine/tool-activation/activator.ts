import type { ToolDescriptor } from "../../types/descriptor";
import { expandDiscoverySiblings } from "./discovery-expansion";
import type {
  ToolActivationResult,
  ToolActivationContext,
  ToolActivator,
  ToolActivatorOptions,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "./types";

const DEFAULT_TOP_K = 5;

interface MergedTool {
  toolName: string;
  score: number;
  sources: Array<{ strategy: string; reason: string; score: number }>;
  promoted: boolean;
  promoteReason?: string | undefined;
  excluded: boolean;
  excludeReason?: string | undefined;
}

export interface ScoredToolContributions {
  raw: Array<ToolCandidateContribution & { strategy: string }>;
  perStrategyMs: Record<string, number>;
  trace: ToolActivationResult["trace"];
}

/**
 * 运行工具候选策略并汇集贡献（A 概念对齐：激活的**打分/发现**层）。
 *
 * 与 {@link selectVisibleTools} 分离，使统一激活 seam 的 `semanticRecall` 只跑
 * 一次策略、`placement` 复用其结果，避免把策略（含向量检索）跑两遍。
 */
export const scoreToolStrategies = async (
  ctx: ToolActivationContext,
  strategies: readonly ToolCandidateStrategy[],
): Promise<ScoredToolContributions> => {
  const perStrategyMs: Record<string, number> = {};
  const trace: ToolActivationResult["trace"] = { strategyFailures: [] };
  const raw: Array<ToolCandidateContribution & { strategy: string }> = [];
  if (ctx.disableAllStrategies || strategies.length === 0) {
    return { raw, perStrategyMs, trace };
  }
  await Promise.all(
    strategies.map(async (strategy) => {
      const t0 = performance.now();
      try {
        const contributions = await strategy.score(ctx);
        perStrategyMs[strategy.name] = performance.now() - t0;
        for (const c of contributions) {
          raw.push({ ...c, strategy: strategy.name });
        }
      } catch (err) {
        perStrategyMs[strategy.name] = performance.now() - t0;
        const message = err instanceof Error ? err.message : String(err);
        trace.strategyFailures.push({ strategy: strategy.name, error: message });
        ctx.observability.emit({
          timestamp: Date.now(),
          correlation: ctx.correlation,
          subject: ctx.subject,
          phase: "planning",
          type: "tool_activation_strategy_failed",
          payload: { strategy: strategy.name, error: message },
        });
      }
    }),
  );
  return { raw, perStrategyMs, trace };
};

const mergeContributions = (
  raw: Array<ToolCandidateContribution & { strategy: string }>,
): MergedTool[] => {
  const merged = new Map<string, MergedTool>();
  for (const contrib of raw) {
    const existing = merged.get(contrib.toolName);
    const source = { strategy: contrib.strategy, reason: contrib.reason, score: contrib.score };
    if (!existing) {
      merged.set(contrib.toolName, {
        toolName: contrib.toolName,
        score: contrib.score,
        sources: [source],
        promoted: Boolean(contrib.promote),
        promoteReason: contrib.promote?.reason,
        excluded: Boolean(contrib.exclude),
        excludeReason: contrib.exclude?.reason,
      });
    } else {
      existing.score = Math.max(existing.score, contrib.score);
      existing.sources.push(source);
      if (contrib.promote && !existing.promoted) {
        existing.promoted = true;
        existing.promoteReason = contrib.promote.reason;
      }
      if (contrib.exclude && !existing.excluded) {
        existing.excluded = true;
        existing.excludeReason = contrib.exclude.reason;
      }
    }
  }
  return [...merged.values()];
};

/**
 * 从已打分的候选贡献中**选择**可见工具集（A 概念对齐：激活的**选择/裁剪**层）。
 *
 * 承接 {@link scoreToolStrategies} 的产出，做 merge / promote / topK /
 * 无命中回落全集 / discovery 兄弟展开 / 观测事件。与打分层分离后，统一激活
 * seam 的 placement 可直接复用缓存的贡献，不必把策略再跑一遍。
 */
export const selectVisibleTools = (
  ctx: ToolActivationContext,
  scored: ScoredToolContributions,
  topK: number = DEFAULT_TOP_K,
): ToolActivationResult => {
  const { raw, perStrategyMs, trace } = scored;

 // 无策略运行（host 关闭策略 / 未配置策略）→ 直接返回全集，且不发观测事件，
 // 与历史行为一致（区别于"策略跑了但零命中"的 fullSetFallback）。
  if (Object.keys(perStrategyMs).length === 0 && raw.length === 0) {
    return {
      visibleTools: [...ctx.agentVisibleTools],
      matchedToolNames: [],
      fallbackUsed: false,
      perStrategyMs,
      trace,
    };
  }

  const merged = mergeContributions(raw);

 // 策略跑了但零命中 → 回落到 agent 可见全集，而非隐藏所有工具。
  if (merged.length === 0) {
    ctx.observability.emit({
      timestamp: Date.now(),
      correlation: ctx.correlation,
      subject: ctx.subject,
      phase: "planning",
      type: "tool_activation",
      payload: {
        visibleTools: ctx.agentVisibleTools.map((t) => t.name),
        fallbackUsed: false,
        perStrategyMs,
        hits: [],
        fullSetFallback: true,
      },
    });
    return {
      visibleTools: [...ctx.agentVisibleTools],
      matchedToolNames: [],
      fallbackUsed: false,
      perStrategyMs,
      trace,
    };
  }

  const toolByName = new Map<string, ToolDescriptor>(
    ctx.agentVisibleTools.map((t) => [t.name, t]),
  );

    const promoted: MergedTool[] = [];
    const candidates: MergedTool[] = [];
    for (const item of merged) {
      if (!toolByName.has(item.toolName)) continue; // skip unknown tools not in agentVisibleTools
      if (item.excluded) continue; // hard-exclude (e.g. host-rule deny)
      if (item.promoted) {
        promoted.push(item);
      } else {
        candidates.push(item);
      }
    }

 // Sort non-promoted candidates by score descending, take topK
    candidates.sort((a, b) => b.score - a.score);
    const topKItems = candidates.slice(0, topK);

    const promotedSet = new Set(promoted.map((p) => p.toolName));

    const visibleTools: ToolDescriptor[] = [
      ...promoted.map((p) => toolByName.get(p.toolName)!),
      ...topKItems
        .filter((c) => !promotedSet.has(c.toolName))
        .map((c) => toolByName.get(c.toolName)!),
    ];
    const matchedToolNames = [
      ...promoted.map((p) => p.toolName),
      ...topKItems
        .filter((c) => !promotedSet.has(c.toolName))
        .map((c) => c.toolName),
    ];

    const fallbackUsed = topKItems.length > 0;

 // 发现工具展开（Change 1）：把 promoted 工具的同域兄弟以低优候选补入 visibleTools，
 // 与 planning 对 toolNames 的展开保持一致（观测/路由一致性）。默认 / 未启用时为 no-op。
    if (ctx.discoveryExpansion?.enabled === true) {
      const universe = new Set(toolByName.keys());
      const excludeSet = new Set<string>(ctx.gatingPolicy?.excludeTools ?? []);
      const expanded = expandDiscoverySiblings(
        promoted.map((p) => p.toolName),
        ctx.discoveryExpansion,
        universe,
        excludeSet,
      );
      const alreadyVisible = new Set(visibleTools.map((t) => t.name));
      for (const name of expanded) {
        if (alreadyVisible.has(name)) continue;
        const tool = toolByName.get(name);
        if (!tool) continue;
        visibleTools.push(tool);
        matchedToolNames.push(name);
        alreadyVisible.add(name);
      }
    }

    ctx.observability.emit({
      timestamp: Date.now(),
      correlation: ctx.correlation,
      subject: ctx.subject,
      phase: "planning",
      type: "tool_activation",
      payload: {
        visibleTools: visibleTools.map((t) => t.name),
        fallbackUsed,
        perStrategyMs,
        hits: merged.map((m) => ({
          toolName: m.toolName,
          score: m.score,
          sources: m.sources,
        })),
      },
    });

    return {
      visibleTools,
      matchedToolNames,
      fallbackUsed,
      perStrategyMs,
      trace,
    };
};

export class DefaultToolActivator implements ToolActivator {
  private readonly strategies: ToolCandidateStrategy[];
  private readonly topK: number;

  constructor(options: ToolActivatorOptions) {
    this.strategies = options.strategies;
    this.topK = options.topK ?? DEFAULT_TOP_K;
  }

  async activate(ctx: ToolActivationContext): Promise<ToolActivationResult> {
    const scored = await scoreToolStrategies(ctx, this.strategies);
    return selectVisibleTools(ctx, scored, this.topK);
  }
}
