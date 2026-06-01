import type { TurnPolicy } from "../../../types/turn-policy";
import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "../types";

export class IntentTurnPolicyToolStrategy implements ToolCandidateStrategy {
  readonly name = "intent-turn-policy";

  async score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]> {
    const policy: TurnPolicy | undefined = ctx.turnPolicy;
    if (!policy) return [];

    const contributions: ToolCandidateContribution[] = [];
    for (const toolName of policy.excludeTools) {
      contributions.push({
        toolName,
        score: 0,
        reason: "intent-turn-policy:exclude",
        exclude: { reason: "intent-turn-policy:exclude" },
      });
    }
    const visible = new Set(ctx.agentVisibleTools.map((tool) => tool.name));
    for (const toolName of policy.includeTools) {
      if (!visible.has(toolName)) continue;
      contributions.push({
        toolName,
        score: 1,
        reason: "intent-turn-policy:include",
        promote: { reason: "intent-turn-policy:include" },
      });
    }
    return contributions;
  }
}
