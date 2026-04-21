import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { InMemoryVectorStore } from "../src";

test("vector store benchmark 10k upsert + 1k search", async () => {
  const store = new InMemoryVectorStore({ indexLimit: 20_000 });
  const entries = 10_000;
  for (let i = 0; i < entries; i += 1) {
    await store.upsert(`id-${i}`, `vector text sample ${i % 100}`, { index: i });
  }

  const started = performance.now();
  const loops = 1_000;
  let total = 0;
  for (let i = 0; i < loops; i += 1) {
    const found = await store.search("sample 42", 10);
    total += found.length;
  }
  const elapsed = performance.now() - started;
  const qps = loops / (elapsed / 1000);
  console.log(`vector-store.bench: ${qps.toFixed(2)} qps`);
  expect(total).toBe(10_000);
});

