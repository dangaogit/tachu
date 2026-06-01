import { describe, expect, it } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import { QdrantVectorIndexAdapter } from "../../src/vector/qdrant";

const qdrantUrl = process.env.QDRANT_URL;

describe("QdrantVectorIndexAdapter integration", () => {
  const run = qdrantUrl ? it : it.skip;

  run("upserts precomputed vectors and queries against live qdrant", async () => {
    const collectionName = `tachu_ext_test_${Date.now()}`;
    const adapter = new QdrantVectorIndexAdapter({
      url: qdrantUrl as string,
      apiKey: process.env.QDRANT_API_KEY,
      collectionName,
      vectorSize: 4,
    });
    await adapter.upsert(
      [{ id: "1", vector: [1, 0, 0, 0], payload: { source: "integration" } }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const result = await adapter.searchVector([1, 0, 0, 0], 1, {}, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(result.length).toBeGreaterThan(0);
    await adapter.delete(["1"], DEFAULT_ADAPTER_CALL_CONTEXT);
  });
});
