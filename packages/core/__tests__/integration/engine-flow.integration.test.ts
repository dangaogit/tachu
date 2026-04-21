import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DefaultObservabilityEmitter,
  DescriptorRegistry,
  Engine,
  InMemorySessionManager,
  InMemoryVectorStore,
  RegistryLoader,
  type EngineConfig,
  type EngineEvent,
} from "../../src";

const createConfig = (): EngineConfig => ({
  registry: {
    descriptorPaths: [],
    enableVectorIndexing: true,
  },
  runtime: {
    planMode: false,
    maxConcurrency: 4,
    defaultTaskTimeoutMs: 10_000,
    failFast: false,
  },
  memory: {
    contextTokenLimit: 4_000,
    compressionThreshold: 0.8,
    headKeep: 4,
    tailKeep: 4,
    archivePath: ".tachu/archive/core-test-memory.jsonl",
    vectorIndexLimit: 10_000,
  },
  budget: {
    maxTokens: 40_000,
    maxToolCalls: 20,
    maxWallTimeMs: 120_000,
  },
  safety: {
    maxInputSizeBytes: 1024 * 1024,
    maxRecursionDepth: 10,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: ["ignore previous instructions"],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "noop", model: "dev-medium" },
      planning: { provider: "noop", model: "dev-large" },
      "fast-cheap": { provider: "noop", model: "dev-small" },
      "high-reasoning": { provider: "noop", model: "dev-large" },
      validation: { provider: "noop", model: "dev-medium" },
    },
    providerFallbackOrder: ["noop"],
  },
  observability: {
    enabled: true,
    maskSensitiveData: true,
  },
  hooks: {
    writeHookTimeout: 2_000,
    failureBehavior: "continue",
  },
});

describe("engine flow integration", () => {
  test("runs full flow and returns output", async () => {
    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry(vectorStore);
    const loader = new RegistryLoader(registry);
    const fixtureDir = join(import.meta.dir, "../fixtures/descriptors");
    await loader.loadFromDirectory(fixtureDir);

    const events: EngineEvent[] = [];
    const observability = new DefaultObservabilityEmitter();
    observability.on("*", (event) => {
      events.push(event);
    });

    const sessions = new InMemorySessionManager();
    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      observability,
      sessionManager: sessions,
    });

    const streamChunks: string[] = [];
    for await (const chunk of engine.runStream(
      {
        content: "请先分析需求，然后给我一个执行步骤",
        metadata: { modality: "text", size: 64 },
      },
      {
        requestId: "req-1",
        sessionId: "session-1",
        traceId: "trace-1",
        principal: { role: "tester" },
        budget: { maxTokens: 5_000, maxDurationMs: 10_000 },
        scopes: ["*"],
      },
    )) {
      if (chunk.type === "progress") {
        streamChunks.push(chunk.phase);
      }
      if (chunk.type === "error") {
        throw chunk.error;
      }
      if (chunk.type === "done") {
        expect(chunk.output.status === "success" || chunk.output.status === "partial").toBe(true);
        expect(chunk.output.steps.length).toBeGreaterThan(0);
      }
    }

    expect(streamChunks.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "phase_enter")).toBe(true);
    expect(events.some((event) => event.type === "phase_exit")).toBe(true);
    expect(sessions.listSessions().length).toBe(1);

    await engine.dispose();
  });
});

