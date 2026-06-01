import { describe, expect, it } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT, ProviderError } from "@tachu/core";
import { QdrantVectorIndexAdapter } from "../../src/vector/qdrant";

describe("QdrantVectorIndexAdapter ()", () => {
  it("upserts VectorPoint[] and searches with numeric query vector", async () => {
    const adapter = new QdrantVectorIndexAdapter({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 4,
    });
    let upsertPayload: unknown;
    (adapter as unknown as { client: unknown; ensured: boolean }).client = {
      collectionExists: async () => ({ exists: false }),
      createCollection: async () => undefined,
      upsert: async (_collection: string, payload: unknown) => {
        upsertPayload = payload;
      },
      search: async () => [{ id: "doc-1", score: 0.9, payload: { ref: "r1" } }],
      delete: async () => undefined,
    };
    (adapter as unknown as { ensured: boolean }).ensured = false;

    await adapter.upsert(
      [{ id: "doc-1", vector: [1, 0, 0, 0], payload: { ref: "r1" } }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(upsertPayload).toBeDefined();

    const hits = await adapter.searchVector([1, 0, 0, 0], 2, {}, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(hits[0]?.id).toBe("doc-1");
  });

  it("rejects wrong vector dimension on upsert", async () => {
    const adapter = new QdrantVectorIndexAdapter({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 4,
    });
    await expect(
      adapter.upsert(
        [{ id: "bad", vector: [1, 0], payload: {} }],
        DEFAULT_ADAPTER_CALL_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects non-numeric searchVector query at runtime", async () => {
    const adapter = new QdrantVectorIndexAdapter({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 4,
    });
    await expect(
      adapter.searchVector(["not-a-vector"] as unknown as number[], 1, {}, DEFAULT_ADAPTER_CALL_CONTEXT),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
