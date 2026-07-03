import { describe, expect, test } from "bun:test";
import {
  createResultValidationGuardAction,
  createSafetyViolationsGuardAction,
  reduceGuardDecisions,
} from "./guardrail";
import type { SafetyViolation } from "./safety";

describe("reduceGuardDecisions", () => {
  test("全部 pass 时返回 pass", () => {
    const result = reduceGuardDecisions([{ kind: "pass" }, { kind: "pass" }]);
    expect(result).toEqual({ kind: "pass" });
  });

  test("任一 block 作为最严格结果返回", () => {
    const result = reduceGuardDecisions([
      { kind: "annotate", prefix: "note" },
      { kind: "block", reason: "denied" },
      { kind: "pass" },
    ]);
    expect(result).toEqual({ kind: "block", reason: "denied" });
  });

  test("无 block 时 degrade 优先于 annotate", () => {
    const result = reduceGuardDecisions([
      { kind: "annotate", prefix: "note" },
      { kind: "degrade", reason: "r", userVisibleReason: "仅部分内容" },
    ]);
    expect(result).toEqual({ kind: "degrade", reason: "r", userVisibleReason: "仅部分内容" });
  });

  test("多个 annotate 合并前缀", () => {
    const result = reduceGuardDecisions([
      { kind: "annotate", prefix: "A" },
      { kind: "annotate", prefix: "B" },
    ]);
    expect(result).toEqual({ kind: "annotate", prefix: "A B" });
  });

  test("空 prefix 的 annotate 不计入合并", () => {
    const result = reduceGuardDecisions([
      { kind: "annotate", prefix: "  " },
      { kind: "pass" },
    ]);
    expect(result).toEqual({ kind: "pass" });
  });
});

describe("createSafetyViolationsGuardAction", () => {
  test("无违规时 pass", () => {
    const result = createSafetyViolationsGuardAction([]);
    expect(result).toEqual({ type: "guard", decision: { kind: "pass" } });
  });

  test("有 warning 违规时 annotate,不再静默丢弃(此前 safetyState.violations 从未被消费)", async () => {
    const violations: SafetyViolation[] = [
      { policyId: "baseline/prompt-injection", severity: "warning", message: "检测到可疑注入片段: ignore previous" },
    ];
    const result = createSafetyViolationsGuardAction(violations);
    expect(result.decision.kind).toBe("annotate");
    expect((result.decision as { prefix: string }).prefix).toContain("检测到可疑注入片段");
  });
});

describe("createResultValidationGuardAction", () => {
  test("outcome 缺省或 pass/retry 时一律 pass", () => {
    expect(createResultValidationGuardAction(undefined).decision).toEqual({ kind: "pass" });
    expect(createResultValidationGuardAction({ kind: "pass" }).decision).toEqual({ kind: "pass" });
    expect(
      createResultValidationGuardAction({
        kind: "retry",
        reason: "x",
        target: "retry-turn",
      }).decision,
    ).toEqual({ kind: "pass" });
  });

  test("degrade outcome 映射为 degrade guard 决策", () => {
    const result = createResultValidationGuardAction({
      kind: "degrade",
      reason: "partial",
      userVisibleReason: "仅确认部分内容",
    }).decision;
    expect(result).toEqual({ kind: "degrade", reason: "partial", userVisibleReason: "仅确认部分内容" });
  });

  test("handoff outcome 映射为 block guard 决策(人工接手不能直接交付)", () => {
    const result = createResultValidationGuardAction({
      kind: "handoff",
      reason: "need-human",
      userVisibleReason: "需要人工接手",
    }).decision;
    expect(result).toEqual({ kind: "block", reason: "need-human", userVisibleReason: "需要人工接手" });
  });
});
