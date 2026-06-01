import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "../types";
import { DefaultObservabilityEmitter } from "./observability";

const event = (
  traceId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): EngineEvent => ({
  timestamp: Date.now(),
  correlation: {
    traceId,
    requestId: `req-${traceId}`,
    sessionId,
    turnId: `turn-${traceId}`,
  },
  phase: "test",
  type: "warning",
  payload,
});

describe("DefaultObservabilityEmitter", () => {
 test("emits and masks events", () => {
    const emitter = new DefaultObservabilityEmitter();
    let received = "";
    emitter.on("*", (event) => {
      received = String(event.payload.secret);
    });
    emitter.emit(event("t1", "s1", { secret: "sk-1234567890abcdef1234567890" }));
    expect(received).toBe("[MASKED]");
  });

 test("supports on/off and custom masker", () => {
    const emitter = new DefaultObservabilityEmitter();
    const received: string[] = [];
    const off = emitter.on("warning", (event) => {
      received.push(String(event.payload.message));
    });
    emitter.emit(event("t2", "s2", { message: "first" }));
    off();
    emitter.emit(event("t2", "s2", { message: "second" }));
    expect(received).toEqual(["first"]);

    emitter.setMasker((payload) => ({ ...(payload as Record<string, unknown>), secret: "custom" }));
    let secret = "";
    emitter.on("*", (event) => {
      secret = String(event.payload.secret);
    });
    emitter.emit({
      ...event("t3", "s3", { secret: "raw" }),
      phase: "mask",
    });
    expect(secret).toBe("custom");
  });
});
