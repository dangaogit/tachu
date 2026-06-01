import { describe, it, expect } from "bun:test";
import type { ToolDescriptor } from "../../../types/descriptor";
import { DefaultObservabilityEmitter } from "../../../modules/observability";
import type { DescriptorRegistry } from "../../../registry";
import type {
  SemanticRetrievalFacade,
  SemanticRetrievalResult,
} from "../../../semantic-retrieval";
import { DefaultToolActivator } from "../activator";
import type { ToolActivationContext } from "../types";
import { NameMatchToolCandidateStrategy } from "./name-match";
import {
  HostRuleToolCandidateStrategy,
  type ToolPolicyRule,
} from "./host-rule";
import { DescriptorEmbeddingToolCandidateStrategy } from "./descriptor-embedding";
import { createDefaultToolCandidateStrategies } from "../default-strategies";

const makeTool = (name: string, extras?: Partial<ToolDescriptor>): ToolDescriptor => ({
  kind: "tool",
  name,
  description: `${name} description`,
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 5000,
  inputSchema: {},
  execute: `${name}-executor`,
  ...(extras ?? {}),
});

const makeCtx = (overrides: Partial<ToolActivationContext>): ToolActivationContext => ({
  query: "",
  agentVisibleTools: [],
  registry: {} as DescriptorRegistry,
  observability: new DefaultObservabilityEmitter(),
  signal: new AbortController().signal,
  correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
  ...overrides,
});

describe("NameMatchToolCandidateStrategy", () => {
  const strat = new NameMatchToolCandidateStrategy();

  it("exact name → score 1 + promote", async () => {
    const tools = [makeTool("read_file"), makeTool("write_file")];
    const res = await strat.score(makeCtx({ query: "please read_file the README", agentVisibleTools: tools }));
    expect(res).toHaveLength(1);
    expect(res[0]?.toolName).toBe("read_file");
    expect(res[0]?.score).toBe(1);
    expect(res[0]?.promote).toBeDefined();
  });

  it("case-insensitive match → score 0.9, no promote", async () => {
    const tools = [makeTool("ReadFile")];
    const res = await strat.score(makeCtx({ query: "use readfile now", agentVisibleTools: tools }));
    expect(res[0]?.score).toBe(0.9);
    expect(res[0]?.promote).toBeUndefined();
  });

  it("tag match → score 0.6", async () => {
    const tools = [makeTool("get_user", { tags: ["account"] })];
    const res = await strat.score(makeCtx({ query: "fetch the account info", agentVisibleTools: tools }));
    expect(res[0]?.score).toBe(0.6);
    expect(res[0]?.reason).toContain("tag:account");
  });

  it("empty query → no contributions", async () => {
    const res = await strat.score(makeCtx({ query: "   ", agentVisibleTools: [makeTool("x")] }));
    expect(res).toHaveLength(0);
  });
});

describe("HostRuleToolCandidateStrategy", () => {
  it("always-deny → emits exclude contribution; activator hard-removes the tool", async () => {
    const rules: ToolPolicyRule[] = [{ match: "shell_exec", effect: "always-deny", reason: "policy" }];
    const strat = new HostRuleToolCandidateStrategy({ list: () => rules });
    const tools = [makeTool("shell_exec"), makeTool("read_file")];
    const activator = new DefaultToolActivator({
      strategies: [strat, new NameMatchToolCandidateStrategy()],
    });
    const ctx = makeCtx({
      query: "run shell_exec and read_file",
      agentVisibleTools: tools,
    });
    const result = await activator.activate(ctx);
    const names = result.visibleTools.map((t) => t.name);
    expect(names).not.toContain("shell_exec");
    expect(names).toContain("read_file");
  });

  it("always-allow → promotes the tool even when no name match exists", async () => {
    const rules: ToolPolicyRule[] = [{ match: "audit_log", effect: "always-allow", reason: "compliance" }];
    const strat = new HostRuleToolCandidateStrategy({ list: () => rules });
    const tools = [makeTool("audit_log"), makeTool("other")];
    const activator = new DefaultToolActivator({ strategies: [strat] });
    const ctx = makeCtx({ query: "something unrelated", agentVisibleTools: tools });
    const result = await activator.activate(ctx);
    expect(result.visibleTools.map((t) => t.name)).toContain("audit_log");
  });

  it("deny wins over allow when both rules target the same tool", async () => {
    const rules: ToolPolicyRule[] = [
      { match: "shell_exec", effect: "always-allow" },
      { match: "shell_exec", effect: "always-deny", reason: "blocklisted" },
    ];
    const strat = new HostRuleToolCandidateStrategy({ list: () => rules });
    const tools = [makeTool("shell_exec")];
    const activator = new DefaultToolActivator({ strategies: [strat] });
    const ctx = makeCtx({ query: "shell_exec please", agentVisibleTools: tools });
    const result = await activator.activate(ctx);
    expect(result.visibleTools.map((t) => t.name)).not.toContain("shell_exec");
  });
});

