import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { readFileExecutor } from "../../src/tools/read-file/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("read-file executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await writeFile(`${root}/a.txt`, "hello");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("reads file content", async () => {
    const result = await readFileExecutor({ path: "a.txt" }, createToolContext(root));
    expect(result.content).toBe("hello");
    expect(result.bytes).toBe(5);
  });

  it("rejects path escape", async () => {
    await expect(
      readFileExecutor({ path: "../outside.txt" }, createToolContext(root)),
    ).rejects.toMatchObject({ code: "VALIDATION_PATH_ESCAPE" });
  });
});
