import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { LocalFsVectorStore } from "../../src/vector/local-fs";
import { cleanupTempDir, createTempDir } from "../helpers";

describe("LocalFsVectorStore", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("upserts and searches vectors", async () => {
    const store = new LocalFsVectorStore({ filePath: `${root}/vectors.json` });
    await store.upsert("1", "hello world", { source: "a" });
    const result = await store.search("hello", 1);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe("1");
  });

  it("persists entries to disk", async () => {
    const path = `${root}/vectors.json`;
    const store = new LocalFsVectorStore({ filePath: path, persistDebounceMs: 10 });
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
    const store = new LocalFsVectorStore({ filePath: path });
    await store.embed(["warmup"]);
    expect(store.size()).toBe(1);
    const result = await store.search([1, 0, 0], 1);
    expect(result[0]?.id).toBe("seed");
  });

  it("supports snapshot, delete and clear", async () => {
    const path = `${root}/vectors.json`;
    const store = new LocalFsVectorStore({ filePath: path, persistDebounceMs: 10 });
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
    const store = new LocalFsVectorStore({ filePath: path });
    await expect(store.embed(["x"])).rejects.toBeDefined();
  });
});
