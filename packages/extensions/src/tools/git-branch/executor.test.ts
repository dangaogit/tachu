import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitBranchExecutor } from "./executor";
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

const BRANCH_FIXTURE = `* main                abc1234 [origin/main: ahead 2, behind 1] latest commit
  feature/foo         def5678 [origin/feature/foo] some feature work
  old-branch          aaa1111 old stuff
`;

describe("git-branch executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

  test("parses branches with tracking info", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(BRANCH_FIXTURE) as never);

    const result = await gitBranchExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.current).toBe("main");
    expect(result.branches).toHaveLength(3);

    const main = result.branches.find((b) => b.name === "main");
    expect(main).toMatchObject({
      current: true,
      remote: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    });

    const feature = result.branches.find((b) => b.name === "feature/foo");
    expect(feature).toMatchObject({
      current: false,
      upstream: "origin/feature/foo",
    });
    expect(feature?.ahead).toBeUndefined();

    const old = result.branches.find((b) => b.name === "old-branch");
    expect(old?.upstream).toBeUndefined();
  });

  test("uses -vva flag when all=true", async () => {
    let capturedCmd: string[] = [];
    spy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      capturedCmd = opts.cmd;
      return makeProc(BRANCH_FIXTURE) as never;
    });

    await gitBranchExecutor({ all: true }, makeContext());
    expect(capturedCmd).toContain("-vva");
  });

  test("uses -vv flag when all=false", async () => {
    let capturedCmd: string[] = [];
    spy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      capturedCmd = opts.cmd;
      return makeProc(BRANCH_FIXTURE) as never;
    });

    await gitBranchExecutor({ all: false }, makeContext());
    expect(capturedCmd).toContain("-vv");
    expect(capturedCmd).not.toContain("-vva");
  });

  test("returns error on git failure", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: not a git repository", 128) as never,
    );

    const result = await gitBranchExecutor({}, makeContext());
    expect(result).toMatchObject({ error: "fatal: not a git repository" });
  });

  test("throws when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gitBranchExecutor({}, makeContext({ abortSignal: ac.signal }))).rejects.toThrow();
  });
});
