import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { applyPatchExecutor } from "../../src/tools/apply-patch/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("apply-patch executor", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await writeFile(`${root}/a.txt`, "hello\nworld\n");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("applies unified diff", async () => {
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 hello
-world
+tachu`;
    const result = await applyPatchExecutor({ patch }, createToolContext(root));
    expect(result.success).toBe(true);
    expect(await readFile(`${root}/a.txt`, "utf8")).toContain("tachu");
  });

  it("returns failed on conflict", async () => {
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-not-match
+x
 world`;
    const result = await applyPatchExecutor({ patch }, createToolContext(root));
    expect(result.success).toBe(false);
  });

  it("applies complex multi-hunk patch in one file", async () => {
    await writeFile(`${root}/a.txt`, "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
@@ -4,2 +4,2 @@
-delta
+DELTA
 epsilon`;
    const result = await applyPatchExecutor({ patch }, createToolContext(root));
    expect(result.success).toBe(true);
    expect(await readFile(`${root}/a.txt`, "utf8")).toBe("alpha\nBETA\ngamma\nDELTA\nepsilon\n");
  });

  it("rolls back all previous file changes when later file fails", async () => {
    await writeFile(`${root}/a.txt`, "hello\nworld\n");
    await writeFile(`${root}/b.txt`, "foo\nbar\n");
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 hello
-world
+WORLD
--- a/b.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
-not-foo
+FOO
 bar`;
    const result = await applyPatchExecutor({ patch }, createToolContext(root));
    expect(result.success).toBe(false);
    expect(await readFile(`${root}/a.txt`, "utf8")).toBe("hello\nworld\n");
    expect(await readFile(`${root}/b.txt`, "utf8")).toBe("foo\nbar\n");
  });

  it("supports create and delete in one patch", async () => {
    const patch = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line-1
+line-2
--- a/a.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world`;
    const result = await applyPatchExecutor({ patch }, createToolContext(root));
    expect(result.success).toBe(true);
    expect(await readFile(`${root}/new.txt`, "utf8")).toBe("line-1\nline-2");
    await expect(readFile(`${root}/a.txt`, "utf8")).rejects.toBeDefined();
  });

  it("fails with invalid patch header format", async () => {
    const patch = `--- a/a.txt
@@ -1,1 +1,1 @@
-hello
+HELLO`;
    await expect(applyPatchExecutor({ patch }, createToolContext(root))).rejects.toMatchObject({
      code: "VALIDATION_PATCH_FORMAT",
    });
  });
});
