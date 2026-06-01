import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class TurnPolicyPinningStrategy implements PinningStrategy {
  readonly name = "turn-policy-pin";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const names = ctx.turnPolicy?.pinSkills ?? [];
    return names
      .map((skillName) => {
        const skill = ctx.registry.get("skill", skillName);
        if (!skill || skill.deprecated === true) return null;
        return {
          skillName,
          reason: "intent-turn-policy:pin",
        } satisfies PinnedContribution;
      })
      .filter((item): item is PinnedContribution => item !== null);
  }
}
