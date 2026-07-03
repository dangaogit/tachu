import { describe, expect, test } from "bun:test";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import { InMemorySessionManager } from "../../modules/session";
import { DescriptorRegistry } from "../../registry";
import { createDefaultEngineConfig } from "../../utils";
import type { Tokenizer } from "../../prompt/tokenizer";
import {
  DefaultSkillActivator,
  InMemoryStickyManager,
  buildActivationQuery,
  computeActivationBudget,
  createDefaultPinningStrategies,
  type ActivationContext,
  type CandidateStrategy,
  type PinningStrategy,
  type PinnedContribution,
} from "../index";
import { executeInternalTool } from "../subflows/internal-tools";
import { DefaultPromptAssembler } from "../../prompt/assembler";
import { EmbeddingLlmCandidateStrategy } from "./strategies/embedding-llm";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import {
  expectExcluded,
  expectInCandidates,
  expectPinned,
  KeywordCandidateStrategy,
} from "./testing/helpers";

const tokenizer: Tokenizer = {
  count: (text) => text.length,
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

const adapterContext = {
  correlation: {
    traceId: "trace-1",
    requestId: "req-1",
    sessionId: "s1",
    turnId: "turn-1",
  },
};

const buildContext = (overrides: Partial<ActivationContext> = {}): ActivationContext => ({
  currentInput: { content: "hello", metadata: { modality: "text", size: 5 } },
  contextWindow: { entries: [], tokenCount: 0, limit: 1000 },
  sessionId: "s1",
  currentTurn: 1,
  snapshotSkillRefs: [],
  registry: new DescriptorRegistry(),
  stickyManager: new InMemoryStickyManager(),
  observability: new DefaultObservabilityEmitter(),
  signal: AbortSignal.timeout(5_000),
  budget: { t0Limit: 10_000, t1Limit: 1_000 },
  query: "hello",
  ...overrides,
});

const createActivator = (
  candidateStrategies: CandidateStrategy[] = [new KeywordCandidateStrategy()],
) =>
  new DefaultSkillActivator({
    pinningStrategies: createDefaultPinningStrategies(),
    candidateStrategies,
    candidateTopK: 20,
    tokenizer,
    adapterContext,
  });

describe("skill-activation R1-R12", () => {
 test("R1 snapshot-refs pins configured skill", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "chart-output",
      description: "charts",
      instructions: "draw charts",
    });
    const result = await createActivator([]).activate(
      buildContext({
        registry,
        snapshotSkillRefs: ["chart-output"],
        query: "anything",
      }),
    );
    expectPinned(result, "chart-output");
    expect(result.pinned[0]?.sources.some((s) => s.strategy === "snapshot-refs")).toBe(true);
  });

 test("R2 keyword strategy matches displayName in Chinese query", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "chart-output",
      displayName: "图表生成",
      description: "可视化",
      instructions: "use echarts",
      trigger: { type: "semantic" },
    });
    const result = await createActivator().activate(
      buildContext({
        registry,
        query: "使用图表生成技能，随机生成几个图表",
        currentInput: {
          content: "使用图表生成技能，随机生成几个图表",
          metadata: { modality: "text", size: 20 },
        },
      }),
    );
    expectInCandidates(result, "chart-output");
    expect(result.candidates[0]?.score ?? 0).toBeGreaterThan(0);
  });

 test("R3 load_skill marks sticky and next turn pins skill", async () => {
    const registry = new DescriptorRegistry();
    const sessions = new InMemorySessionManager();
    const stickyManager = new InMemoryStickyManager();
    await registry.register({
      kind: "skill",
      name: "skill-x",
      description: "x",
      instructions: "do x",
    });
    await sessions.resolve("s1");
    await sessions.beginRun("s1", "r1");

    const events: string[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("skill_sticky_change", (event) => {
      events.push(String(event.payload.action));
    });

    await executeInternalTool(
      "load_skill",
      { name: "skill-x" },
      {
        registry,
        sessionManager: sessions,
        stickyManager,
        observability,
        adapterContext,
      },
    );
    expect(events).toContain("add");

    const turn = await sessions.getCurrentTurn("s1");
    const result = await createActivator([]).activate(
      buildContext({
        registry,
        stickyManager,
        currentTurn: turn,
      }),
    );
    expectPinned(result, "skill-x");
  });

 test("R4 sticky expires after TTL without refresh", async () => {
    const registry = new DescriptorRegistry();
    const stickyManager = new InMemoryStickyManager({ ttlTurns: 2 });
    await registry.register({
      kind: "skill",
      name: "expiring",
      description: "e",
      instructions: "e",
    });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "expiring",
      source: "load_skill_tool",
      currentTurn: 1,
    });

    const expiredEvents: string[] = [];
    const list = await stickyManager.list("s1", 3);
    expect(list.expired.some((entry) => entry.skillName === "expiring")).toBe(true);

    const result = await createActivator([]).activate(
      buildContext({
        registry,
        stickyManager,
        currentTurn: 3,
      }),
    );
    expect(result.pinned.some((item) => item.skill.name === "expiring")).toBe(false);
    expect(expiredEvents.length).toBe(0);
  });

 test("R5 sticky slot LRU evicts oldest on new mark", async () => {
    const stickyManager = new InMemoryStickyManager({ maxSlots: 2, ttlTurns: 20 });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "a",
      source: "load_skill_tool",
      currentTurn: 1,
    });
    await stickyManager.mark({
      sessionId: "s1",
      skillName: "b",
      source: "load_skill_tool",
      currentTurn: 2,
    });
    const markResult = await stickyManager.mark({
      sessionId: "s1",
      skillName: "c",
      source: "load_skill_tool",
      currentTurn: 3,
    });
    expect(markResult.action).toBe("evict");
    expect(markResult.evicted?.skillName).toBe("a");
  });

 test("R6 snapshot+always over t0 budget throws OUT_OF_RANGE_SKILL_BUDGET", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "big-always",
      description: "always",
      instructions: "x".repeat(500),
      trigger: { type: "always" },
    });
    await expect(
      createActivator([]).activate(
        buildContext({
          registry,
          snapshotSkillRefs: ["big-always"],
          budget: { t0Limit: 100, t1Limit: 50 },
        }),
      ),
    ).rejects.toMatchObject({ code: "OUT_OF_RANGE_SKILL_BUDGET" });
  });

 test("R7 trims T1 candidates by ascending score when over t1 budget", async () => {
    const registry = new DescriptorRegistry();
    for (const [name, scoreSeed] of [
      ["low", "aaa"],
      ["mid", "bbb"],
      ["high", "ccc"],
    ] as const) {
      await registry.register({
        kind: "skill",
        name,
        displayName: scoreSeed,
        description: scoreSeed.repeat(20),
        instructions: "i",
        trigger: { type: "semantic" },
      });
    }

    class FixedScoreStrategy implements CandidateStrategy {
      readonly name = "fixed";
      async score() {
        return [
          { skillName: "low", score: 0.2, reason: "fixed" },
          { skillName: "mid", score: 0.5, reason: "fixed" },
          { skillName: "high", score: 0.9, reason: "fixed" },
        ];
      }
    }

    const result = await createActivator([new FixedScoreStrategy()]).activate(
      buildContext({
        registry,
        budget: { t0Limit: 10_000, t1Limit: 90 },
      }),
    );
    expectExcluded(result, "low", "budget-trimmed-t1");
    expect(result.candidates.some((item) => item.skill.name === "high")).toBe(true);
  });

 test("R8 failing strategy is skipped and others still contribute", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "pinned-snap",
      description: "p",
      instructions: "p",
    });

    class FailingStrategy implements PinningStrategy {
      readonly name = "failing";
      async pin(): Promise<PinnedContribution[]> {
        throw new Error("boom");
      }
    }

    const failures: string[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("skill_activation_strategy_failed", (event) => {
      failures.push(String(event.payload.strategy));
    });

    const activator = new DefaultSkillActivator({
      pinningStrategies: [new FailingStrategy(), ...createDefaultPinningStrategies()],
      candidateStrategies: [],
      tokenizer,
      adapterContext,
    });

    const result = await activator.activate(
      buildContext({
        registry,
        observability,
        snapshotSkillRefs: ["pinned-snap"],
      }),
    );
    expect(failures).toEqual(["failing"]);
    expectPinned(result, "pinned-snap");
  });

 test("R9 keeps only top-20 candidates", async () => {
    const registry = new DescriptorRegistry();
    for (let index = 0; index < 25; index += 1) {
      await registry.register({
        kind: "skill",
        name: `skill-${index}`,
        description: `d-${index}`,
        instructions: "i",
        trigger: { type: "semantic" },
      });
    }

    class IndexScoreStrategy implements CandidateStrategy {
      readonly name = "index-score";
      async score(ctx: ActivationContext) {
        return ctx.registry.list("skill").map((skill, index) => ({
          skillName: skill.name,
          score: index / 100,
          reason: "index",
        }));
      }
    }

    const activator = new DefaultSkillActivator({
      pinningStrategies: createDefaultPinningStrategies(),
      candidateStrategies: [new IndexScoreStrategy()],
      candidateTopK: 20,
      tokenizer,
      adapterContext,
    });
    const result = await activator.activate(buildContext({ registry }));
    expect(result.candidates.length).toBe(20);
    expectExcluded(result, "skill-0", "below-topK");
  });

 test("R10 merges multi-strategy scores with max and all sources", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "merged",
      description: "m",
      instructions: "m",
      trigger: { type: "semantic" },
    });

    class LowStrategy implements CandidateStrategy {
      readonly name = "low-strategy";
      async score() {
        return [{ skillName: "merged", score: 0.4, reason: "low" }];
      }
    }
    class HighStrategy implements CandidateStrategy {
      readonly name = "high-strategy";
      async score() {
        return [{ skillName: "merged", score: 0.95, reason: "high" }];
      }
    }

    const result = await createActivator([new LowStrategy(), new HighStrategy()]).activate(
      buildContext({ registry }),
    );
    const candidate = result.candidates.find((item) => item.skill.name === "merged");
    expect(candidate?.score).toBe(0.95);
    expect(candidate?.sources.length).toBe(2);
  });

 test("R11 promote moves candidate to pinned when budget allows", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "promoted",
      description: "p",
      instructions: "promote me",
      trigger: { type: "semantic" },
    });

    class PromoteStrategy implements CandidateStrategy {
      readonly name = "promote-strategy";
      async score() {
        return [
          {
            skillName: "promoted",
            score: 0.99,
            reason: "strong-match",
            promote: { reason: "high-confidence" },
          },
        ];
      }
    }

    const result = await createActivator([new PromoteStrategy()]).activate(
      buildContext({ registry }),
    );
    expectPinned(result, "promoted");
    expect(
      result.pinned.some((item) =>
        item.sources.some((source) => source.reason.startsWith("promote:")),
      ),
    ).toBe(true);
  });

 test("R13 embedding-llm ranks skill when host injects SemanticIndexPort", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "chart-output",
      description: "charts echarts visualization",
      instructions: "use echarts",
      trigger: { type: "semantic" },
    });
    const query = "随机生成几个图表";
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
    const result = await createActivator([new EmbeddingLlmCandidateStrategy()]).activate(
      buildContext({
        registry,
        query,
        semanticRetrieval,
      }),
    );
    expectInCandidates(result, "chart-output");
    const hit = result.candidates.find((item) => item.skill.name === "chart-output");
    expect(hit?.score).toBeGreaterThan(0.5);
  });

 test("R12 omits empty Available Skills section in prompt", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({
      model: "dev-large",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 8_192,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      currentInput: { content: "hello", metadata: { modality: "text", size: 5 } },
      activeRules: [],
      activeSkills: [],
      availableSkills: [],
      availableTools: [],
      contextWindow: { entries: [], tokenCount: 0, limit: 1000 },
      recalledEntries: [],
      reserveOutputTokens: 512,
    });
    const system = result.messages[0]?.content;
    expect(typeof system).toBe("string");
    expect(system).not.toContain("## Available Skills");
  });
});

