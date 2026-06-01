import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "../types";

/**
 * Host-supplied tool policy rule ().
 *
 * - `always-allow`: tool is promoted into the visible set unconditionally.
 * - `always-deny`: tool is excluded — emitted with a negative score the
 * activator treats as a hard exclusion (i.e. it removes any earlier
 * contributions for the same tool name in the merge step).
 *
 * `match` matches against the tool's `name`. Hosts may register multiple rules
 * (e.g. block-list + allow-list).
 */
export interface ToolPolicyRule {
  match: string;
  effect: "always-allow" | "always-deny";
  reason?: string;
}

export interface ToolPolicySource {
 /**
 * Returns the current set of host policy rules. Called once per activation;
 * implementations should be cheap.
 */
  list(ctx: ToolActivationContext): readonly ToolPolicyRule[] | Promise<readonly ToolPolicyRule[]>;
}

/**
 * HostRule strategy — applies explicit host-supplied allow/deny rules to the
 * visible tool set. Intended to run **before** name-match and descriptor-based
 * strategies so its `promote` / exclusion decisions take priority.
 */
export class HostRuleToolCandidateStrategy implements ToolCandidateStrategy {
  readonly name = "host-rule";

  constructor(private readonly source: ToolPolicySource) {}

  async score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]> {
    const rules = await this.source.list(ctx);
    if (rules.length === 0) {
      return [];
    }

    const out: ToolCandidateContribution[] = [];
    const denied = new Set<string>();

    for (const rule of rules) {
      if (rule.effect === "always-deny") {
        denied.add(rule.match);
      }
    }

    for (const tool of ctx.agentVisibleTools) {
      if (denied.has(tool.name)) {
        out.push({
          toolName: tool.name,
          score: 0,
          reason: `host-rule:deny`,
          exclude: { reason: "host-rule:deny" },
        });
      }
    }

    for (const rule of rules) {
      if (rule.effect !== "always-allow") continue;
      const found = ctx.agentVisibleTools.find((t) => t.name === rule.match);
      if (found === undefined) continue;
      if (denied.has(found.name)) continue; // deny wins over allow
      out.push({
        toolName: found.name,
        score: 1,
        reason: rule.reason ? `host-rule:allow:${rule.reason}` : `host-rule:allow`,
        promote: { reason: rule.reason ?? "host-rule:allow" },
      });
    }

    return out;
  }
}
