import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitDiffExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = (overrides?: Partial<ToolExecutionContext>): ToolExecutionContext => ({
  abortSignal: new AbortController().signal,
  workspaceRoot: "/workspace",
  session: {} as never,
  ...overrides,
});

const makeProc = (stdout: string | Uint8Array, stderr = "", exitCode = 0) => {
  const bytes = typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout;
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  };
};

const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 modified
+new line
 line3
`;

describe("git-diff executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

 test("parses simple diff", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(SIMPLE_DIFF) as never);

    const result = await gitDiffExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "src/foo.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
    });
    expect(result.files[0]!.hunks).toHaveLength(1);
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(1);
    expect(result.truncated).toBe(false);
  });

 test("detects new file", async () => {
    const diff = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,2 @@
+line1
+line2
`;
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(diff) as never);

    const result = await gitDiffExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.files[0]).toMatchObject({ status: "added", additions: 2, deletions: 0 });
  });

 test("detects binary file", async () => {
    const diff = `diff --git a/img.png b/img.png
index 1234567..abcdefg 100644
Binary files a/img.png and b/img.png differ
`;
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(diff) as never);

    const result = await gitDiffExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.files[0]).toMatchObject({ binary: true, hunks: [] });
  });

 test("truncates output at maxBytes", async () => {
    const largeDiff = SIMPLE_DIFF.repeat(100);
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(largeDiff) as never);

    const result = await gitDiffExecutor({ maxBytes: 100 }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.truncated).toBe(true);
  });

 test("returns error on git failure", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: not a git repo", 128) as never,
    );

    const result = await gitDiffExecutor({}, makeContext());
    expect(result).toMatchObject({ error: "fatal: not a git repo" });
  });

 test("throws when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gitDiffExecutor({}, makeContext({ abortSignal: ac.signal }))).rejects.toThrow();
  });
});
