import { describe, expect, it } from "bun:test";
import { QdrantVectorStore } from "../../src/vector/qdrant";

describe("QdrantVectorStore", () => {
  it("embeds text and upserts with ensureCollection", async () => {
    const store = new QdrantVectorStore({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 8,
    });
    let createCollectionCalled = 0;
    let upsertCalled = 0;
    (store as { client: unknown; ensured: boolean }).client = {
      collectionExists: async () => ({ exists: false }),
      createCollection: async () => {
        createCollectionCalled += 1;
      },
      upsert: async (_collection: string, payload: { points: unknown[] }) => {
        expect(payload.points.length).toBe(1);
        upsertCalled += 1;
      },
      search: async () => [],
      delete: async () => undefined,
      deleteCollection: async () => undefined,
      count: async () => ({ count: 1 }),
    };
    (store as { ensured: boolean }).ensured = false;

    const vectors = await store.embed(["hello world"]);
    expect(vectors[0]?.length).toBe(8);
    await store.upsert("doc-1", "hello world", { source: "test" });
    expect(createCollectionCalled).toBe(1);
    expect(upsertCalled).toBe(1);
    expect(await store.size()).toBe(1);
  });

  it("searches and maps qdrant response", async () => {
    const store = new QdrantVectorStore({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 8,
    });
    (store as { client: unknown; ensured: boolean }).client = {
      collectionExists: async () => ({ exists: true }),
      createCollection: async () => undefined,
      upsert: async () => undefined,
      search: async () => [
        { id: 1, score: 0.9, payload: { tag: "a" } },
        { id: "2", score: 0.5, payload: null },
      ],
      delete: async () => undefined,
      deleteCollection: async () => undefined,
    };
    (store as { ensured: boolean }).ensured = false;

    const result = await store.search("hello", 2);
    expect(result).toEqual([
      { id: "1", score: 0.9, metadata: { tag: "a" } },
      { id: "2", score: 0.5, metadata: {} },
    ]);
  });

  it("deletes entries and keeps size non-negative", async () => {
    const store = new QdrantVectorStore({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 8,
    });
    (store as { client: unknown; ensured: boolean }).client = {
      collectionExists: async () => ({ exists: true }),
      createCollection: async () => undefined,
      upsert: async () => undefined,
      search: async () => [],
      delete: async () => undefined,
      deleteCollection: async () => undefined,
      count: async () => ({ count: 0 }),
    };
    (store as { ensured: boolean }).ensured = true;
    (store as { entryCount: number }).entryCount = 1;

    await store.delete("doc-1");
    expect(await store.size()).toBe(0);
    await store.delete("doc-1");
    expect(await store.size()).toBe(0);
  });

  it("clears collection then recreates", async () => {
    const store = new QdrantVectorStore({
      url: "http://example.com",
      collectionName: "test",
      vectorSize: 8,
    });
    let existsCalls = 0;
    let deleted = 0;
    let created = 0;
    (store as { client: unknown; ensured: boolean; entryCount: number }).client = {
      collectionExists: async () => {
        existsCalls += 1;
        return existsCalls === 1 ? { exists: true } : { exists: false };
      },
      createCollection: async () => {
        created += 1;
      },
      upsert: async () => undefined,
      search: async () => [],
      delete: async () => undefined,
      deleteCollection: async () => {
        deleted += 1;
      },
      count: async () => ({ count: 0 }),
    };
    (store as { ensured: boolean }).ensured = true;
    (store as { entryCount: number }).entryCount = 3;

    await store.clear();
    expect(deleted).toBe(1);
    expect(created).toBe(1);
    expect(await store.size()).toBe(0);
  });

  it("maps qdrant errors for all mutating/query operations", async () => {
    const createStore = (method: "upsert" | "search" | "delete" | "clear"): QdrantVectorStore => {
      const store = new QdrantVectorStore({
        url: "http://example.com",
        collectionName: "test",
        vectorSize: 8,
      });
      (store as { client: unknown; ensured: boolean }).client = {
        collectionExists: async () => {
          if (method === "clear") {
            throw new Error("boom");
          }
          return { exists: true };
        },
        createCollection: async () => undefined,
        upsert: async () => {
          if (method === "upsert") {
            throw new Error("boom");
          }
        },
        search: async () => {
          if (method === "search") {
            throw new Error("boom");
          }
          return [];
        },
        delete: async () => {
          if (method === "delete") {
            throw new Error("boom");
          }
        },
        deleteCollection: async () => undefined,
      };
      (store as { ensured: boolean }).ensured = true;
      return store;
    };

    await expect(createStore("upsert").upsert("id", [0, 1], {})).rejects.toMatchObject({
      code: "PROVIDER_UPSTREAM_ERROR",
      retryable: true,
    });
    await expect(createStore("search").search([0, 1], 1)).rejects.toMatchObject({
      code: "PROVIDER_UPSTREAM_ERROR",
      retryable: true,
    });
    await expect(createStore("delete").delete("id")).rejects.toMatchObject({
      code: "PROVIDER_UPSTREAM_ERROR",
      retryable: true,
    });
    await expect(createStore("clear").clear()).rejects.toMatchObject({
      code: "PROVIDER_UPSTREAM_ERROR",
      retryable: true,
    });
  });
});
