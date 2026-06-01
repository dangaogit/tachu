import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { listDirExecutor } from "../../src/tools/list-dir/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("list-dir executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await mkdir(`${root}/sub`, { recursive: true });
    await writeFile(`${root}/sub/a.ts`, "export const a = 1;");
    await writeFile(`${root}/b.ts`, "export const b = 2;");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("lists recursively", async () => {
    const result = await listDirExecutor(
      { path: ".", recursive: true },
      createToolContext(root),
    );
    expect(result.entries.some((entry) => entry.name.endsWith("a.ts"))).toBe(true);
    expect(result.entries.some((entry) => entry.type === "directory")).toBe(true);
  });

  it("truncates with maxEntries", async () => {
    const result = await listDirExecutor(
      { path: ".", recursive: true, maxEntries: 1 },
      createToolContext(root),
    );
    expect(result.entries.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
