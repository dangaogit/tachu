import { describe, expect, it } from "bun:test";
import { QdrantVectorStore } from "../../src/vector/qdrant";

const qdrantUrl = process.env.QDRANT_URL;

describe("QdrantVectorStore integration", () => {
  const run = qdrantUrl ? it : it.skip;

  run("upserts and queries against live qdrant", async () => {
    const collectionName = `tachu_ext_test_${Date.now()}`;
    const store = new QdrantVectorStore({
      url: qdrantUrl as string,
      apiKey: process.env.QDRANT_API_KEY,
      collectionName,
    });
    await store.upsert("1", "hello qdrant", { source: "integration" });
    const result = await store.search("hello", 1);
    expect(result.length).toBeGreaterThan(0);
    await store.clear();
  });
});
