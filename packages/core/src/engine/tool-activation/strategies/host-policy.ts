import type { TurnPolicy } from "../../../types/turn-policy";
import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "../types";

export class HostPolicyToolStrategy implements ToolCandidateStrategy {
  readonly name = "host-policy";

  async score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]> {
    const policy: TurnPolicy | undefined = ctx.turnPolicy;
    if (!policy) return [];

    const contributions: ToolCandidateContribution[] = [];
    for (const toolName of policy.excludeTools) {
      contributions.push({
        toolName,
        score: 0,
        reason: "host-policy:exclude",
        exclude: { reason: "host-policy:exclude" },
      });
    }
    const visible = new Set(ctx.agentVisibleTools.map((tool) => tool.name));
    for (const toolName of policy.includeTools) {
      if (!visible.has(toolName)) continue;
      contributions.push({
        toolName,
        score: 1,
        reason: "host-policy:include",
        promote: { reason: "host-policy:include" },
      });
    }
    return contributions;
  }
}
