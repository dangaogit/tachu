import type { Tokenizer } from "../../prompt/tokenizer";
import type { SkillDescriptor } from "../../types";
import type { ActivationBudget } from "./types";

export const DEFAULT_CANDIDATE_TOP_K = 20;

export const computeActivationBudget = (
  skillBudget: number,
  maxContextTokens: number,
  reserveOutputTokens: number,
): ActivationBudget => {
  const limit = maxContextTokens - reserveOutputTokens;
  const skillTokenLimit = Math.floor(limit * skillBudget);
  return {
    t0Limit: Math.floor(skillTokenLimit * 0.7),
    t1Limit: Math.min(1_000, Math.floor(skillTokenLimit * 0.3)),
  };
};

export const countPinnedSkillTokens = (
  tokenizer: Tokenizer,
  skills: SkillDescriptor[],
): number => {
  if (skills.length === 0) {
    return 0;
  }
  const text = skills.map((skill) => `### ${skill.name}\n${skill.instructions}`).join("\n\n");
  return tokenizer.count(text);
};

export const countCandidateSkillTokens = (
  tokenizer: Tokenizer,
  skills: SkillDescriptor[],
): number => {
  if (skills.length === 0) {
    return 0;
  }
  const text = skills.map((skill) => `- **${skill.name}**: ${skill.description}`).join("\n");
  return tokenizer.count(text);
};
