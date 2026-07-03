import { describe, expect, test } from "bun:test";
import { DefaultObservabilityEmitter } from "../modules/observability";
import { InMemorySessionManager } from "../modules/session";
import { DescriptorRegistry } from "../registry";
import { createDefaultEngineConfig } from "../utils";
import { InMemoryVectorStore } from "../vector";
import { buildRecallQuery, resolveSkillsForRun } from "./skill-recall-legacy";

describe("skill-recall-legacy", () => {
 test("buildRecallQuery joins recent user turns and current input", () => {
    const query = buildRecallQuery(
      { content: "current question", metadata: { modality: "text", size: 10 } },
      {
        entries: [
          { id: "e1", role: "user", content: "first", timestamp: 1, anchored: false },
          { id: "e2", role: "assistant", content: "ok", timestamp: 2, anchored: false },
          { id: "e3", role: "user", content: "second", timestamp: 3, anchored: false },
          { id: "e4", role: "user", content: "third", timestamp: 4, anchored: false },
        ],
        tokenCount: 0,
        limit: 1000,
      },
      2,
    );
    expect(query).toContain("second");
    expect(query).toContain("third");
    expect(query).toContain("current question");
    expect(query).not.toContain("first");
  });

 test("resolveSkillsForRun fails closed after decision 8", async () => {
    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry(vectorStore);
    const sessions = new InMemorySessionManager();
    const config = createDefaultEngineConfig();
    config.runtime.skillActivationMode = "legacy";
    config.runtime.activationThreshold = 0.5;
    config.runtime.recallTopN = 5;

    await registry.register({
      kind: "skill",
      name: "high-match",
      description: "typescript programming guide",
      instructions: "use strict types",
      activation: { mode: "semantic" },
    });
    await registry.register({
      kind: "skill",
      name: "low-match",
      description: "cooking recipes",
      instructions: "bake bread",
      activation: { mode: "semantic" },
    });
    await registry.register({
      kind: "skill",
      name: "always-skill",
      description: "global style",
      instructions: "be concise",
      activation: { mode: "always" },
    });

    await sessions.resolve("s1");
    await expect(
      resolveSkillsForRun({
        config,
        registry,
        vectorStore,
        sessionManager: sessions,
        sessionId: "s1",
        currentInput: {
          content: "help me with typescript types",
          metadata: { modality: "text", size: 20 },
        },
        contextWindow: { entries: [], tokenCount: 0, limit: 1000 },
        adapterContext: {
          correlation: {
            traceId: "t1",
            requestId: "r1",
            sessionId: "s1",
            turnId: "turn-r1",
          },
        },
        observability: new DefaultObservabilityEmitter(),
      }),
    ).rejects.toThrow(/legacy.*retired/);
  });
});
