import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { applyPatchExecutor } from "../../src/tools/apply-patch/executor";
import { fetchUrlExecutor } from "../../src/tools/fetch-url/executor";
import { listDirExecutor } from "../../src/tools/list-dir/executor";
import { readFileExecutor } from "../../src/tools/read-file/executor";
import { runShellExecutor } from "../../src/tools/run-shell/executor";
import { searchCodeExecutor } from "../../src/tools/search-code/executor";
import { writeFileExecutor } from "../../src/tools/write-file/executor";
import { cleanupTempDir, createTempDir, createToolContext } from "../helpers";

describe("tools smoke integration", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
    await writeFile(`${root}/code.ts`, "const hello = 'world';\n");
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("runs all builtin tools", async () => {
    const ctx = createToolContext(root);

    const read = await readFileExecutor({ path: "code.ts" }, ctx);
    expect(read.content.includes("hello")).toBe(true);

    const write = await writeFileExecutor(
      { path: "nested/out.txt", content: "ok", createDirs: true },
      ctx,
    );
    expect(write.bytesWritten).toBe(2);

    const list = await listDirExecutor({ path: ".", recursive: true }, ctx);
    expect(list.entries.length).toBeGreaterThan(0);

    const search = await searchCodeExecutor({ pattern: "hello", path: "." }, ctx);
    expect(search.matches.length).toBeGreaterThan(0);

    const fetch = await fetchUrlExecutor({ url: "https://example.com" }, ctx);
    expect(fetch.status).toBeGreaterThan(0);

    const shell = await runShellExecutor({ command: "echo", args: ["ok"] }, ctx);
    expect(shell.exitCode).toBe(0);

    const patch = `--- a/code.ts
+++ b/code.ts
@@ -1 +1 @@
-const hello = 'world';
+const hello = 'tachu';`;
    const patchResult = await applyPatchExecutor({ patch }, ctx);
    expect(patchResult.success).toBe(true);
  });
});
