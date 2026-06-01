import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTypecheckExecutor } from "./executor";
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
});

const withTmpDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-typecheck-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const TSC_OUTPUT_WITH_ERRORS = `src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/bar.ts(20,3): error TS2551: Property 'foo' does not exist on type 'Bar'.
src/baz.ts(5,1): warning TS6133: 'unused' is declared but its value is never read.
`;

describe("run-typecheck executor", () => {
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spawnSpy?.mockRestore());

 test("parses tsc errors and warnings", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"name":"test","scripts":{}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(TSC_OUTPUT_WITH_ERRORS, "", 1) as never);

      const result = await runTypecheckExecutor({}, makeContext(dir));
      expect(result.passed).toBe(false);
      expect(result.errorCount).toBe(2);
      expect(result.warningCount).toBe(1);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]?.severity).toBe("error");
      expect(result.errors[2]?.severity).toBe("warning");
      expect(result.truncated).toBe(false);
    });
  });

 test("parses error details correctly", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(TSC_OUTPUT_WITH_ERRORS, "", 1) as never);

      const result = await runTypecheckExecutor({}, makeContext(dir));
      const first = result.errors[0]!;
      expect(first).toMatchObject({
        file: "src/foo.ts",
        line: 10,
        col: 5,
        code: "TS2345",
        severity: "error",
      });
      expect(first.message).toContain("Argument of type");
    });
  });

 test("passed=true when exit code 0", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc("", "", 0) as never);

      const result = await runTypecheckExecutor({}, makeContext(dir));
      expect(result.passed).toBe(true);
      expect(result.errorCount).toBe(0);
    });
  });

 test("uses bun run typecheck when script exists", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{"typecheck":"tsc --noEmit"}}', "utf8");
      let capturedCmd: string[] = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
        capturedCmd = opts.cmd;
        return makeProc("", "", 0) as never;
      });

      await runTypecheckExecutor({}, makeContext(dir));
 // process.execPath replaces "bun"; cmd[1]="run", cmd[2]="typecheck"
      expect(capturedCmd[1]).toBe("run");
      expect(capturedCmd[2]).toBe("typecheck");
    });
  });

 test("falls back to bunx tsc when no script", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"scripts":{}}', "utf8");
      let capturedCmd: string[] = [];
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
        capturedCmd = opts.cmd;
        return makeProc("", "", 0) as never;
      });

      await runTypecheckExecutor({}, makeContext(dir));
 // process.execPath x tsc --noEmit
      expect(capturedCmd[1]).toBe("x");
      expect(capturedCmd[2]).toBe("tsc");
    });
  });

 test("truncates errors at maxErrors", async () => {
    await withTmpDir(async (dir) => {
      const manyErrors = Array.from(
        { length: 10 },
        (_, i) => `src/file${i}.ts(1,1): error TS2345: error ${i}.`,
      ).join("\n");
      await writeFile(join(dir, "package.json"), '{"scripts":{}}', "utf8");
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(manyErrors, "", 1) as never);

      const result = await runTypecheckExecutor({ maxErrors: 3 }, makeContext(dir));
      expect(result.errors).toHaveLength(3);
      expect(result.truncated).toBe(true);
      expect(result.errorCount).toBe(10);
    });
  });

 test("throws when aborted", async () => {
    await withTmpDir(async (dir) => {
      const ac = new AbortController();
      ac.abort();
      await expect(runTypecheckExecutor({}, makeContext(dir, { abortSignal: ac.signal }))).rejects.toThrow();
    });
  });
});
