import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class GatingPolicyPinningStrategy implements PinningStrategy {
  readonly name = "gating-policy-pin";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const names = ctx.gatingPolicy?.pinSkills ?? [];
    return names
      .map((skillName) => {
        const skill = ctx.registry.get("skill", skillName);
        if (!skill || skill.deprecated === true) return null;
        return {
          skillName,
          reason: "gating-policy:pin",
        } satisfies PinnedContribution;
      })
      .filter((item): item is PinnedContribution => item !== null);
  }
}
