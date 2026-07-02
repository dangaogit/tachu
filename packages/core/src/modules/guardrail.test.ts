import { describe, expect, test } from "bun:test";
import {
  createResultValidationGuardrail,
  createSafetyViolationsGuardrail,
  runGuardrails,
} from "./guardrail";
import type { Guardrail, GuardrailContext, GuardrailDecision } from "../types/guardrail";
import type { SafetyViolation } from "./safety";

const ctx: GuardrailContext = {
  point: "turnStart",
  correlation: { traceId: "t", requestId: "r", sessionId: "s", turnId: "u" },
  data: undefined,
};

const guard = (decision: GuardrailDecision, id = "g"): Guardrail => ({
  id,
  run: () => decision,
});

describe("runGuardrails", () => {
  test("全部 pass 时返回 pass", async () => {
    const result = await runGuardrails([guard({ kind: "pass" }), guard({ kind: "pass" })], ctx);
    expect(result).toEqual({ kind: "pass" });
  });

  test("任一 block 立即短路,不再跑后续 guard", async () => {
    let secondCalled = false;
    const guards: Guardrail[] = [
      guard({ kind: "block", reason: "denied" }, "first"),
      { id: "second", run: () => { secondCalled = true; return { kind: "pass" }; } },
    ];
    const result = await runGuardrails(guards, ctx);
    expect(result).toEqual({ kind: "block", reason: "denied" });
    expect(secondCalled).toBe(false);
  });

  test("无 block 时 degrade 优先于 annotate", async () => {
    const guards: Guardrail[] = [
      guard({ kind: "annotate", prefix: "note" }),
      guard({ kind: "degrade", reason: "r", userVisibleReason: "仅部分内容" }),
    ];
    const result = await runGuardrails(guards, ctx);
    expect(result).toEqual({ kind: "degrade", reason: "r", userVisibleReason: "仅部分内容" });
  });

  test("多个 annotate 合并前缀", async () => {
    const guards: Guardrail[] = [
      guard({ kind: "annotate", prefix: "A" }),
      guard({ kind: "annotate", prefix: "B" }),
    ];
    const result = await runGuardrails(guards, ctx);
    expect(result).toEqual({ kind: "annotate", prefix: "A B" });
  });

  test("空 prefix 的 annotate 不计入合并", async () => {
    const guards: Guardrail[] = [
      guard({ kind: "annotate", prefix: "  " }),
      guard({ kind: "pass" }),
    ];
    const result = await runGuardrails(guards, ctx);
    expect(result).toEqual({ kind: "pass" });
  });
});

describe("createSafetyViolationsGuardrail", () => {
  test("无违规时 pass", async () => {
    const result = await createSafetyViolationsGuardrail([]).run(ctx);
    expect(result).toEqual({ kind: "pass" });
  });

  test("有 warning 违规时 annotate,不再静默丢弃(此前 safetyState.violations 从未被消费)", async () => {
    const violations: SafetyViolation[] = [
      { policyId: "baseline/prompt-injection", severity: "warning", message: "检测到可疑注入片段: ignore previous" },
    ];
    const result = await createSafetyViolationsGuardrail(violations).run(ctx);
    expect(result.kind).toBe("annotate");
    expect((result as { prefix: string }).prefix).toContain("检测到可疑注入片段");
  });
});

describe("createResultValidationGuardrail", () => {
  test("outcome 缺省或 pass/retry 时一律 pass", async () => {
    expect(await createResultValidationGuardrail(undefined).run(ctx)).toEqual({ kind: "pass" });
    expect(await createResultValidationGuardrail({ kind: "pass" }).run(ctx)).toEqual({ kind: "pass" });
    expect(
      await createResultValidationGuardrail({
        kind: "retry",
        reason: "x",
        target: "retry-turn",
      }).run(ctx),
    ).toEqual({ kind: "pass" });
  });

  test("degrade outcome 映射为 degrade guardrail 决策", async () => {
    const result = await createResultValidationGuardrail({
      kind: "degrade",
      reason: "partial",
      userVisibleReason: "仅确认部分内容",
    }).run(ctx);
    expect(result).toEqual({ kind: "degrade", reason: "partial", userVisibleReason: "仅确认部分内容" });
  });

  test("handoff outcome 映射为 block guardrail 决策(人工接手不能直接交付)", async () => {
    const result = await createResultValidationGuardrail({
      kind: "handoff",
      reason: "need-human",
      userVisibleReason: "需要人工接手",
    }).run(ctx);
    expect(result).toEqual({ kind: "block", reason: "need-human", userVisibleReason: "需要人工接手" });
  });
});
