import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_ADAPTER_CALL_CONTEXT, ProviderError } from "@tachu/core";
import { LocalFsVectorIndexAdapter } from "../../src/vector/local-fs-index";
import { LegacyLocalFsVectorStore } from "../fixtures/legacy-local-fs-vector-store";
import { cleanupTempDir, createTempDir } from "../helpers";

/**
 * / — Pure-vector LocalFs adapter contract.
 *
 * `LocalFsVectorIndexAdapter` is the production replacement for the legacy
 * `LocalFsVectorStore`. It MUST NOT accept text inputs: production projection
 * pipelines must embed via `EmbeddingRuntime` before reaching the index.
 */
describe("LocalFsVectorIndexAdapter (pure-vector path)", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("upserts precomputed vector points and round-trips via searchVector", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
      persistDebounceMs: 10,
    });
    await adapter.upsert(
      [
        { id: "a", vector: [1, 0, 0], payload: { source: "alpha" } },
        { id: "b", vector: [0, 1, 0], payload: { source: "beta" } },
      ],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const hits = await adapter.searchVector(
      [1, 0, 0],
      1,
      {},
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.metadata?.source).toBe("alpha");
  });

  it("rejects string upserts (no text-to-vector shortcut)", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
    });
    await expect(
      adapter.upsert(
 // Forcibly cast to bypass the static type guard — this mimics a buggy
 // production host that tries the pre- string-embed shortcut.
        [{ id: "x", vector: "hello world" as unknown as number[], payload: {} }],
        DEFAULT_ADAPTER_CALL_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects non-numeric search vectors", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
    });
    await adapter.upsert(
      [{ id: "a", vector: [1, 0, 0], payload: {} }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await expect(
      adapter.searchVector(
        "find me" as unknown as number[],
        1,
        {},
        DEFAULT_ADAPTER_CALL_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("persists upserts to disk and reloads on construction", async () => {
    const filePath = `${root}/vector-index.json`;
    const adapter = new LocalFsVectorIndexAdapter({ filePath, persistDebounceMs: 10 });
    await adapter.upsert(
      [{ id: "seed", vector: [0.1, 0.2, 0.3], payload: { from: "disk" } }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await adapter.flush();
    const raw = await readFile(filePath, "utf8");
    expect(raw.includes("\"seed\"")).toBe(true);

    const restored = new LocalFsVectorIndexAdapter({ filePath });
    const hits = await restored.searchVector(
      [0.1, 0.2, 0.3],
      1,
      {},
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(hits[0]?.id).toBe("seed");
    expect(hits[0]?.metadata?.from).toBe("disk");
  });

  it("delete removes points and search returns nothing", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
      persistDebounceMs: 10,
    });
    await adapter.upsert(
      [{ id: "a", vector: [1, 0, 0], payload: {} }],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await adapter.delete(["a"], DEFAULT_ADAPTER_CALL_CONTEXT);
    const hits = await adapter.searchVector(
      [1, 0, 0],
      1,
      {},
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(hits).toEqual([]);
  });

  it("payload filter is honoured by searchVector", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
    });
    await adapter.upsert(
      [
        { id: "a", vector: [1, 0, 0], payload: { tenant: "t1" } },
        { id: "b", vector: [1, 0, 0], payload: { tenant: "t2" } },
      ],
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const hits = await adapter.searchVector(
      [1, 0, 0],
      5,
      { must: { tenant: "t2" } },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("b");
  });

  it("ignores aborted upsert / search", async () => {
    const adapter = new LocalFsVectorIndexAdapter({
      filePath: `${root}/vector-index.json`,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      adapter.upsert(
        [{ id: "a", vector: [1, 0, 0], payload: {} }],
        DEFAULT_ADAPTER_CALL_CONTEXT,
        ctrl.signal,
      ),
    ).rejects.toBeDefined();
    await expect(
      adapter.searchVector([1, 0, 0], 1, {}, DEFAULT_ADAPTER_CALL_CONTEXT, ctrl.signal),
    ).rejects.toBeDefined();
  });
});

/**
 * the legacy {@link LegacyLocalFsVectorStore} now lives under
 * `__tests__/fixtures/` and is no longer exported from `@tachu/extensions`.
 * These tests pin the historical behaviour for the deprecated `VectorStore`
 * interface so the durability contract stays honest, but the fixture itself
 * is never wired into production hosts (CLI, host-defaults).
 */
describe("LegacyLocalFsVectorStore (deprecated fixture, quarantined)", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("upserts and searches via the legacy text-embed shortcut", async () => {
    const store = new LegacyLocalFsVectorStore({ filePath: `${root}/vectors.json` });
    await store.upsert("1", "hello world", { source: "a" });
    const result = await store.search({ query: "hello", topK: 1 }, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe("1");
  });

  it("persists entries to disk", async () => {
    const path = `${root}/vectors.json`;
    const store = new LegacyLocalFsVectorStore({ filePath: path, persistDebounceMs: 10 });
    await store.upsert("1", "persist me", { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const content = await readFile(path, "utf8");
    expect(content.includes("\"id\":\"1\"")).toBe(true);
  });

  it("loads existing persisted entries on startup", async () => {
    const path = `${root}/vectors.json`;
    await writeFile(
      path,
      JSON.stringify({
        entries: [{ id: "seed", vector: [1, 0, 0], metadata: { from: "disk" } }],
      }),
      "utf8",
    );
    const store = new LegacyLocalFsVectorStore({ filePath: path });
    await store.embed(["warmup"]);
    expect(store.size()).toBe(1);
    const result = await store.search({ query: [1, 0, 0], topK: 1 }, DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(result[0]?.id).toBe("seed");
  });

  it("supports snapshot, delete and clear", async () => {
    const path = `${root}/vectors.json`;
    const store = new LegacyLocalFsVectorStore({ filePath: path, persistDebounceMs: 10 });
    await store.upsert("1", "alpha", { tag: "a" });
    await store.upsert("2", "beta", { tag: "b" });
    await store.delete("1");
    expect(store.size()).toBe(1);

    const snapshotPath = `${root}/snapshot/vectors.json`;
    await store.snapshot(snapshotPath);
    const snapshot = await readFile(snapshotPath, "utf8");
    expect(snapshot.includes("\"id\": \"2\"")).toBe(true);

    await store.clear();
    expect(store.size()).toBe(0);
  });

  it("fails when persisted file is invalid json", async () => {
    const path = `${root}/vectors.json`;
    await writeFile(path, "{bad-json", "utf8");
    const store = new LegacyLocalFsVectorStore({ filePath: path });
    await expect(store.embed(["x"])).rejects.toBeDefined();
  });
});
