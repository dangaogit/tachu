import { descriptorMetadataText } from "../../../types/descriptor";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../../types/context";
import type {
  ActivationContext,
  CandidateContribution,
  CandidateStrategy,
} from "../types";

/**
 * Built-in semantic candidate strategy.
 *
 * Resolution order:
 * 1. `ctx.semanticRetrieval` (`SemanticRetrievalFacade`) — policy-aware.
 * Otherwise returns no contributions.
 */
export class EmbeddingLlmCandidateStrategy implements CandidateStrategy {
  readonly name = "embedding-llm";

  async score(ctx: ActivationContext): Promise<CandidateContribution[]> {
    const pinned = new Set(ctx.snapshotSkillRefs);
    const sticky = new Set(
      (await ctx.stickyManager.list(ctx.sessionId, ctx.currentTurn)).active.map(
        (entry) => entry.skillName,
      ),
    );
    const exclude = new Set([...pinned, ...sticky]);

    const skills = ctx.registry.list("skill").filter((skill) => {
      if (exclude.has(skill.name) || skill.deprecated === true) {
        return false;
      }
      if (skill.activation.mode === "manual" || skill.activation.mode === "always") {
        return false;
      }
      return true;
    });

    if (skills.length === 0) {
      return [];
    }

    const corpus = skills.map((s) => ({ id: s.name, text: descriptorMetadataText(s) }));

    const facade = ctx.semanticRetrieval;
    if (facade !== undefined) {
      const result = await facade.retrieve(
        {
          caller: "skill",
          namespace: "candidate",
          query: ctx.query,
          corpus,
        },
        ctx.correlation !== undefined
          ? {
              correlation: ctx.correlation,
              ...(ctx.subject !== undefined ? { subject: ctx.subject } : {}),
            }
          : DEFAULT_ADAPTER_CALL_CONTEXT,
        ctx.signal,
      );
      return result.hits.map((h) => ({
        skillName: h.id,
        score: h.score,
        reason: `embedding:${h.score.toFixed(3)}`,
      }));
    }

    return [];
  }
}
