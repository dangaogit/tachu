import { describe, expect, test } from "bun:test";
import { PlanningError, RegistryError } from "../errors";
import { InMemoryVectorStore } from "../vector";
import { DescriptorRegistry } from "./registry";

describe("DescriptorRegistry", () => {
  test("register/get/list/query/unregister complete lifecycle", async () => {
    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry(vectorStore);
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "read file",
      tags: ["fs", "io"],
      trigger: { type: "always" },
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });
    await registry.register({
      kind: "rule",
      name: "safe-output",
      description: "ensure safe output",
      type: "rule",
      scope: ["output"],
      content: "never output secrets",
      tags: ["security"],
      trigger: { type: "keyword", keywords: ["secret"] },
    });

    expect(registry.get("tool", "read-file")?.name).toBe("read-file");
    expect(registry.list("rule")).toHaveLength(1);
    expect(registry.list().length).toBe(2);
    expect(registry.query({ tags: ["security"] })).toHaveLength(1);
    expect(registry.query({ trigger: "always" })).toHaveLength(1);

    await registry.unregister("tool", "read-file");
    expect(registry.get("tool", "read-file")).toBeNull();
    expect(vectorStore.size()).toBe(1);
  });

  test("rejects duplicate names", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "rule",
      name: "r1",
      description: "rule 1",
      type: "rule",
      scope: ["*"],
      content: "rule",
    });
    await expect(
      registry.register({
        kind: "rule",
        name: "r1",
        description: "rule 1 duplicate",
        type: "rule",
        scope: ["*"],
        content: "rule",
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  test("validates missing dependency and dependency cycle", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "plan",
      description: "plan skill",
      instructions: "do plan",
      requires: [{ kind: "tool", name: "missing-tool" }],
    });
    expect(() => registry.validateDependencies()).toThrow(RegistryError);

    await registry.clear();
    await registry.register({
      kind: "skill",
      name: "a",
      description: "a",
      instructions: "a",
      requires: [{ kind: "skill", name: "b" }],
    });
    await registry.register({
      kind: "skill",
      name: "b",
      description: "b",
      instructions: "b",
      requires: [{ kind: "skill", name: "a" }],
    });
    try {
      registry.validateDependencies();
      throw new Error("expected cycle validation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanningError);
      expect((error as PlanningError).code).toBe("PLANNING_GRAPH_CYCLE");
    }
  });
});

