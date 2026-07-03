/**
 * Deterministic host gating manifest for one turn.
 *
 * Produced purely by host/config/agent-snapshot gating (no LLM/intent step).
 * {@link GatingPolicy} is always present on {@link InputMetadata} with a stable
 * wire shape. Tachu hard-enforces the lists without interpreting host-defined
 * `visualization` or domain-specific names.
 */
export interface GatingPolicy {
  excludeTools: string[];
  includeTools: string[];
  explicitSkills: string[];
  excludeSkills: string[];
  pinSkills: string[];
  visualization: string;
}
