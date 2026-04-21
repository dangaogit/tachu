import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { searchCodeExecutor } from "../../src/tools/search-code/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("search-code executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await writeFile(`${root}/main.ts`, "const value = 42;\nconsole.log(value);\n");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("finds pattern matches", async () => {
    const result = await searchCodeExecutor(
      { pattern: "value", path: "." },
      createToolContext(root),
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.file.endsWith("main.ts")).toBe(true);
  });

  it("marks result truncated when maxResults reached", async () => {
    await writeFile(`${root}/many.ts`, "value-1\nvalue-2\nvalue-3\n");
    const result = await searchCodeExecutor(
      { pattern: "value", path: ".", maxResults: 1 },
      createToolContext(root),
    );
    expect(result.matches.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("falls back to JS walker when rg unavailable", async () => {
    await writeFile(`${root}/nested.ts`, "const fallback = true;\n");
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("rg not found");
    }) as typeof Bun.spawn;
    try {
      const result = await searchCodeExecutor(
        { pattern: "fallback", path: ".", fileGlob: "*.ts" },
        createToolContext(root),
      );
      expect(result.matches.some((item) => item.file.endsWith("nested.ts"))).toBe(true);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});
