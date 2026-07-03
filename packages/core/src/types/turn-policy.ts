/**
 * Turn-level operational manifest.
 *
 * After deterministic host gating, {@link TurnPolicy} is always present on
 * {@link InputMetadata} with a stable wire shape. Tachu hard-enforces lists
 * without interpreting host-defined `visualization` or domain-specific names.
 */
export interface TurnPolicy {
  excludeTools: string[];
  includeTools: string[];
  explicitSkills: string[];
  excludeSkills: string[];
  pinSkills: string[];
  visualization: string;
}
