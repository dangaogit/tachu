import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitShowExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = (overrides?: Partial<ToolExecutionContext>): ToolExecutionContext => ({
  abortSignal: new AbortController().signal,
  workspaceRoot: "/workspace",
  session: {} as never,
  ...overrides,
});

const makeProc = (stdout: string, stderr = "", exitCode = 0) => ({
  stdout: new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(stdout));
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
});

const SHOW_FIXTURE = `COMMIT_HEADER\x1fHASH:abc1234567890abcdef1234567890abcdef123456\x1fSHORT:abc1234\x1fAUTHOR:Alice\x1fEMAIL:alice@example.com\x1fDATE:2026-01-01T00:00:00+00:00\x1fSUBJECT:feat: add something\x1fBODY:\x1fEND_HEADER
 src/foo.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;

describe("git-show executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

 test("parses commit metadata and diff", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(SHOW_FIXTURE) as never);

    const result = await gitShowExecutor({ ref: "HEAD" }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result).toMatchObject({
      hash: "abc1234567890abcdef1234567890abcdef123456",
      shortHash: "abc1234",
      author: "Alice",
      email: "alice@example.com",
      date: "2026-01-01T00:00:00+00:00",
      subject: "feat: add something",
      truncated: false,
    });
    expect(result.diff).toContain("diff --git");
  });

 test("truncates diff at maxBytes", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(SHOW_FIXTURE) as never);

    const result = await gitShowExecutor({ ref: "HEAD", maxBytes: 10 }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.truncated).toBe(true);
    expect(result.diff.length).toBeLessThanOrEqual(10);
  });

 test("returns error on git failure", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: bad object HEAD", 128) as never,
    );

    const result = await gitShowExecutor({ ref: "HEAD" }, makeContext());
    expect(result).toMatchObject({ error: "fatal: bad object HEAD" });
  });

 test("throws when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gitShowExecutor({ ref: "HEAD" }, makeContext({ abortSignal: ac.signal }))).rejects.toThrow();
  });
});
