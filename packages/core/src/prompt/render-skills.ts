import type { SkillDescriptor } from "../types";

/** Renders active skill instructions for system prompt `## Active Skills` sections. */
export const renderActiveSkills = (skills: SkillDescriptor[]): string =>
  skills.map((skill) => `### ${skill.name}\n${skill.instructions}`).join("\n\n");
