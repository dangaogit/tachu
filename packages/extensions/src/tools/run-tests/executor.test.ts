import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTestsExecutor } from "./executor";
import type { ToolExecutionContext } from "../shared";

const makeContext = (root: string, overrides?: Partial<ToolExecutionContext>): ToolExecutionContext => ({
  abortSignal: new AbortController().signal,
  workspaceRoot: root,
  allowedRoots: [root],
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
  pid: 12345,
  kill: () => {},
});

const withTmpDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-run-tests-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const BUN_TEST_OUTPUT_PASSING = `
bun test v1.0.0 (abc1234)

src/foo.test.ts:
✓ adds two numbers (0.5ms)
✓ subtracts two numbers (0.3ms)

5 pass
0 fail
`;

const BUN_TEST_OUTPUT_WITH_FAILURES = `
bun test v1.0.0 (abc1234)

src/foo.test.ts:
✓ passing test (0.5ms)
✗ failing test
  Expected: 42
  Received: 0

3 pass
1 fail
`;

describe("run-tests executor", () => {
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spawnSpy?.mockRestore());

  test("parses passing test output", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(BUN_TEST_OUTPUT_PASSING, "", 0) as never);

      const result = await runTestsExecutor({}, makeContext(dir));
      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(5);
      expect(result.failedCount).toBe(0);
      expect(result.failures).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });
  });

  test("parses failed test output", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(BUN_TEST_OUTPUT_WITH_FAILURES, "", 1) as never);

      const result = await runTestsExecutor({}, makeContext(dir));
      expect(result.passed).toBe(false);
      expect(result.passedCount).toBe(3);
      expect(result.failedCount).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("failing test");
      expect(result.failures[0]?.message).toContain("Expected: 42");
    });
  });

  test("uses bun run test when test script exists", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}', "utf8");
      let capturedCmd: string[] = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
        capturedCmd = opts.cmd;
        return makeProc(BUN_TEST_OUTPUT_PASSING, "", 0) as never;
      });

      await runTestsExecutor({}, makeContext(dir));
      // process.execPath replaces "bun"; cmd[1]="run", cmd[2]="test"
      expect(capturedCmd[1]).toBe("run");
      expect(capturedCmd[2]).toBe("test");
    });
  });

  test("uses bun test when lockfile exists but no test script", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "bun.lockb"), "", "utf8");
      let capturedCmd: string[] = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
        capturedCmd = opts.cmd;
        return makeProc(BUN_TEST_OUTPUT_PASSING, "", 0) as never;
      });

      await runTestsExecutor({}, makeContext(dir));
      // process.execPath is bun binary; second arg should be "test"
      expect(capturedCmd[1]).toBe("test");
    });
  });

  test("returns error message when no test command detected", async () => {
    await withTmpDir(async (dir) => {
      // empty dir, no package.json, no lockfile
      const result = await runTestsExecutor({}, makeContext(dir));
      expect(result.passed).toBe(false);
      expect(result.rawOutput).toContain("未能自动识别");
    });
  });

  test("passes filter flag to bun test", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "bun.lockb"), "", "utf8");
      let capturedCmd: string[] = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
        capturedCmd = opts.cmd;
        return makeProc(BUN_TEST_OUTPUT_PASSING, "", 0) as never;
      });

      await runTestsExecutor({ filter: "my test" }, makeContext(dir));
      expect(capturedCmd).toContain("--test-name-pattern");
      expect(capturedCmd).toContain("my test");
    });
  });

  test("total equals pass + fail + skip", async () => {
    await withTmpDir(async (dir) => {
      const output = "3 pass\n2 fail\n1 skip\n";
      await writeFile(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(output, "", 1) as never);

      const result = await runTestsExecutor({}, makeContext(dir));
      expect(result.total).toBe(6);
      expect(result.skippedCount).toBe(1);
    });
  });

  test("throws when aborted", async () => {
    await withTmpDir(async (dir) => {
      const ac = new AbortController();
      ac.abort();
      await expect(runTestsExecutor({}, makeContext(dir, { abortSignal: ac.signal }))).rejects.toThrow();
    });
  });
});
