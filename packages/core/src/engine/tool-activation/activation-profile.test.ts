import { describe, expect, it } from "bun:test";
import { createActivation } from "../activation";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import type { ToolDescriptor } from "../../types/descriptor";
import type {
  SemanticRetrievalFacade,
  SemanticRetrievalResult,
} from "../../semantic-retrieval";
import type { EngineEvent } from "../../types/events";
import { DescriptorEmbeddingToolCandidateStrategy } from "./strategies/descriptor-embedding";
import { HostRuleToolCandidateStrategy } from "./strategies/host-rule";
import { NameMatchToolCandidateStrategy } from "./strategies/name-match";
import { createToolActivationProfile } from ".";
import type {
  ToolCandidateContribution,
  ToolCandidateStrategy,
} from "./types";

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

const makeRegistry = (tools: ToolDescriptor[]) => ({
  list: (kind: "tool") => (kind === "tool" ? tools : []),
});

const makeObservability = (): {
  emitter: DefaultObservabilityEmitter;
  turnObservability: { emit: (event: unknown) => void };
  events: EngineEvent[];
} => {
  const events: EngineEvent[] = [];
  const emitter = new DefaultObservabilityEmitter();
  emitter.on("*", (event) => {
    events.push(event);
  });
  return {
    emitter,
    turnObservability: {
      emit: (event: unknown) => emitter.emit(event as EngineEvent),
    },
    events,
  };
};

const makeTurnObservability = (): { emit: (event: unknown) => void } =>
  makeObservability().turnObservability;

const makeSemanticRetrieval = (
  scores: Record<string, number>,
): SemanticRetrievalFacade => ({
  retrieve: async (request): Promise<SemanticRetrievalResult> => ({
    caller: request.caller,
    namespace: request.namespace,
    strategy: "embedding_runtime",
    degraded: false,
    hits: (request.corpus ?? []).map((item) => ({
      id: item.id,
      score: scores[item.id] ?? 0,
    })),
  }),
});

const makeStrategy = (
  name: string,
  contributions: ToolCandidateContribution[],
): ToolCandidateStrategy => ({
  name,
  score: async () => contributions,
});

describe("createToolActivationProfile", () => {
  it("activates name-matched and embedding-recalled tools while omitting excluded tools and boosting promoted tools", async () => {
    const tools = [
      makeTool("read_file"),
      makeTool("semantic_search"),
      makeTool("shell_exec"),
      makeTool("quiet"),
    ];
    const profile = createToolActivationProfile({
      strategies: [
        new HostRuleToolCandidateStrategy({
          list: () => [{ match: "shell_exec", effect: "always-deny", reason: "sandbox" }],
        }),
        new NameMatchToolCandidateStrategy(),
        new DescriptorEmbeddingToolCandidateStrategy({ minScore: 0.5 }),
      ],
      semanticRetrieval: makeSemanticRetrieval({ semantic_search: 0.82 }),
    });

    const activation = createActivation({ profiles: { tool: profile } });
    const result = await activation.activate("tool", {
      query: "please read_file and shell_exec while searching project meaning",
      registry: makeRegistry(tools),
      observability: makeTurnObservability(),
      correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
      signal: new AbortController().signal,
    });

    expect(result.active.map((tool) => tool.name)).toContain("read_file");
    expect(result.active.map((tool) => tool.name)).toContain("semantic_search");
    expect(result.active.map((tool) => tool.name)).not.toContain("shell_exec");

    const readFileDecision = result.decisions.find((decision) => decision.name === "read_file");
    const semanticSearchDecision = result.decisions.find(
      (decision) => decision.name === "semantic_search",
    );
    const shellDecision = result.decisions.find((decision) => decision.name === "shell_exec");
    expect(readFileDecision?.active).toBe(true);
    expect(readFileDecision?.score).toBeGreaterThan(semanticSearchDecision?.score ?? 0);
    expect(shellDecision?.active).toBe(false);
  });

  it("caps non-promoted visible tools at topK", async () => {
    const tools = [makeTool("a"), makeTool("b"), makeTool("c"), makeTool("d")];
    const profile = createToolActivationProfile({
      topK: 2,
      strategies: [
        makeStrategy("scores", [
          { toolName: "a", score: 0.9, reason: "score" },
          { toolName: "b", score: 0.8, reason: "score" },
          { toolName: "c", score: 0.7, reason: "score" },
          { toolName: "d", score: 0.6, reason: "score" },
        ]),
      ],
    });

    const result = await createActivation({ profiles: { tool: profile } }).activate("tool", {
      query: "rank tools",
      registry: makeRegistry(tools),
      observability: makeTurnObservability(),
      correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
      signal: new AbortController().signal,
    });

    expect(result.active.map((tool) => tool.name)).toEqual(["a", "b"]);
  });

  it("falls back to the full visible set when no strategy hits", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const obs = makeObservability();
    const profile = createToolActivationProfile({
      strategies: [makeStrategy("empty", [])],
    });

    const result = await createActivation({ profiles: { tool: profile } }).activate("tool", {
      query: "nothing relevant",
      registry: makeRegistry(tools),
      observability: obs.turnObservability,
      correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
      signal: new AbortController().signal,
    });

    expect(result.active.map((tool) => tool.name)).toEqual(["search", "calc"]);
    const activationEvent = obs.events.find((event) => event.type === "tool_activation");
    expect(activationEvent?.payload.fullSetFallback).toBe(true);
    expect(activationEvent?.payload.fallbackUsed).toBe(false);
  });

  it("adds configured discovery siblings for promoted tools", async () => {
    const tools = [
      makeTool("query_database"),
      makeTool("search_ontology"),
      makeTool("list_databases"),
      makeTool("unrelated"),
    ];
    const profile = createToolActivationProfile({
      strategies: [
        makeStrategy("intent", [
          {
            toolName: "query_database",
            score: 1,
            reason: "include",
            promote: { reason: "include" },
          },
        ]),
      ],
      discoveryExpansion: {
        enabled: true,
        siblings: { query_database: ["search_ontology", "list_databases"] },
      },
    });

    const result = await createActivation({ profiles: { tool: profile } }).activate("tool", {
      query: "query data",
      registry: makeRegistry(tools),
      observability: makeTurnObservability(),
      correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
      signal: new AbortController().signal,
    });

    expect(result.active.map((tool) => tool.name)).toEqual([
      "query_database",
      "search_ontology",
      "list_databases",
    ]);
  });

  it("isolates a failing strategy without aborting activation", async () => {
    const tools = [makeTool("search"), makeTool("calc")];
    const obs = makeObservability();
    const profile = createToolActivationProfile({
      strategies: [
        {
          name: "broken",
          score: async () => {
            throw new Error("boom");
          },
        },
        makeStrategy("ok", [{ toolName: "search", score: 0.8, reason: "hit" }]),
      ],
    });

    const result = await createActivation({ profiles: { tool: profile } }).activate("tool", {
      query: "search",
      registry: makeRegistry(tools),
      observability: obs.turnObservability,
      correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "1" },
      signal: new AbortController().signal,
    });

    expect(result.active.map((tool) => tool.name)).toEqual(["search"]);
    const failures = obs.events.filter(
      (event) => event.type === "tool_activation_strategy_failed",
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures[0]?.payload.strategy).toBe("broken");
    expect(failures[0]?.payload.error).toBe("boom");
  });
});
