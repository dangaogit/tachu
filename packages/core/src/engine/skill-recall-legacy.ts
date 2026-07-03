import type { ContextWindow } from "../modules/memory";
import type { InputEnvelope, SkillDescriptor } from "../types";

const RECALL_WINDOW_TURNS = 3;
const RECALL_QUERY_MAX_CHARS = 8_000;

export const stringifyRecallContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

export const buildRecallQuery = (
  currentInput: InputEnvelope,
  history: ContextWindow,
  recentTurns = RECALL_WINDOW_TURNS,
): string => {
  const recentUserMessages = history.entries
    .filter((entry) => entry.role === "user")
    .slice(-recentTurns)
    .map((entry) => stringifyRecallContent(entry.content));
  const currentText = stringifyRecallContent(currentInput.content);
  return [...recentUserMessages, currentText].join("\n\n").slice(0, RECALL_QUERY_MAX_CHARS);
};

export type SkillRecallClass = "active" | "available" | "excluded";

export interface SkillRecallCandidateEvent {
  name: string;
  similarity: number;
  class: SkillRecallClass;
  excludedReason?: "deprecated" | "explicit" | "activation_always";
}

export interface ResolvedSkillsForPrompt {
  activeSkills: SkillDescriptor[];
  availableSkills: SkillDescriptor[];
  skillSimilarityMap: Map<string, number>;
  alwaysSkillNames: Set<string>;
  stickySkillNames: Set<string>;
  recallQuery: string;
  recallCandidates: SkillRecallCandidateEvent[];
  recallError?: string;
}

export const resolveSkillsForRun = async (
  _params: unknown,
): Promise<ResolvedSkillsForPrompt> => {
  throw new Error(
    'runtime.skillActivationMode="legacy" was retired; use "activator"',
  );
};
