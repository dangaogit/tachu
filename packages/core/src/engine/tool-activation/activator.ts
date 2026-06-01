import type { ToolDescriptor } from "../../types/descriptor";
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

export class DefaultToolActivator implements ToolActivator {
  private readonly strategies: ToolCandidateStrategy[];
  private readonly topK: number;

  constructor(options: ToolActivatorOptions) {
    this.strategies = options.strategies;
    this.topK = options.topK ?? DEFAULT_TOP_K;
  }

  async activate(ctx: ToolActivationContext): Promise<ToolActivationResult> {
 // Bypass all strategies when host signals disable
    if (ctx.disableAllStrategies) {
      return {
        visibleTools: [...ctx.agentVisibleTools],
        matchedToolNames: [],
        fallbackUsed: false,
        perStrategyMs: {},
        trace: { strategyFailures: [] },
      };
    }

 // No strategies → return full visible set (backward-compatible)
    if (this.strategies.length === 0) {
      return {
        visibleTools: [...ctx.agentVisibleTools],
        matchedToolNames: [],
        fallbackUsed: false,
        perStrategyMs: {},
        trace: { strategyFailures: [] },
      };
    }

    const perStrategyMs: Record<string, number> = {};
    const trace: ToolActivationResult["trace"] = { strategyFailures: [] };
    const raw: Array<ToolCandidateContribution & { strategy: string }> = [];

 // Run all strategies in parallel
    await Promise.all(
      this.strategies.map(async (strategy) => {
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

    const merged = mergeContributions(raw);

 // When no strategies produced contributions, fall back to the
 // full agent-visible set rather than hiding all tools. This preserves the
 // historical no-strategies behaviour when strategies are present but none
 // matched the current query (e.g. NameMatch with no explicit mentions and
 // no SemanticIndex injected).
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
    const topKItems = candidates.slice(0, this.topK);

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
  }
}