describe("DescriptorEmbeddingToolCandidateStrategy", () => {
  it("no semanticRetrieval → returns no contributions", async () => {
    const strat = new DescriptorEmbeddingToolCandidateStrategy();
    const res = await strat.score(makeCtx({ query: "x", agentVisibleTools: [makeTool("a")] }));
    expect(res).toHaveLength(0);
  });

  it("semanticRetrieval hits propagated, filtered by minScore", async () => {
    const facade: SemanticRetrievalFacade = {
      retrieve: async (request): Promise<SemanticRetrievalResult> => ({
        caller: request.caller,
        namespace: request.namespace,
        strategy: "embedding_runtime",
        degraded: false,
        hits: (request.corpus ?? []).map((c, i) => ({ id: c.id, score: i === 0 ? 0.9 : 0.2 })),
      }),
    };
    const strat = new DescriptorEmbeddingToolCandidateStrategy({ minScore: 0.5 });
    const tools = [makeTool("a"), makeTool("b")];
    const res = await strat.score(makeCtx({
      query: "anything",
      agentVisibleTools: tools,
      semanticRetrieval: facade,
    }));
    expect(res).toHaveLength(1);
    expect(res[0]?.toolName).toBe("a");
    expect(res[0]?.score).toBeCloseTo(0.9, 5);
  });

  it("semantic activation works without explicit name mention", async () => {
    const facade: SemanticRetrievalFacade = {
      retrieve: async (request): Promise<SemanticRetrievalResult> => ({
        caller: request.caller,
        namespace: request.namespace,
        strategy: "embedding_runtime",
        degraded: false,
        hits: (request.corpus ?? []).map((c) => ({
          id: c.id,
          score: c.id === "read_file" ? 0.85 : 0.1,
        })),
      }),
    };
    const tools = [makeTool("read_file"), makeTool("write_file")];
    const activator = new DefaultToolActivator({
      strategies: [
        new NameMatchToolCandidateStrategy(),
        new DescriptorEmbeddingToolCandidateStrategy({ minScore: 0.5 }),
      ],
    });
    const ctx = makeCtx({
      query: "show me the contents of the configuration",
      agentVisibleTools: tools,
      semanticRetrieval: facade,
    });
    const result = await activator.activate(ctx);
    expect(result.visibleTools.map((t) => t.name)).toContain("read_file");
    expect(result.visibleTools.map((t) => t.name)).not.toContain("write_file");
  });
});

describe("createDefaultToolCandidateStrategies", () => {
  it("default order: HostRule (when source) → IntentTurnPolicy → NameMatch → DescriptorEmbedding", () => {
    const withPolicy = createDefaultToolCandidateStrategies({
      policySource: { list: () => [] },
    });
    expect(withPolicy.map((s) => s.name)).toEqual([
      "host-rule",
      "intent-turn-policy",
      "name-match",
      "descriptor-embedding",
    ]);
    const withoutPolicy = createDefaultToolCandidateStrategies();
    expect(withoutPolicy.map((s) => s.name)).toEqual([
      "intent-turn-policy",
      "name-match",
      "descriptor-embedding",
    ]);
  });
});

describe("DescriptorEmbeddingToolCandidateStrategy · SemanticRetrievalFacade", () => {
  it("uses SemanticRetrievalFacade when injected", async () => {
    const facadeCalls: Array<{ caller: string; namespace: string }> = [];
    const facade: SemanticRetrievalFacade = {
      retrieve: async (request): Promise<SemanticRetrievalResult> => {
        facadeCalls.push({
          caller: request.caller,
          namespace: request.namespace,
        });
        return {
          caller: request.caller,
          namespace: request.namespace,
          strategy: "embedding_runtime",
          degraded: false,
          hits: (request.corpus ?? []).map((item, idx) => ({
            id: item.id,
            score: idx === 0 ? 0.92 : 0.1,
          })),
        };
      },
    };
    const tools = [makeTool("alpha"), makeTool("beta")];
    const strat = new DescriptorEmbeddingToolCandidateStrategy({ minScore: 0.5 });
    const res = await strat.score(
      makeCtx({
        query: "do something",
        agentVisibleTools: tools,
        semanticRetrieval: facade,
      }),
    );
    expect(facadeCalls).toHaveLength(1);
    expect(facadeCalls[0]?.caller).toBe("tool");
    expect(res).toHaveLength(1);
    expect(res[0]?.toolName).toBe("alpha");
    expect(res[0]?.score).toBeCloseTo(0.92, 5);
  });
});
