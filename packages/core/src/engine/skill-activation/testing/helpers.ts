import type {
  ActivationContext,
  ActivationResult,
  CandidateStrategy,
} from "../types";

/**
 * Test-only embedding port (test fixture).
 *
 * Production code should use {@link SemanticRetrievalFacade} from `@tachu/core`,
 * which is policy-aware and provider-driven.
 * This fixture only exists for unit tests that need a deterministic vector mapping.
 */
interface TestEmbeddingPort {
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export class FakeEmbeddingPort implements TestEmbeddingPort {
  constructor(private readonly vectors: ReadonlyMap<string, number[]>) {}

  async embed(texts: string[], _signal: AbortSignal): Promise<number[][]> {
    return texts.map((text) => this.vectors.get(text) ?? []);
  }
}

/** 测试用 keyword 候选策略：匹配 query 中的 name / displayName 子串。 */
export class KeywordCandidateStrategy implements CandidateStrategy {
  readonly name = "keyword";

  async score(ctx: ActivationContext) {
    const query = ctx.query.toLowerCase();
    const contributions = [];
    for (const skill of ctx.registry.list("skill")) {
      if (skill.deprecated === true || skill.trigger?.type === "explicit" || skill.trigger?.type === "always") {
        continue;
      }
      const needles = [skill.name, skill.displayName].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      for (const needle of needles) {
        if (query.includes(needle.toLowerCase())) {
          contributions.push({
            skillName: skill.name,
            score: needle === skill.displayName ? 0.85 : 0.75,
            reason: `keyword-match:${needle === skill.displayName ? "displayName" : "name"}`,
          });
          break;
        }
      }
    }
    return contributions;
  }
}

export const expectPinned = (result: ActivationResult, name: string): void => {
  const found = result.pinned.some((item) => item.skill.name === name);
  if (!found) {
    throw new Error(`expected pinned skill "${name}"`);
  }
};

export const expectInCandidates = (result: ActivationResult, name: string): void => {
  const found = result.candidates.some((item) => item.skill.name === name);
  if (!found) {
    throw new Error(`expected candidate skill "${name}"`);
  }
};

export const expectExcluded = (
  result: ActivationResult,
  name: string,
  reason?: ActivationResult["excluded"][number]["reason"],
): void => {
  const found = result.excluded.find((item) => item.name === name);
  if (!found) {
    throw new Error(`expected excluded skill "${name}"`);
  }
  if (reason !== undefined && found.reason !== reason) {
    throw new Error(`expected excluded reason ${reason}, got ${found.reason}`);
  }
};
