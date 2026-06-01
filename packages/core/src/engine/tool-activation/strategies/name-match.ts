import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "../types";

/**
 * Name-based tool candidate strategy ().
 *
 * Activates tools whose `name`, `displayName`, or `tags` appear in the query string.
 * Match precedence:
 * 1. exact case-sensitive name → score 1.0
 * 2. case-insensitive name match → score 0.9
 * 3. displayName / alias match → score 0.75
 * 4. tag match → score 0.6
 *
 * Exact name matches additionally `promote` the tool so the activator surfaces
 * it regardless of the global topK cap.
 */
export class NameMatchToolCandidateStrategy implements ToolCandidateStrategy {
  readonly name = "name-match";

  async score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]> {
    const query = ctx.query ?? "";
    if (query.trim().length === 0) {
      return [];
    }

    const lowered = query.toLowerCase();
    const out: ToolCandidateContribution[] = [];

    for (const tool of ctx.agentVisibleTools) {
 const exactName = new RegExp(`(^|\\W)${escapeRegExp(tool.name)}(\\W|$)`).test(query);
      if (exactName) {
        out.push({
          toolName: tool.name,
          score: 1,
          reason: `name-match:exact`,
          promote: { reason: "name-match:exact" },
        });
        continue;
      }

      const lowerName = tool.name.toLowerCase();
      if (lowered.includes(lowerName)) {
        out.push({
          toolName: tool.name,
          score: 0.9,
          reason: `name-match:case-insensitive`,
        });
        continue;
      }

      if (tool.displayName !== undefined) {
        const dn = tool.displayName.toLowerCase();
        if (dn.length > 1 && lowered.includes(dn)) {
          out.push({
            toolName: tool.name,
            score: 0.75,
            reason: `name-match:displayName`,
          });
          continue;
        }
      }

      if (tool.tags && tool.tags.length > 0) {
        const tagHit = tool.tags.find(
          (t) => t.length > 1 && lowered.includes(t.toLowerCase()),
        );
        if (tagHit !== undefined) {
          out.push({
            toolName: tool.name,
            score: 0.6,
            reason: `name-match:tag:${tagHit}`,
          });
        }
      }
    }

    return out;
  }
}

const escapeRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