describe("turn policy skill priority ()", () => {
  const registerChartSkill = async (registry: DescriptorRegistry) => {
    await registry.register({
      kind: "skill",
      name: "chart-output",
      description: "charts",
      instructions: "use echarts",
    });
  };

 test("explicitSkills beat excludeSkills", async () => {
    const registry = new DescriptorRegistry();
    await registerChartSkill(registry);
    const result = await createActivator([]).activate(
      buildContext({
        registry,
        turnPolicy: {
          excludeTools: [],
          includeTools: [],
          explicitSkills: ["chart-output"],
          excludeSkills: ["chart-output"],
          pinSkills: [],
          visualization: "",
        },
      }),
    );
    expectPinned(result, "chart-output");
  });

 test("excludeSkills beat pinSkills when not explicit", async () => {
    const registry = new DescriptorRegistry();
    await registerChartSkill(registry);
    const result = await createActivator([]).activate(
      buildContext({
        registry,
        turnPolicy: {
          excludeTools: [],
          includeTools: [],
          explicitSkills: [],
          excludeSkills: ["chart-output"],
          pinSkills: ["chart-output"],
          visualization: "",
        },
      }),
    );
    expect(result.pinned.some((item) => item.skill.name === "chart-output")).toBe(false);
  });
});

describe("skill-activation utilities", () => {
 test("buildActivationQuery joins recent user turns", () => {
    const query = buildActivationQuery(
      { content: "current", metadata: { modality: "text", size: 7 } },
      {
        entries: [
          { id: "e1", role: "user", content: "old", timestamp: 1, anchored: false },
          { id: "e2", role: "user", content: "recent", timestamp: 2, anchored: false },
        ],
        tokenCount: 0,
        limit: 1000,
      },
    );
    expect(query).toContain("recent");
    expect(query).toContain("current");
  });

 test("buildActivationQuery strips trailing user turn already appended to memory", () => {
    const prompt = "随机生成几个图表";
    const query = buildActivationQuery(
      { content: prompt, metadata: { modality: "text", size: prompt.length } },
      {
        entries: [
          { id: "e1", role: "user", content: prompt, timestamp: 1, anchored: false },
        ],
        tokenCount: 0,
        limit: 1000,
      },
    );
    expect(query).toBe(prompt);
  });

 test("computeActivationBudget splits 70/30 with t1 cap", () => {
    const budget = computeActivationBudget(0.8, 100_000, 4_096);
    expect(budget.t0Limit).toBe(Math.floor(Math.floor(95_904 * 0.8) * 0.7));
    expect(budget.t1Limit).toBe(Math.min(1_000, Math.floor(Math.floor(95_904 * 0.8) * 0.3)));
  });
});
