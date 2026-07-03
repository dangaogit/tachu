import type { RuleDescriptor } from "../../types";
import { activateDescriptors } from "./core";
import type {
  ActivationProfile,
  ActivationResult,
  ActivationTurn,
  DescriptorKind,
  PlacementAdapter,
} from "./types";

export * from "./types";

export const createRulePlacementAdapter = (): PlacementAdapter<"rule"> => ({
  place: ({ activeDescriptors }) => [...activeDescriptors],
});

export const createRuleActivationProfile = (): ActivationProfile<"rule"> => ({
  getActivation: (rule: RuleDescriptor) => rule.activation,
  placement: createRulePlacementAdapter(),
});

export const createActivation = (options: {
  profiles: Partial<{ [K in DescriptorKind]: ActivationProfile<K> }>;
}): {
  activate<K extends DescriptorKind>(
    kind: K,
    turn: ActivationTurn<K>,
  ): Promise<ActivationResult<K>>;
} => ({
  async activate<K extends DescriptorKind>(
    kind: K,
    turn: ActivationTurn<K>,
  ): Promise<ActivationResult<K>> {
    const profile = options.profiles[kind] as ActivationProfile<K> | undefined;
    if (!profile) {
      throw new Error(`Activation profile is not configured for descriptor kind "${kind}"`);
    }
    return activateDescriptors(kind, profile, turn);
  },
});

export type { ActivationProfile, PlacementAdapter };
