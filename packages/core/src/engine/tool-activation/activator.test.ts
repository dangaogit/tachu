import { describe, it, expect, mock } from "bun:test";
import type { ToolDescriptor } from "../../types/descriptor";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import type { DescriptorRegistry } from "../../registry";
import type { EngineEvent } from "../../types/events";
import { DefaultToolActivator } from "./activator";
import type {
  ToolActivationContext,
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTool = (name: string): ToolDescriptor => ({
  kind: "tool",
  name,
  description: `${name} description`,
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 5000,
  inputSchema: {},
  execute: `${name}-executor`,
});

const makeCorrelation = () => ({
  traceId: "test-trace",
  requestId: "test-req",
  sessionId: "test-session",
  turnId: "1",
});

const makeObservability = (): { emitter: DefaultObservabilityEmitter; events: EngineEvent[] } => {
  const events: EngineEvent[] = [];
  const emitter = new DefaultObservabilityEmitter();
  emitter.on("*", (e) => { events.push(e); });
  return { emitter, events };
};

const makeRegistry = (): DescriptorRegistry => ({
  list: () => [],
  get: () => null,
  register: () => {},
  unregister: () => {},
  snapshot: () => ({ skills: [], tools: [], rules: [], agents: [] }),
} as unknown as DescriptorRegistry);

const makeCtx = (
  tools: ToolDescriptor[],
  strategies: ToolCandidateStrategy[],
  overrides: Partial<ToolActivationContext> = {},
): { ctx: ToolActivationContext; activator: DefaultToolActivator; obs: ReturnType<typeof makeObservability> } => {
  const obs = makeObservability();
  const ctx: ToolActivationContext = {
    query: "test query",
    agentVisibleTools: tools,
    registry: makeRegistry(),
    observability: obs.emitter,
    signal: new AbortController().signal,
    correlation: makeCorrelation(),
    ...overrides,
  };
  const activator = new DefaultToolActivator({ strategies, topK: 3 });
  return { ctx, activator, obs };
};

const makeStrategy = (
  name: string,
  contributions: ToolCandidateContribution[],
): ToolCandidateStrategy => ({
  name,
  score: async () => contributions,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultToolActivator", () => {
  it("disableAllStrategies: returns agentVisibleTools as-is, no strategy called", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const spy = mock(async () => []);
    const strategy = { name: "fake", score: spy };
    const { ctx, activator } = makeCtx(tools, [strategy]);
    ctx.disableAllStrategies = true;

    const result = await activator.activate(ctx);

    expect(result.visibleTools).toEqual(tools);
    expect(result.fallbackUsed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no strategies: returns agentVisibleTools as-is", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const { ctx, activator } = makeCtx(tools, []);

    const result = await activator.activate(ctx);

    expect(result.visibleTools).toEqual(tools);
    expect(result.fallbackUsed).toBe(false);
  });

  it("max-merge: score = max across strategies for same tool", async () => {
    const tools = [makeTool("search"), makeTool("calc"), makeTool("write")];
    const s1 = makeStrategy("keyword", [
      { toolName: "search", score: 0.6, reason: "keyword:search" },
      { toolName: "calc", score: 0.4, reason: "keyword:calc" },
    ]);
    const s2 = makeStrategy("semantic", [
      { toolName: "search", score: 0.8, reason: "embedding:0.8" },
      { toolName: "write", score: 0.7, reason: "embedding:0.7" },
    ]);
    const { ctx, activator } = makeCtx(tools, [s1, s2]);

    const result = await activator.activate(ctx);

 // search should score 0.8 (max of 0.6 and 0.8)
    const names = result.visibleTools.map((t) => t.name);
    expect(names).toContain("search");
 // search is first (highest score)
    expect(names[0]).toBe("search");
  });

  it("promote path: promoted tools appear first, others fill topK from rest", async () => {
    const tools = [makeTool("a"), makeTool("b"), makeTool("c"), makeTool("d")];
    const strategy = makeStrategy("keyword", [
      { toolName: "b", score: 1.0, reason: "exact", promote: { reason: "exact-name" } },
      { toolName: "a", score: 0.9, reason: "high-score" },
      { toolName: "c", score: 0.5, reason: "mid-score" },
      { toolName: "d", score: 0.1, reason: "low-score" },
    ]);
 // topK=3 → promoted: [b], fallback: [a, c, d].slice(0,3) = [a, c, d]
    const { ctx, activator } = makeCtx(tools, [strategy]);

    const result = await activator.activate(ctx);

    expect(result.visibleTools[0]!.name).toBe("b"); // promoted first
    expect(result.visibleTools.map((t) => t.name)).toContain("a");
    expect(result.visibleTools.map((t) => t.name)).toContain("c");
  });

  it("discoveryExpansion: promoted 工具的同域兄弟以低优候选补入 visibleTools", async () => {
    const tools = [
      makeTool("query_database"),
      makeTool("search_ontology"),
      makeTool("list_databases"),
      makeTool("unrelated"),
    ];
 // 仅 promote query_database；兄弟不由任何 strategy 贡献 → 只能靠 discoveryExpansion 补入
    const strategy = makeStrategy("intent", [
      { toolName: "query_database", score: 1, reason: "pinned", promote: { reason: "include" } },
    ]);
    const { ctx, activator } = makeCtx(tools, [strategy]);
    ctx.discoveryExpansion = {
      enabled: true,
      siblings: { query_database: ["search_ontology", "list_databases"] },
    };

    const result = await activator.activate(ctx);
    const names = result.visibleTools.map((t) => t.name);
    expect(names[0]).toBe("query_database"); // promoted 仍排在最前
    expect(names).toContain("search_ontology");
    expect(names).toContain("list_databases");
    expect(names).not.toContain("unrelated");
  });

  it("topK clipping: non-promoted candidates capped at topK", async () => {
    const tools = [makeTool("a"), makeTool("b"), makeTool("c"), makeTool("d"), makeTool("e")];
    const strategy = makeStrategy("keyword", [
      { toolName: "a", score: 0.9, reason: "r" },
      { toolName: "b", score: 0.8, reason: "r" },
      { toolName: "c", score: 0.7, reason: "r" },
      { toolName: "d", score: 0.6, reason: "r" },
      { toolName: "e", score: 0.5, reason: "r" },
    ]);
 // topK=3 → only a, b, c returned
    const { ctx, activator } = makeCtx(tools, [strategy]);

    const result = await activator.activate(ctx);

    expect(result.visibleTools).toHaveLength(3);
    expect(result.visibleTools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(result.fallbackUsed).toBe(true);
  });

  it("unknown tool names are filtered out from visibleTools", async () => {
    const tools = [makeTool("known")];
    const strategy = makeStrategy("keyword", [
      { toolName: "known", score: 0.9, reason: "r" },
      { toolName: "ghost", score: 1.0, reason: "r" }, // not in agentVisibleTools
    ]);
    const { ctx, activator } = makeCtx(tools, [strategy]);

    const result = await activator.activate(ctx);

    expect(result.visibleTools.map((t) => t.name)).toEqual(["known"]);
  });

  it("strategy failure: other strategies still run, failure recorded in trace", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const failing = { name: "broken", score: async () => { throw new Error("boom"); } };
    const working = makeStrategy("ok", [
      { toolName: "search", score: 0.8, reason: "r" },
    ]);
    const { ctx, activator, obs } = makeCtx(tools, [failing, working]);

    const result = await activator.activate(ctx);

    expect(result.trace.strategyFailures).toHaveLength(1);
    expect(result.trace.strategyFailures[0]!.strategy).toBe("broken");
    expect(result.trace.strategyFailures[0]!.error).toBe("boom");
    expect(result.visibleTools.map((t) => t.name)).toContain("search");

 // tool_activation_strategy_failed event emitted
    const failedEvent = obs.events.find((e) => e.type === "tool_activation_strategy_failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.payload.strategy).toBe("broken");
  });

  it("tool_activation event emitted on successful run", async () => {
    const tools = [makeTool("search")];
    const strategy = makeStrategy("keyword", [
      { toolName: "search", score: 0.9, reason: "r" },
    ]);
    const { ctx, activator, obs } = makeCtx(tools, [strategy]);

    await activator.activate(ctx);

    const evt = obs.events.find((e) => e.type === "tool_activation");
    expect(evt).toBeDefined();
    expect(evt!.correlation).toEqual(makeCorrelation());
    expect(evt!.payload.visibleTools).toContain("search");
  });

  it("reports matched tool names separately from full-set fallback", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const strategy = makeStrategy("keyword", [
      { toolName: "search", score: 0.9, reason: "r" },
    ]);
    const { ctx, activator } = makeCtx(tools, [strategy]);

    const result = await activator.activate(ctx);

    expect(result.visibleTools.map((t) => t.name)).toContain("search");
    expect(result.matchedToolNames).toEqual(["search"]);

    const noHit = makeCtx(tools, [makeStrategy("empty", [])]);
    const fallback = await noHit.activator.activate(noHit.ctx);
    expect(fallback.visibleTools.map((t) => t.name)).toEqual(["search", "calc"]);
    expect(fallback.matchedToolNames).toEqual([]);
  });

  it("perStrategyMs recorded for each strategy", async () => {
    const tools = [makeTool("a")];
    const s1 = makeStrategy("s1", [{ toolName: "a", score: 0.5, reason: "r" }]);
    const s2 = makeStrategy("s2", []);
    const { ctx, activator } = makeCtx(tools, [s1, s2]);

    const result = await activator.activate(ctx);

    expect(result.perStrategyMs).toHaveProperty("s1");
    expect(result.perStrategyMs).toHaveProperty("s2");
    expect(typeof result.perStrategyMs["s1"]).toBe("number");
  });

  it("intent turn policy exclude wins over include promote", async () => {
    const tools = [makeTool("image.qwen"), makeTool("search")];
    const { IntentTurnPolicyToolStrategy } = await import("./strategies/intent-turn-policy");
    const strategy = new IntentTurnPolicyToolStrategy();
    const { ctx, activator } = makeCtx(tools, [strategy], {
      turnPolicy: {
        excludeTools: ["image.qwen"],
        includeTools: ["image.qwen"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
    });

    const result = await activator.activate(ctx);

    expect(result.visibleTools.map((tool) => tool.name)).not.toContain("image.qwen");
  });
});
