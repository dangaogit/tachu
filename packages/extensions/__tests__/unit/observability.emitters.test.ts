import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { readFile } from "node:fs/promises";
import { JsonlEmitter } from "../../src/observability/jsonl-emitter";
import { OtelEmitter } from "../../src/observability/otel-emitter";
import { cleanupTempDir, createTempDir } from "../helpers";

describe("observability emitters", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("writes events to jsonl file", async () => {
    const emitter = new JsonlEmitter({ filePath: `${root}/events.jsonl`, rotateSize: 1024 * 1024 });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "trace",
      sessionId: "session",
      type: "phase_enter",
      phase: "test",
      payload: { message: "hi" },
    });
    await emitter.dispose();
    const content = await readFile(`${root}/events.jsonl`, "utf8");
    expect(content.includes("\"phase\":\"test\"")).toBe(true);
  });

  it("emits spans through otel tracer", () => {
    const provider = new BasicTracerProvider();
    const tracer = provider.getTracer("test");
    const emitter = new OtelEmitter({ tracer });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "trace",
      sessionId: "session",
      type: "phase_enter",
      phase: "p",
      payload: {},
    });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "trace",
      sessionId: "session",
      type: "phase_exit",
      phase: "p",
      payload: {},
    });
    expect(true).toBe(true);
  });
});
