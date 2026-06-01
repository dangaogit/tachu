import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitStatusExecutor } from "./executor";
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

describe("git-status executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

 test("parses clean repo on main branch", async () => {
    const fixture = [
      "# branch.oid abc1234",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    ].join("\n");

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitStatusExecutor({ cwd: "/workspace" }, makeContext());
    expect(result).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      isClean: true,
      detachedHead: false,
    });
  });

 test("parses modified and untracked files", async () => {
    const fixture = [
      "# branch.oid abc1234",
      "# branch.head feature",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb src/foo.ts",
      "1 .M N... 100644 100644 100644 aaa bbb src/bar.ts",
      "? newfile.ts",
    ].join("\n");

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitStatusExecutor({}, makeContext());
    expect(result).toMatchObject({
      branch: "feature",
      ahead: 2,
      behind: 1,
      staged: [{ path: "src/foo.ts", status: "M" }],
      unstaged: [{ path: "src/bar.ts", status: "M" }],
      untracked: ["newfile.ts"],
      isClean: false,
    });
  });

 test("parses renamed file", async () => {
    const fixture = [
      "# branch.oid abc1234",
      "# branch.head main",
      "# branch.ab +0 -0",
      "2 R. N... 100644 100644 100644 aaa bbb R100 old.ts\tnew.ts",
    ].join("\n");

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitStatusExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]).toMatchObject({
      path: "new.ts",
      originalPath: "old.ts",
      status: "R",
    });
  });

 test("detached HEAD", async () => {
    const fixture = [
      "# branch.oid deadbeef",
      "# branch.head (detached)",
      "# branch.ab +0 -0",
    ].join("\n");

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitStatusExecutor({}, makeContext());
    expect(result).toMatchObject({ detachedHead: true, branch: "HEAD" });
  });

 test("returns error object when git fails", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: not a git repository", 128) as never,
    );

    const result = await gitStatusExecutor({}, makeContext());
    expect(result).toMatchObject({ error: "fatal: not a git repository" });
  });

 test("throws when aborted before execution", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gitStatusExecutor({}, makeContext({ abortSignal: ac.signal }))).rejects.toThrow();
  });
});
