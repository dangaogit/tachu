import { describe, expect, test } from "bun:test";

import { DefaultContextBudgetBroker } from "./broker";

describe("DefaultContextBudgetBroker", () => {
 test("uses provider/model capability as the hard cap and reserves output tokens", () => {
    const broker = new DefaultContextBudgetBroker();
    const result = broker.decide({
      phase: "planning",
      scope: "main-agent",
      purpose: "assemble main prompt",
      model: "small-model",
      modelMaxContextTokens: 4_096,
      configuredMaxContextTokens: 128_000,
      estimatedInputTokens: 2_000,
      reserveOutputTokens: 512,
      inputShape: "text",
      policy: {},
    });

    expect(result.kind).toBe("fit");
    if (result.kind !== "fit") {
      throw new Error("expected fit decision");
    }
    expect(result.envelope.maxInputTokens).toBe(3_584);
    expect(result.envelope.audit.maxContextTokens).toBe(4_096);
    expect(result.envelope.audit.appliedActions).toEqual([]);
  });

 test("returns trim outcome with partial-context risk when input exceeds envelope but trimming is allowed", () => {
    const broker = new DefaultContextBudgetBroker();
    const result = broker.decide({
      phase: "output",
      scope: "tool-use-loop",
      purpose: "summarize observations",
      model: "small-model",
      modelMaxContextTokens: 2_048,
      configuredMaxContextTokens: 128_000,
      estimatedInputTokens: 4_000,
      reserveOutputTokens: 256,
      inputShape: "tool-observations",
      policy: { trimAllowed: true },
    });

    expect(result.kind).toBe("trim");
    if (result.kind !== "trim") {
      throw new Error("expected trim decision");
    }
    expect(result.envelope.maxInputTokens).toBe(1_792);
    expect(result.envelope.audit.risk).toBe("partial-context");
    expect(result.envelope.audit.appliedActions).toContain("trim");
  });

 test("rejects oversized current input when trim, chunk, and degrade are disallowed", () => {
    const broker = new DefaultContextBudgetBroker();
    const result = broker.decide({
      phase: "intent",
      scope: "intent",
      purpose: "classify request",
      model: "tiny-model",
      modelMaxContextTokens: 1_024,
      configuredMaxContextTokens: 1_024,
      estimatedInputTokens: 5_000,
      reserveOutputTokens: 128,
      inputShape: "text",
      policy: {
        trimAllowed: false,
        chunkingAllowed: false,
        degradeAllowed: false,
      },
    });

    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") {
      throw new Error("expected reject decision");
    }
    expect(result.reason).toContain("exceeds");
  });

 // P2 β：8 个 ContextScope 全部必须返回非空、非默认的 trimOrder。
 // 通过 trim 决策路径间接断言（envelope.trimOrder = trimOrderFor(scope)）。
  test("trimOrderFor exhaustively covers every ContextScope without falling back to default", () => {
    const broker = new DefaultContextBudgetBroker();
    const scopes = [
      "intent",
      "main-agent",
      "tool-use-loop",
      "fallback-summary",
      "validation",
      "memory-compression",
      "sub-agent",
      "fan-in-synthesis",
    ] as const;
    for (const scope of scopes) {
      const result = broker.decide({
        phase: "planning",
        scope,
        purpose: `assert ${scope}`,
        model: "test-model",
        modelMaxContextTokens: 8_000,
        configuredMaxContextTokens: 8_000,
        estimatedInputTokens: 12_000,
        reserveOutputTokens: 512,
        inputShape: "text",
        policy: { trimAllowed: true },
      });
      if (result.kind !== "trim") {
        throw new Error(`expected trim decision for scope=${scope}, got ${result.kind}`);
      }
      expect(result.envelope.trimOrder.length).toBeGreaterThan(0);
 // 反退化：默认 fallback 是 ["history", "memory"]；除非 scope 显式映射为该序列，
 // 否则不应出现该精确序列（intent/main-agent 等不应等价于通用 fallback）。
      const isFallback =
        result.envelope.trimOrder.length === 2 &&
        result.envelope.trimOrder[0] === "history" &&
        result.envelope.trimOrder[1] === "memory";
      expect(isFallback).toBe(false);
    }
  });
});
