import { describe, expect, test } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import { InMemoryVectorStore } from "./in-memory-store";

describe("InMemoryVectorStore", () => {
 test("upsert and search topK", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("1", [1, 0], { tag: "a" });
    await store.upsert("2", [0, 1], { tag: "b" });
    const results = await store.search({ query: [1, 0], topK: 1 }, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("1");
  });

 test("enforces index limit and exposes warning callback", async () => {
    const warnings: string[] = [];
    const store = new InMemoryVectorStore({ indexLimit: 1, onWarning: (msg) => warnings.push(msg) });
    await store.upsert("1", [1], {});
    await store.upsert("2", [2], {});
    expect(store.size()).toBe(1);
    expect(warnings[0]).toContain("达到上限");
  });

 test("supports delete/clear", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("x", [1, 0], { source: "vec" });
    expect(store.size()).toBe(1);
    await store.delete("x");
    expect(store.size()).toBe(0);
    await store.upsert("y", [0, 1], {});
    await store.clear();
    expect(store.size()).toBe(0);
  });

 test("rejects raw text inputs at runtime", async () => {
    const store = new InMemoryVectorStore();
    await expect(
      store.upsert("raw", "hello world" as never, {}),
    ).rejects.toThrow(/numeric vector/);
    await expect(
      store.search({ query: "hello" as never, topK: 1 }, DEFAULT_ADAPTER_CALL_CONTEXT),
    ).rejects.toThrow(/numeric query vector/);
  });
});
