import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitBlameExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = (overrides?: Partial<ToolExecutionContext>): ToolExecutionContext => ({
  abortSignal: new AbortController().signal,
  workspaceRoot: "/workspace",
  allowedRoots: ["/workspace"],
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

// git blame --porcelain uses exactly 40-char hex hashes
const BLAME_HASH = "aabbccddeeff00112233445566778899aabbccdd";
const BLAME_SHORT = "aabbccd";

const BLAME_FIXTURE = `${BLAME_HASH} 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1704067200
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1704067200
committer-tz +0000
summary feat: add feature
filename src/foo.ts
\tfirst line content
${BLAME_HASH} 2 2
author Alice
author-mail <alice@example.com>
author-time 1704067200
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1704067200
committer-tz +0000
summary feat: add feature
filename src/foo.ts
\tsecond line content
`;

describe("git-blame executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

  test("parses porcelain blame output", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(BLAME_FIXTURE) as never);

    const result = await gitBlameExecutor({ path: "/workspace/src/foo.ts" }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      lineNumber: 1,
      hash: BLAME_HASH,
      shortHash: BLAME_SHORT,
      author: "Alice",
      content: "first line content",
    });
    expect(result.lines[1]?.content).toBe("second line content");
    expect(result.path).toBe("/workspace/src/foo.ts");
  });

  test("date is ISO 8601", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(BLAME_FIXTURE) as never);

    const result = await gitBlameExecutor({ path: "/workspace/src/foo.ts" }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.lines[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("includes -L flag when startLine/endLine provided", async () => {
    let capturedCmd: string[] = [];
    spy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      capturedCmd = opts.cmd;
      return makeProc(BLAME_FIXTURE) as never;
    });

    await gitBlameExecutor({ path: "/workspace/src/foo.ts", startLine: 5, endLine: 10 }, makeContext());
    expect(capturedCmd).toContain("-L");
    expect(capturedCmd).toContain("5,10");
  });

  test("returns error on git failure", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: no such path", 128) as never,
    );

    const result = await gitBlameExecutor({ path: "/workspace/src/foo.ts" }, makeContext());
    expect(result).toMatchObject({ error: "fatal: no such path" });
  });

  test("throws when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      gitBlameExecutor({ path: "/workspace/src/foo.ts" }, makeContext({ abortSignal: ac.signal })),
    ).rejects.toThrow();
  });
});
