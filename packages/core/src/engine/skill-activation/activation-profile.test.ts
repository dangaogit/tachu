import { describe, expect, test } from "bun:test";
import type { Activation, SkillDescriptor } from "../../types";
import type { Tokenizer } from "../../prompt/tokenizer";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import { createActivation } from "../activation";
import { createSkillActivationProfile } from "./activation-profile";
import { InMemoryStickyManager } from "./sticky";
import type { ActivationContext, CandidateStrategy } from "./types";

const tokenizer: Tokenizer = {
  count: (text) => text.length,
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

const skill = (
  name: string,
  activation: Activation = { mode: "semantic" },
): SkillDescriptor => ({
  kind: "skill",
  name,
  description: `${name} description`,
  instructions: `${name} instructions`,
  activation,
});

const activateSkills = async (
  skills: SkillDescriptor[],
  options: {
    explicitNames?: ReadonlySet<string>;
    semanticActiveNames?: ReadonlySet<string>;
    semanticRetrieval?: SemanticRetrievalFacade;
  } = {},
) => {
  const activation = createActivation({
    profiles: {
      skill: createSkillActivationProfile({
        tokenizer,
        stickyManager: new InMemoryStickyManager(),
        budget: { t0Limit: 10_000, t1Limit: 1_000 },
        sessionId: "s1",
        currentTurn: 1,
        semanticRetrieval: options.semanticRetrieval,
      }),
    },
  });

  return activation.activate("skill", {
    query: "hello",
    registry: {
      list: () => skills,
    },
    ...options,
  });
};

describe("createSkillActivationProfile", () => {
  test("maps always to pinned activation and explicit to manual activation", async () => {
    const skills = [
      skill("always-on", { mode: "always" }),
      skill("manual-only", { mode: "manual" }),
    ];

    const inactiveManual = await activateSkills(skills);
    expect(inactiveManual.active.map((item) => item.name)).toEqual(["always-on"]);

    const activeManual = await activateSkills(skills, {
      explicitNames: new Set(["manual-only"]),
    });
    expect(new Set(activeManual.active.map((item) => item.name))).toEqual(new Set([
      "always-on",
      "manual-only",
    ]));
  });

  test("recalls semantic skills through the embedding-llm candidate strategy", async () => {
    const semanticRetrieval: SemanticRetrievalFacade = {
      retrieve: async (request) => ({
        caller: request.caller,
        namespace: request.namespace,
        strategy: "embedding_runtime",
        degraded: false,
        hits: (request.corpus ?? []).map((item) => ({
          id: item.id,
          score: item.id === "chart-output" ? 0.9 : 0.1,
        })),
      }),
    };

    const result = await activateSkills(
      [
        skill("chart-output", { mode: "semantic" }),
        skill("other-skill", { mode: "semantic" }),
      ],
      { semanticRetrieval },
    );

    expect(result.active.map((item) => item.name)).toEqual([
      "chart-output",
      "other-skill",
    ]);
    expect(result.decisions.find((item) => item.name === "chart-output")?.score).toBe(
      0.9,
    );
  });

  test("activates semantic skills only when they are in semanticActiveNames", async () => {
    const skills = [
      skill("semantic-one", { mode: "semantic" }),
      skill("semantic-two", { mode: "semantic" }),
    ];

    const inactive = await activateSkills(skills);
    expect(inactive.active).toEqual([]);

    const active = await activateSkills(skills, {
      semanticActiveNames: new Set(["semantic-two"]),
    });
    expect(active.active.map((item) => item.name)).toEqual(["semantic-two"]);
  });

  test("trims t1 candidates before sticky pinned skills when budgets are exceeded", async () => {
    const stickyManager = new InMemoryStickyManager({ ttlTurns: 10 });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "sticky-old",
      source: "load_skill_tool",
      currentTurn: 1,
    });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "sticky-new",
      source: "load_skill_tool",
      currentTurn: 2,
    });

    class FixedScoreStrategy implements CandidateStrategy {
      readonly name = "fixed-score";

      async score(_ctx: ActivationContext) {
        return [
          { skillName: "candidate-low", score: 0.1, reason: "fixed" },
          { skillName: "candidate-high", score: 0.9, reason: "fixed" },
        ];
      }
    }

    const observability = new DefaultObservabilityEmitter();
    const trimmed: Array<{ name: string; tier: "t1" | "t0-sticky" }> = [];
    observability.on("skill_activation", (event) => {
      const budget = event.payload.budget as {
        trimmed?: Array<{ name: string; tier: "t1" | "t0-sticky" }>;
      };
      trimmed.push(...(budget.trimmed ?? []));
    });

    const activation = createActivation({
      profiles: {
        skill: createSkillActivationProfile({
          tokenizer,
          stickyManager,
          budget: { t0Limit: 40, t1Limit: 95 },
          sessionId: "s1",
          currentTurn: 3,
          candidateStrategies: [new FixedScoreStrategy()],
          observability,
        }),
      },
    });

    const result = await activation.activate("skill", {
      query: "hello",
      registry: {
        list: () => [
          skill("sticky-old"),
          skill("sticky-new"),
          {
            ...skill("candidate-low", { mode: "semantic" }),
            description: "low ".repeat(20),
          },
          {
            ...skill("candidate-high", { mode: "semantic" }),
            description: "high",
          },
        ],
      },
    });

    expect(trimmed).toEqual([
      { name: "candidate-low", tier: "t1" },
      { name: "sticky-old", tier: "t0-sticky" },
    ]);
    expect(result.active.map((item) => item.name)).toEqual([
      "sticky-new",
      "candidate-high",
    ]);
  });

  test("pins sticky skills across turns and promotes candidates to pinned", async () => {
    const stickyManager = new InMemoryStickyManager({ ttlTurns: 10 });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "sticky-skill",
      source: "load_skill_tool",
      currentTurn: 1,
    });

    class PromoteStrategy implements CandidateStrategy {
      readonly name = "promote";

      async score(_ctx: ActivationContext) {
        return [
          {
            skillName: "promoted-skill",
            score: 0.99,
            reason: "strong-match",
            promote: { reason: "high-confidence" },
          },
        ];
      }
    }

    const observability = new DefaultObservabilityEmitter();
    const pinnedSources = new Map<string, Array<{ reason: string }>>();
    observability.on("skill_activation", (event) => {
      const pinned = event.payload.pinned as Array<{
        name: string;
        sources: Array<{ reason: string }>;
      }>;
      for (const item of pinned) {
        pinnedSources.set(item.name, item.sources);
      }
    });

    const activation = createActivation({
      profiles: {
        skill: createSkillActivationProfile({
          tokenizer,
          stickyManager,
          budget: { t0Limit: 10_000, t1Limit: 1_000 },
          sessionId: "s1",
          currentTurn: 2,
          candidateStrategies: [new PromoteStrategy()],
          observability,
        }),
      },
    });

    const result = await activation.activate("skill", {
      query: "hello",
      registry: {
        list: () => [
          skill("sticky-skill"),
          skill("promoted-skill", { mode: "semantic" }),
        ],
      },
    });

    expect(new Set(result.active.map((item) => item.name))).toEqual(new Set([
      "sticky-skill",
      "promoted-skill",
    ]));
    expect(pinnedSources.get("sticky-skill")?.[0]?.reason).toStartWith("sticky:");
    expect(
      pinnedSources
        .get("promoted-skill")
        ?.some((source) => source.reason === "promote:high-confidence"),
    ).toBe(true);
  });

  test("throws the existing protected pinned budget error when t0 is exceeded", async () => {
    await expect(
      activateSkills(
        [
          {
            ...skill("big-always", { mode: "always" }),
            instructions: "x".repeat(500),
          },
        ],
        {},
      ),
    ).resolves.toBeDefined();

    const activation = createActivation({
      profiles: {
        skill: createSkillActivationProfile({
          tokenizer,
          stickyManager: new InMemoryStickyManager(),
          budget: { t0Limit: 100, t1Limit: 50 },
          sessionId: "s1",
          currentTurn: 1,
        }),
      },
    });

    await expect(
      activation.activate("skill", {
        query: "hello",
        registry: {
          list: () => [
            {
              ...skill("big-always", { mode: "always" }),
              instructions: "x".repeat(500),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "OUT_OF_RANGE_SKILL_BUDGET" });
  });
});
