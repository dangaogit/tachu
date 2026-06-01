import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { gitLogExecutor } from "./executor";
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

const makeRecord = (
  hash: string,
  shortHash: string,
  author: string,
  email: string,
  date: string,
  refs: string,
  subject: string,
  body: string,
) => `${hash}\x1f${shortHash}\x1f${author}\x1f${email}\x1f${date}\x1f${refs}\x1f${subject}\x1f${body}\x1e`;

describe("git-log executor", () => {
  let spy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
  afterEach(() => spy?.mockRestore());

 test("parses single commit", async () => {
    const fixture = makeRecord(
      "abc1234567890abcdef1234567890abcdef123456",
      "abc1234",
      "Alice",
      "alice@example.com",
      "2026-01-01T00:00:00+00:00",
      "HEAD -> main, origin/main",
      "feat: add feature",
      "",
    );

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitLogExecutor({}, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]).toMatchObject({
      hash: "abc1234567890abcdef1234567890abcdef123456",
      shortHash: "abc1234",
      author: "Alice",
      email: "alice@example.com",
      subject: "feat: add feature",
    });
    expect(result.commits[0]!.refs).toContain("HEAD -> main");
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });

 test("parses body when oneline=false", async () => {
    const fixture = makeRecord(
      "abc1234567890abcdef1234567890abcdef123456",
      "abc1234",
      "Alice",
      "alice@example.com",
      "2026-01-01T00:00:00+00:00",
      "",
      "feat: add feature",
      "This is the body\nWith multiple lines",
    );

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitLogExecutor({ oneline: false }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.commits[0]?.body).toContain("This is the body");
  });

 test("no body when oneline=true", async () => {
    const fixture = makeRecord(
      "abc1234567890abcdef1234567890abcdef123456",
      "abc1234",
      "Alice",
      "alice@example.com",
      "2026-01-01T00:00:00+00:00",
      "",
      "feat: add feature",
      "Some body text",
    );

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(fixture) as never);

    const result = await gitLogExecutor({ oneline: true }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.commits[0]?.body).toBeUndefined();
  });

 test("caps limit at 100", async () => {
    let capturedCmd: string[] = [];
    spy = spyOn(Bun, "spawn").mockImplementation((opts: any) => {
      capturedCmd = opts.cmd;
      return makeProc("") as never;
    });

    await gitLogExecutor({ limit: 500 }, makeContext());
    const nIdx = capturedCmd.indexOf("-n");
    expect(capturedCmd[nIdx + 1]).toBe("100");
  });

 test("returns error on git failure", async () => {
    spy = spyOn(Bun, "spawn").mockImplementation(
      () => makeProc("", "fatal: not a git repo", 128) as never,
    );

    const result = await gitLogExecutor({}, makeContext());
    expect(result).toMatchObject({ error: "fatal: not a git repo" });
  });

 test("hasMore=true when limit reached", async () => {
    const records = [
      makeRecord("a".repeat(40), "aaaaaaa", "A", "a@a.com", "2026-01-01T00:00:00+00:00", "", "s1", ""),
      makeRecord("b".repeat(40), "bbbbbbb", "B", "b@b.com", "2026-01-01T00:00:00+00:00", "", "s2", ""),
    ].join("");

    spy = spyOn(Bun, "spawn").mockImplementation(() => makeProc(records) as never);

    const result = await gitLogExecutor({ limit: 2 }, makeContext());
    if ("error" in result) throw new Error(result.error);

    expect(result.hasMore).toBe(true);
  });

 test("throws when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gitLogExecutor({}, makeContext({ abortSignal: ac.signal }))).rejects.toThrow();
  });
});
