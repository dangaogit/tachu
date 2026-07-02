import { describe, expect, test } from "bun:test";

import {
  BudgetedSemanticJudgeAdapter,
  JudgeBudget,
  type SemanticJudgeAdapter,
  type SemanticJudgeInput,
} from "./semantic-judge";
import type { ValidationFinding, ValidationSignals } from "../../../types";

const signals: ValidationSignals = {
  intentValidationNeed: "semantic",
  answerHasClaims: true,
  hasToolObservations: true,
  hasExternalSources: false,
  hasFileWrites: false,
  hasPartialOrErrorObservations: false,
  descriptorSemanticRequired: true,
  policyMode: "auto",
};

const baseInput: SemanticJudgeInput = { prompt: "judge this claim", signals };

const makeInner = (
  impl: (input: SemanticJudgeInput) => Promise<readonly ValidationFinding[]>,
): SemanticJudgeAdapter & { calls: number } => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    judge: async (input) => {
      calls += 1;
      return impl(input);
    },
  } as SemanticJudgeAdapter & { calls: number };
};

describe("JudgeBudget", () => {
 test("consume() 在配额内返回 true 并扣减；耗尽后返回 false", () => {
    const budget = new JudgeBudget(2);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.consumed).toBe(2);
    expect(budget.remaining).toBe(0);
  });

 test("maxCalls = 0 时永远拒绝", () => {
    const budget = new JudgeBudget(0);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining).toBe(0);
  });

 test("maxCalls 非整数 / 负数 throw", () => {
    expect(() => new JudgeBudget(-1)).toThrow();
    expect(() => new JudgeBudget(1.5)).toThrow();
  });
});

describe("BudgetedSemanticJudgeAdapter — cache", () => {
 test("同 prompt + 同 signals 第二次走缓存，不消耗预算", async () => {
    const inner = makeInner(async () => [
      { ruleId: "semantic.x", kind: "semantic", severity: "info", code: "ok", message: "" },
    ]);
    const budget = new JudgeBudget(2);
    const adapter = new BudgetedSemanticJudgeAdapter({ inner, budget });
    const a = await adapter.judge(baseInput);
    const b = await adapter.judge(baseInput);
    expect(a).toEqual(b);
    expect(inner.calls).toBe(1);
    expect(budget.consumed).toBe(1);
  });

 test("不同 cacheKey 各自独立计费", async () => {
    const inner = makeInner(async () => []);
    const budget = new JudgeBudget(2);
    const adapter = new BudgetedSemanticJudgeAdapter({ inner, budget });
    await adapter.judge({ ...baseInput, cacheKey: "a" });
    await adapter.judge({ ...baseInput, cacheKey: "b" });
    expect(inner.calls).toBe(2);
    expect(budget.consumed).toBe(2);
  });
});

describe("BudgetedSemanticJudgeAdapter — budget exhaustion", () => {
 test("预算耗尽后返回 budget_exhausted finding，不再调用 inner", async () => {
    const inner = makeInner(async () => [
      { ruleId: "semantic.x", kind: "semantic", severity: "info", code: "ok", message: "" },
    ]);
    const budget = new JudgeBudget(1);
    const adapter = new BudgetedSemanticJudgeAdapter({ inner, budget });
    await adapter.judge({ ...baseInput, cacheKey: "k1" });
    const second = await adapter.judge({ ...baseInput, cacheKey: "k2" });
    expect(inner.calls).toBe(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.code).toBe("semantic.judge.budget_exhausted");
    expect(second[0]?.severity).toBe("info");
  });
});

describe("BudgetedSemanticJudgeAdapter — timeout fallback", () => {
 test("inner 超过 timeout 时返回 semantic.judge.timeout，severity=info", async () => {
    const inner = makeInner(
      () =>
        new Promise<readonly ValidationFinding[]>((resolve) => {
          setTimeout(() => resolve([]), 200);
        }),
    );
    const budget = new JudgeBudget(2);
    const adapter = new BudgetedSemanticJudgeAdapter({ inner, budget, timeoutMs: 20 });
    const findings = await adapter.judge(baseInput);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("semantic.judge.timeout");
    expect(findings[0]?.severity).toBe("info");
 // 超时仍记账：避免反复触发昂贵 fallback
    expect(budget.consumed).toBe(1);
  });

 test("inner throw 时返回 semantic.judge.error，severity=warning", async () => {
    const inner = makeInner(async () => {
      throw new Error("provider 500");
    });
    const budget = new JudgeBudget(2);
    const adapter = new BudgetedSemanticJudgeAdapter({ inner, budget, timeoutMs: 200 });
    const findings = await adapter.judge(baseInput);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("semantic.judge.error");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("provider 500");
  });
});

describe("BudgetedSemanticJudgeAdapter — LRU cache eviction", () => {
 test("超过 cacheCapacity 时最早条目被驱逐", async () => {
    const inner = makeInner(async () => []);
    const budget = new JudgeBudget(10);
    const adapter = new BudgetedSemanticJudgeAdapter({
      inner,
      budget,
      cacheCapacity: 2,
    });
    await adapter.judge({ ...baseInput, cacheKey: "k1" });
    await adapter.judge({ ...baseInput, cacheKey: "k2" });
    await adapter.judge({ ...baseInput, cacheKey: "k3" }); // evicts k1
    expect(inner.calls).toBe(3);
 // k3 仍在缓存
    await adapter.judge({ ...baseInput, cacheKey: "k3" });
    expect(inner.calls).toBe(3);
 // k1 被驱逐后再次查询应走 inner
    await adapter.judge({ ...baseInput, cacheKey: "k1" });
    expect(inner.calls).toBe(4);
  });
});
