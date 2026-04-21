import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DescriptorRegistry, InMemoryVectorStore, RegistryLoader } from "../../src";

describe("registry lifecycle integration", () => {
  test("loads, queries, reloads and clears descriptors", async () => {
    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry(vectorStore);
    const loader = new RegistryLoader(registry);
    const fixtureDir = join(import.meta.dir, "../fixtures/descriptors");

    const loaded = await loader.loadFromDirectory(fixtureDir);
    expect(loaded.length).toBeGreaterThanOrEqual(4);

    await registry.register({
      kind: "rule",
      name: "runtime-rule",
      description: "runtime added rule",
      type: "preference",
      scope: ["*"],
      content: "请保持输出简洁",
    });

    const queried = registry.query({ tags: ["dev"] });
    expect(queried.length).toBeGreaterThan(0);

    await loader.reload(fixtureDir);
    expect(registry.get("tool", "echo-tool")).not.toBeNull();

    await registry.clear();
    expect(registry.list().length).toBe(0);
    expect(vectorStore.size()).toBe(0);
  });
});

