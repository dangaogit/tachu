import { describe, expect, it } from "bun:test";

import type { ValidationOutcome } from "../types";
import { decideTurnRetry } from "./turn-retry";

const retryTurn: ValidationOutcome = {
  kind: "retry",
  reason: "deterministic finding",
  target: "retry-turn",
};
const toolLoopRetry: ValidationOutcome = {
  kind: "retry",
  reason: "tool finalize",
  target: "tool-loop-finalize",
};
const pass: ValidationOutcome = { kind: "pass" };
const degrade: ValidationOutcome = {
  kind: "degrade",
  reason: "deg",
  userVisibleReason: "deg",
};
const handoff: ValidationOutcome = {
  kind: "handoff",
  reason: "ho",
  userVisibleReason: "ho",
};

describe("decideTurnRetry — terminal outcomes always exit", () => {
  for (const retryCount of [0, 1, 2]) {
    it(`pass + retryCount=${retryCount} → exit`, () => {
      const d = decideTurnRetry({
        outcome: pass,
        retryCount,
        maxRetries: 2,
        previousOutcomeKinds: [],
      });
      expect(d.kind).toBe("exit");
    });
    it(`degrade + retryCount=${retryCount} → exit`, () => {
      const d = decideTurnRetry({
        outcome: degrade,
        retryCount,
        maxRetries: 2,
        previousOutcomeKinds: [],
      });
      expect(d.kind).toBe("exit");
    });
    it(`handoff + retryCount=${retryCount} → exit`, () => {
      const d = decideTurnRetry({
        outcome: handoff,
        retryCount,
        maxRetries: 2,
        previousOutcomeKinds: [],
      });
      expect(d.kind).toBe("exit");
    });
  }
});

describe("decideTurnRetry — retry outcomes obey budget", () => {
  for (const retryCount of [0, 1]) {
    it(`retry/retry-turn retryCount=${retryCount} → continue, next=${retryCount + 1}`, () => {
      const d = decideTurnRetry({
        outcome: retryTurn,
        retryCount,
        maxRetries: 2,
        previousOutcomeKinds: [],
      });
      expect(d.kind).toBe("continue");
      if (d.kind === "continue") expect(d.nextRetryCount).toBe(retryCount + 1);
    });
  }
  it("retry/retry-turn retryCount=2 (== maxRetries) → exit (budget)", () => {
    const d = decideTurnRetry({
      outcome: retryTurn,
      retryCount: 2,
      maxRetries: 2,
      previousOutcomeKinds: ["retry", "retry"],
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toContain("max");
  });
});

describe("decideTurnRetry — tool-loop-finalize is not a turn retry", () => {
  it("retry/tool-loop-finalize → exit (handled in sub-flow)", () => {
    const d = decideTurnRetry({
      outcome: toolLoopRetry,
      retryCount: 0,
      maxRetries: 2,
      previousOutcomeKinds: [],
    });
    expect(d.kind).toBe("exit");
  });
});

describe("decideTurnRetry — anti-loop on repeated kind", () => {
  it("retry kind repeated twice in a row → exit anti-loop", () => {
    const d = decideTurnRetry({
      outcome: retryTurn,
      retryCount: 1,
      maxRetries: 5,
      previousOutcomeKinds: ["retry"],
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toContain("anti-loop");
  });
});
