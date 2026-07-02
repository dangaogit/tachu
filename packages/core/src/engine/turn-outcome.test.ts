import { describe, expect, test } from "bun:test";

import { validationOutcomeToEvent } from "./turn-outcome";
import type { ValidationOutcome } from "../types";

const ts = 1_700_000_000_000;

describe("validationOutcomeToEvent — P1 γ outcome→event mapping", () => {
 test("pass returns null (no event emitted on successful validation)", () => {
    const outcome: ValidationOutcome = { kind: "pass" };
    expect(validationOutcomeToEvent(outcome, ts)).toBeNull();
  });

 test("retry+retry-turn emits retry event with target preserved", () => {
    const outcome: ValidationOutcome = {
      kind: "retry",
      reason: "execution_failed",
      target: "retry-turn",
    };
    expect(validationOutcomeToEvent(outcome, ts)).toEqual({
      timestamp: ts,
      phase: "validation",
      type: "retry",
      payload: { reason: "execution_failed", target: "retry-turn" },
    });
  });

 test("retry+tool-loop-finalize emits retry event with target=tool-loop-finalize", () => {
    const outcome: ValidationOutcome = {
      kind: "retry",
      reason: "tool_use_partial",
      target: "tool-loop-finalize",
    };
    const ev = validationOutcomeToEvent(outcome, ts);
    expect(ev?.type).toBe("retry");
    expect((ev?.payload as { target: string }).target).toBe("tool-loop-finalize");
  });

 test("degrade emits degrade event preserving userVisibleReason", () => {
    const outcome: ValidationOutcome = {
      kind: "degrade",
      reason: "tool_use_partial",
      userVisibleReason: "当前结果只有部分可确认内容",
    };
    expect(validationOutcomeToEvent(outcome, ts)).toEqual({
      timestamp: ts,
      phase: "validation",
      type: "degrade",
      payload: {
        reason: "tool_use_partial",
        userVisibleReason: "当前结果只有部分可确认内容",
      },
    });
  });

 test("handoff emits handoff event preserving userVisibleReason", () => {
    const outcome: ValidationOutcome = {
      kind: "handoff",
      reason: "policy_violation",
      userVisibleReason: "需要人工接手",
    };
    expect(validationOutcomeToEvent(outcome, ts)).toEqual({
      timestamp: ts,
      phase: "validation",
      type: "handoff",
      payload: {
        reason: "policy_violation",
        userVisibleReason: "需要人工接手",
      },
    });
  });
});
