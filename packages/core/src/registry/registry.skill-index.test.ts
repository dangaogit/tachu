import { describe, expect, test } from "bun:test";
import { InMemoryVectorStore } from "../vector";
import { DescriptorRegistry } from "./registry";

describe("DescriptorRegistry vector indexing", () => {
 test("does not index descriptors after decision 8", async () => {
    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry(vectorStore);

    await registry.register({
      kind: "skill",
      name: "normal",
      description: "normal skill",
      instructions: "do work",
      trigger: { type: "semantic" },
    });
    await registry.register({
      kind: "tool",
      name: "lookup",
      description: "lookup tool",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "lookup",
    });

    expect(await Promise.resolve(vectorStore.size())).toBe(0);
  });
});
