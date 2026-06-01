import type { ActivationContext, PinningStrategy, PinnedContribution } from "../types";

export class StickyPinningStrategy implements PinningStrategy {
  readonly name = "sticky";

  async pin(ctx: ActivationContext): Promise<PinnedContribution[]> {
    const { active } = await ctx.stickyManager.list(ctx.sessionId, ctx.currentTurn);
    return active.map((entry) => ({
      skillName: entry.skillName,
      reason: `sticky:turn-${entry.addedTurn}`,
    }));
  }
}
