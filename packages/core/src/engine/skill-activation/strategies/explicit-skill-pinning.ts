import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class ExplicitSkillPinningStrategy implements PinningStrategy {
  readonly name = "turn-policy-explicit";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const names = ctx.turnPolicy?.explicitSkills ?? [];
    return names
      .map((skillName) => {
        const skill = ctx.registry.get("skill", skillName);
        if (!skill || skill.deprecated === true) return null;
        return {
          skillName,
          reason: "explicit-skill-mention",
        } satisfies PinnedContribution;
      })
      .filter((item): item is PinnedContribution => item !== null);
  }
}
