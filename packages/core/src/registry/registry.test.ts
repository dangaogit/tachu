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
      version: "1.0.0",
      tags: ["fs", "io"],
      activation: { mode: "always" },
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
      version: "1.0.0",
      type: "rule",
      activation: { mode: "manual" },
      content: "never output secrets",
      tags: ["security"],
    });

    expect(registry.get("tool", "read-file")?.name).toBe("read-file");
    expect(registry.get("tool", "read-file", "1.0.0")?.name).toBe("read-file");
 expect(registry.getLatest("tool", "read-file")?.name).toBe("read-file");
    expect(registry.listVersions("tool", "read-file")).toEqual(["1.0.0"]);
    expect(registry.list("rule")).toHaveLength(1);
    expect(registry.list().length).toBe(2);
    expect(registry.query({ tags: ["security"] })).toHaveLength(1);
    expect(registry.query({ activation: "always" })).toHaveLength(1);

    await registry.unregister("tool", "read-file");
    expect(registry.get("tool", "read-file")).toBeNull();
    expect(vectorStore.size()).toBe(0);
  });

 test("does not invoke legacy vectorStore side effects during registration", async () => {
    const vectorStore = {
      async upsert() {
        throw new Error("legacy registry indexing must not run");
      },
      async search() {
        return [];
      },
      async hybridSearch() {
        return [];
      },
      async delete() {},
      async clear() {},
      size() {
        return 0;
      },
    } satisfies import("../vector").VectorStore;
    const registry = new DescriptorRegistry(vectorStore);

    await registry.register({
      kind: "tool",
      name: "lookup",
      description: "lookup external docs",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "lookup",
    });

    expect(registry.get("tool", "lookup")?.name).toBe("lookup");
  });

 test("rejects duplicate version under same name", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "rule",
      name: "r1",
      description: "rule 1",
      version: "1.0.0",
      type: "rule",
      activation: { mode: "always" },
      content: "rule",
    });
    await expect(
      registry.register({
        kind: "rule",
        name: "r1",
        description: "rule 1 duplicate",
        version: "1.0.0",
        type: "rule",
        activation: { mode: "always" },
        content: "rule",
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

 test("allows same name with multiple versions and resolves latest", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "legacy",
      version: "1.2.3-beta.1",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "stable",
      version: "1.2.2",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "latest stable",
      version: "1.3.0",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });

    expect(registry.get("tool", "read-file")?.description).toBe("latest stable");
    expect(registry.get("tool", "read-file", "1.2.3-beta.1")?.description).toBe("legacy");
    expect(registry.list("tool")).toHaveLength(1);
    expect(registry.listVersions("tool", "read-file")).toEqual(["1.3.0", "1.2.3-beta.1", "1.2.2"]);
  });

 test("falls back to prerelease latest when stable versions absent", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "planner",
      description: "beta one",
      version: "2.0.0-beta.1",
      instructions: "plan",
      activation: { mode: "semantic" },
    });
    await registry.register({
      kind: "skill",
      name: "planner",
      description: "beta two",
      version: "2.0.0-beta.2",
      instructions: "plan",
      activation: { mode: "semantic" },
    });

    expect(registry.get("skill", "planner")?.description).toBe("beta two");
  });

 test("treats descriptors without version as 0.0.0", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "agent",
      name: "review-agent",
      description: "no version",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      maxDepth: 1,
      instructions: "review",
    });
    expect(registry.get("agent", "review-agent", "0.0.0")?.description).toBe("no version");
    expect(registry.listVersions("agent", "review-agent")).toEqual(["0.0.0"]);
  });

 test("rejects invalid semver version", async () => {
    const registry = new DescriptorRegistry();
    await expect(
      registry.register({
        kind: "rule",
        name: "invalid-version",
        description: "bad",
        version: "latest",
        type: "rule",
        activation: { mode: "always" },
        content: "rule",
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

 test("requires deprecatedMessage when deprecated=true", async () => {
    const registry = new DescriptorRegistry();
    await expect(
      registry.register({
        kind: "rule",
        name: "legacy",
        description: "legacy",
        deprecated: true,
        type: "rule",
        activation: { mode: "always" },
        content: "legacy rule",
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

 test("preserves unknown descriptor fields in register/get flow", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "x-skill",
      description: "with vendor fields",
      instructions: "run",
      "x-acme": {
        owner: "acme",
      },
      "x-vendor-priority": 7,
    } as never);

    const descriptor = registry.get("skill", "x-skill") as unknown as Record<string, unknown>;
    expect(descriptor["x-vendor-priority"]).toBe(7);
    expect((descriptor["x-acme"] as { owner: string }).owner).toBe("acme");
  });

 test("unregister accepts explicit version", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "v1",
      version: "1.0.0",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });
    await registry.register({
      kind: "tool",
      name: "read-file",
      description: "v2",
      version: "2.0.0",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: { type: "object" },
      execute: "readFile",
    });

    await registry.unregister("tool", "read-file", "2.0.0");
    expect(registry.get("tool", "read-file")?.description).toBe("v1");
  });

 test("validates missing dependency and dependency cycle", async () => {
    const registry = new DescriptorRegistry();
    await registry.register({
      kind: "skill",
      name: "plan",
      description: "plan skill",
      instructions: "do plan",
      activation: { mode: "semantic" },
      requires: [{ kind: "tool", name: "missing-tool" }],
    });
    expect(() => registry.validateDependencies()).toThrow(RegistryError);

    await registry.clear();
    await registry.register({
      kind: "skill",
      name: "a",
      description: "a",
      instructions: "a",
      activation: { mode: "semantic" },
      requires: [{ kind: "skill", name: "b" }],
    });
    await registry.register({
      kind: "skill",
      name: "b",
      description: "b",
      instructions: "b",
      activation: { mode: "semantic" },
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
