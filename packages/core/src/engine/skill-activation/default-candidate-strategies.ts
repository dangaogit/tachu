import { EmbeddingLlmCandidateStrategy } from "./strategies/embedding-llm";
import type { CandidateStrategy } from "./types";

/** Built-in candidate strategies; host may append more via `EngineDependencies.candidateStrategies`. */
export const createDefaultCandidateStrategies = (): CandidateStrategy[] => [
  new EmbeddingLlmCandidateStrategy(),
];
