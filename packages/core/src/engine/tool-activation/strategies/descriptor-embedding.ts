import { descriptorMetadataText } from "../../../types/descriptor";
import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "../types";

/**
 * Semantic / descriptor-embedding tool candidate strategy.
 *
 * Resolution order:
 * 1. `ctx.semanticRetrieval` (`SemanticRetrievalFacade`) — policy-aware, profile-aware.
 *
 * When not injected, returns no contributions.
 *
 * Mirrors the symmetric `EmbeddingLlmCandidateStrategy` for skills.
 */
export class DescriptorEmbeddingToolCandidateStrategy implements ToolCandidateStrategy {
  readonly name = "descriptor-embedding";

  constructor(
    private readonly options: {
 /** Minimum cosine-similarity score the index must return to count. */
      readonly minScore?: number;
 /** Namespace passed to the facade (`tool/<namespace>`). Defaults to `descriptor`. */
      readonly namespace?: string;
    } = {},
  ) {}

  async score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]> {
    const query = ctx.query ?? "";
    if (query.trim().length === 0) return [];

    const tools = ctx.agentVisibleTools.filter((t) => t.deprecated !== true);
    if (tools.length === 0) return [];

    const corpus = tools.map((t) => ({
      id: t.name,
      text: descriptorMetadataText(t),
    }));
    const minScore = this.options.minScore ?? 0;

    const facade = ctx.semanticRetrieval;
    if (facade !== undefined) {
      const result = await facade.retrieve(
        {
          caller: "tool",
          namespace: this.options.namespace ?? "descriptor",
          query,
          corpus,
        },
        {
          correlation: ctx.correlation,
          ...(ctx.subject !== undefined ? { subject: ctx.subject } : {}),
        },
        ctx.signal,
      );
      return result.hits
        .filter((h) => h.score >= minScore)
        .map((h) => ({
          toolName: h.id,
          score: h.score,
          reason: `descriptor-embedding:${h.score.toFixed(3)}`,
        }));
    }

    return [];
  }
}
