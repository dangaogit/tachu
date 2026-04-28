import { describe, expect, test } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import { InMemoryVectorStore } from "./in-memory-store";

describe("InMemoryVectorStore", () => {
  test("upsert and search topK", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert("1", "hello world", { tag: "a" });
    await store.upsert("2", "another text", { tag: "b" });
    const results = await store.search({ query: "hello", topK: 1 }, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("1");
  });

  test("enforces index limit and exposes warning callback", async () => {
    const warnings: string[] = [];
    const store = new InMemoryVectorStore({ indexLimit: 1, onWarning: (msg) => warnings.push(msg) });
    await store.upsert("1", "first", {});
    await store.upsert("2", "second", {});
    expect(store.size()).toBe(1);
    expect(warnings[0]).toContain("达到上限");
  });

  test("supports embed/delete/clear", async () => {
    const store = new InMemoryVectorStore();
    const embedded = await store.embed(["alpha beta", "beta gamma"]);
    expect(embedded.length).toBe(2);
    await store.upsert("x", embedded[0]!, { source: "vec" });
    expect(store.size()).toBe(1);
    await store.delete("x");
    expect(store.size()).toBe(0);
    await store.upsert("y", "text", {});
    await store.clear();
    expect(store.size()).toBe(0);
  });
});

