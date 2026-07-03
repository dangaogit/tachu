import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class AlwaysActivationPinningStrategy implements PinningStrategy {
  readonly name = "always-activation";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    return ctx.registry
      .list("skill")
      .filter((skill) => skill.activation.mode === "always" && skill.deprecated !== true)
      .map((skill) => ({
        skillName: skill.name,
        reason: "always",
      }));
  }
}
