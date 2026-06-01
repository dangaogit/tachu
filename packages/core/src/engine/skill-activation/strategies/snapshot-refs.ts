import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class SnapshotRefsPinningStrategy implements PinningStrategy {
  readonly name = "snapshot-refs";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const contributions: PinnedContribution[] = [];
    for (const skillName of ctx.snapshotSkillRefs) {
      const skill = ctx.registry.get("skill", skillName);
      if (!skill || skill.deprecated === true) {
        continue;
      }
      contributions.push({
        skillName,
        reason: "snapshot-ref",
      });
    }
    return contributions;
  }
}
