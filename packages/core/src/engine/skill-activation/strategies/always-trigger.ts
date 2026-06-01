import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class AlwaysTriggerPinningStrategy implements PinningStrategy {
  readonly name = "always-trigger";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    return ctx.registry
      .list("skill")
      .filter((skill) => skill.trigger?.type === "always" && skill.deprecated !== true)
      .map((skill) => ({
        skillName: skill.name,
        reason: "always",
      }));
  }
}
