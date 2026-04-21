import { describe, expect, test } from "bun:test";
import { createLogger, replaceCircular, type WritableStreamLike } from "./logger";

function captureStream(): { stream: WritableStreamLike; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

describe("replaceCircular", () => {
  test("replaces cyclic references with a sentinel string", () => {
    const root: Record<string, unknown> = { n: 1 };
    root.loop = root;
    const json = JSON.stringify(root, replaceCircular());
    expect(json).toContain('"loop":"[Circular]"');
  });
});

describe("createLogger", () => {
  test("drops debug when configured level is info", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ level: "info", stream });
    log.debug("skip-me");
    log.info("keep-me");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0] ?? "{}") as { level: string; msg: string };
    expect(row.level).toBe("info");
    expect(row.msg).toBe("keep-me");
  });

  test("emits info lines as single-line JSON ending with newline", () => {
    const { stream, lines } = captureStream();
    createLogger({ level: "info", stream }).info("hello");
    expect(lines.length).toBe(1);
    const chunk = lines[0];
    expect(chunk?.endsWith("\n")).toBe(true);
    const row = JSON.parse(chunk?.trim() ?? "{}") as { ts: string; level: string; msg: string };
    expect(row.msg).toBe("hello");
    expect(row.level).toBe("info");
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("error records include spread fields", () => {
    const { stream, lines } = captureStream();
    createLogger({ level: "debug", stream }).error("boom", { code: "E_TEST", n: 42 });
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]?.trim() ?? "{}") as {
      level: string;
      msg: string;
      code: string;
      n: number;
    };
    expect(row.level).toBe("error");
    expect(row.msg).toBe("boom");
    expect(row.code).toBe("E_TEST");
    expect(row.n).toBe(42);
  });

  test("child merges bindings and per-call fields override", () => {
    const { stream, lines } = captureStream();
    const parent = createLogger({ level: "debug", stream });
    parent.child({ svc: "web-fetch", trace: "t1" }).info("req", { trace: "t-override" });
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]?.trim() ?? "{}") as {
      svc: string;
      trace: string;
      msg: string;
    };
    expect(row.svc).toBe("web-fetch");
    expect(row.trace).toBe("t-override");
    expect(row.msg).toBe("req");
  });

  test("stream receives one JSON object per log call (multiple lines)", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ level: "info", stream });
    log.info("a");
    log.warn("b");
    expect(lines.length).toBe(2);
    for (const chunk of lines) {
      expect(chunk?.endsWith("\n")).toBe(true);
      const oneLine = chunk?.replace(/\n$/, "");
      expect(oneLine?.includes("\n")).toBe(false);
      expect(() => JSON.parse(oneLine ?? "{}")).not.toThrow();
    }
    expect((JSON.parse(lines[0]?.trim() ?? "{}") as { msg: string }).msg).toBe("a");
    expect((JSON.parse(lines[1]?.trim() ?? "{}") as { msg: string }).msg).toBe("b");
  });

  test("circular field values do not throw and are serialized safely", () => {
    const { stream, lines } = captureStream();
    const cyclic: Record<string, unknown> = { k: 1 };
    cyclic.self = cyclic;
    const log = createLogger({ level: "info", stream });
    expect(() => log.info("with-cycle", { payload: cyclic })).not.toThrow();
    expect(lines.length).toBe(1);
    const raw = lines[0] ?? "";
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("[Circular]");
  });
});
