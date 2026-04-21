import { describe, expect, test } from "bun:test";
import { DefaultObservabilityEmitter } from "./observability";

describe("DefaultObservabilityEmitter", () => {
  test("emits and masks events", () => {
    const emitter = new DefaultObservabilityEmitter();
    let received = "";
    emitter.on("*", (event) => {
      received = String(event.payload.secret);
    });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "t1",
      sessionId: "s1",
      phase: "test",
      type: "warning",
      payload: { secret: "sk-1234567890abcdef1234567890" },
    });
    expect(received).toBe("[MASKED]");
  });

  test("supports on/off and custom masker", () => {
    const emitter = new DefaultObservabilityEmitter();
    const received: string[] = [];
    const off = emitter.on("warning", (event) => {
      received.push(String(event.payload.message));
    });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "t2",
      sessionId: "s2",
      phase: "test",
      type: "warning",
      payload: { message: "first" },
    });
    off();
    emitter.emit({
      timestamp: Date.now(),
      traceId: "t2",
      sessionId: "s2",
      phase: "test",
      type: "warning",
      payload: { message: "second" },
    });
    expect(received).toEqual(["first"]);

    emitter.setMasker((payload) => ({ ...(payload as Record<string, unknown>), secret: "custom" }));
    let secret = "";
    emitter.on("*", (event) => {
      secret = String(event.payload.secret);
    });
    emitter.emit({
      timestamp: Date.now(),
      traceId: "t3",
      sessionId: "s3",
      phase: "mask",
      type: "warning",
      payload: { secret: "raw" },
    });
    expect(secret).toBe("custom");
  });
});

