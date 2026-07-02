import { describe, expect, test } from "bun:test";

import {
  ValidationRuleRegistry,
  buildDefaultValidationRuleRegistry,
} from "./index";
import type { ValidationRule } from "./registry";
import type { ExecutionPhaseOutput } from "../execution";
import type { ExecutionRoute, ToolUseResult } from "../../../types";

const baseState = (
  overrides: Partial<ExecutionPhaseOutput> = {},
): ExecutionPhaseOutput =>
  ({
    steps: [],
    taskResults: {},
    taskErrors: {},
    ...overrides,
  }) as ExecutionPhaseOutput;

const baseRoute: ExecutionRoute = {
  tasks: [{ id: "task-a", type: "tool", ref: "run-tests", input: {} }],
  edges: [],
};

const ruleCtx = (overrides: {
  state?: Partial<ExecutionPhaseOutput>;
  route?: ExecutionRoute;
  registry?: unknown;
  evidence?: readonly [];
  candidateAnswer?: import("../../../types/evidence").CandidateAnswer;
} = {}) => ({
  state: baseState(overrides.state),
  route: overrides.route ?? baseRoute,
  registry: (overrides.registry ?? {}) as never,
  evidence: overrides.evidence ?? [],
  ...(overrides.candidateAnswer !== undefined
    ? { candidateAnswer: overrides.candidateAnswer }
    : {}),
});

describe("ValidationRuleRegistry", () => {
 test("register/has/list/unregister observe insertion order", () => {
    const r = new ValidationRuleRegistry();
    const ruleA: ValidationRule = { id: "a", kind: "deterministic", evaluate: () => [] };
    const ruleB: ValidationRule = { id: "b", kind: "deterministic", evaluate: () => [] };
    r.register(ruleA);
    r.register(ruleB);
    expect(r.has("a")).toBe(true);
    expect(r.list().map((rule) => rule.id)).toEqual(["a", "b"]);
    expect(r.unregister("a")).toBe(true);
    expect(r.unregister("a")).toBe(false);
    expect(r.list().map((rule) => rule.id)).toEqual(["b"]);
  });

 test("same id re-register replaces in place", () => {
    const r = new ValidationRuleRegistry();
    const v1: ValidationRule = {
      id: "x",
      kind: "deterministic",
      evaluate: () => [
        { ruleId: "x", kind: "deterministic", severity: "info", code: "v1", message: "v1" },
      ],
    };
    const v2: ValidationRule = {
      id: "x",
      kind: "deterministic",
      evaluate: () => [
        { ruleId: "x", kind: "deterministic", severity: "info", code: "v2", message: "v2" },
      ],
    };
    r.register(v1);
    r.register(v2);
    const findings = r.evaluateAll(ruleCtx());
    expect(findings.map((f) => f.code)).toEqual(["v2"]);
  });

 test("appliesTo gate skips evaluate", () => {
    let evaluated = 0;
    const r = new ValidationRuleRegistry();
    r.register({
      id: "gated",
      kind: "deterministic",
      appliesTo: () => false,
      evaluate: () => {
        evaluated += 1;
        return [];
      },
    });
    r.evaluateAll(ruleCtx());
    expect(evaluated).toBe(0);
  });

 test("buildDefaultValidationRuleRegistry yields five deterministic rules in documented order ( P-补丁)", () => {
    const r = buildDefaultValidationRuleRegistry();
    expect(r.list().map((rule) => ({ id: rule.id, kind: rule.kind }))).toEqual([
      { id: "deterministic.execution.steps", kind: "deterministic" },
      { id: "deterministic.tool-use.status", kind: "deterministic" },
      { id: "deterministic.output.schema", kind: "deterministic" },
      { id: "deterministic.output.length-budget", kind: "deterministic" },
      { id: "deterministic.evidence.required", kind: "deterministic" },
    ]);
  });

 test("execution-failed rule emits structured finding with retryable propagation", () => {
    const r = buildDefaultValidationRuleRegistry();
    const findings = r.evaluateAll(
      ruleCtx({
        state: {
          steps: [
            { name: "task-a", status: "failed", reason: "boom" },
            { name: "task-b", status: "completed" },
          ],
          taskErrors: {
            "task-a": {
              code: "PROVIDER_UPSTREAM_ERROR",
              message: "upstream failed",
              retryable: true,
              source: "provider",
            },
          },
        },
      }),
    );
    const exec = findings.find((f) => f.code === "execution_failed");
    expect(exec).toBeDefined();
    expect(exec).toMatchObject({
      ruleId: "deterministic.execution.steps",
      severity: "error",
      retryable: true,
    });
 // user-visible message must not leak internal task ids
    expect(exec?.userVisibleMessage).not.toContain("task-a");
    expect(exec?.userVisibleMessage).not.toContain("task-b");
  });

 test("tool-use-partial rule fires only on non-ready tool-use-result", () => {
    const partial: ToolUseResult = {
      kind: "tool-use-result",
      status: "partial",
      steps: [],
      observations: [],
      error: { code: "TOOL_LOOP_PARTIAL", message: "x", retryable: false },
    };
    const ready: ToolUseResult = {
      kind: "tool-use-result",
      status: "ready_for_output",
      steps: [],
      observations: [],
    };
    const r = buildDefaultValidationRuleRegistry();
    const findings = r.evaluateAll(
      ruleCtx({
        state: {
          steps: [
            { name: "tu-partial", status: "completed" },
            { name: "tu-ready", status: "completed" },
          ],
          taskResults: { "tu-partial": partial, "tu-ready": ready },
        },
      }),
    );
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("tool_use_partial");
    expect(codes.filter((c) => c === "tool_use_partial").length).toBe(1);
  });

 test(" P1 ε: structured-output rule fires when task result violates descriptor.outputSchema", () => {
    const r = buildDefaultValidationRuleRegistry();
    const mockRegistry = {
      getLatest: (_kind: string, name: string) => {
        if (name !== "run-tests") return null;
        return {
          kind: "tool" as const,
          name,
          outputSchema: { type: "object", required: ["passed"] },
        };
      },
    };
    const findings = r.evaluateAll(
      ruleCtx({
        state: {
          steps: [{ name: "task-a", status: "completed" }],
          taskResults: { "task-a": { failed: 3 } },
        },
        registry: mockRegistry,
      }),
    );
    const violation = findings.find((f) => f.code === "structured_output_violation");
    expect(violation).toBeDefined();
    expect(violation?.severity).toBe("error");
    expect(violation?.retryable).toBe(true);
    expect(violation?.message).toContain("passed");
  });

 test(" P1 ε: structured-output rule passes when result matches schema", () => {
    const r = buildDefaultValidationRuleRegistry();
    const mockRegistry = {
      getLatest: (_kind: string, name: string) =>
        name === "run-tests"
          ? { kind: "tool" as const, name, outputSchema: { type: "object", required: ["passed"] } }
          : null,
    };
    const findings = r.evaluateAll(
      ruleCtx({
        state: {
          steps: [{ name: "task-a", status: "completed" }],
          taskResults: { "task-a": { passed: true } },
        },
        registry: mockRegistry,
      }),
    );
    expect(findings.find((f) => f.code === "structured_output_violation")).toBeUndefined();
  });

 test(" P1 ε: length-budget rule no-ops when budget unconfigured", () => {
    const r = buildDefaultValidationRuleRegistry();
    const huge = "x".repeat(10_000);
    const findings = r.evaluateAll(
      ruleCtx({
        state: {
          steps: [{ name: "task-a", status: "completed" }],
          taskResults: { "task-a": huge },
        },
        registry: { getLatest: () => null },
      }),
    );
    expect(findings.find((f) => f.code === "length_budget_exceeded")).toBeUndefined();
  });

 test(" P1 ε: length-budget rule emits warning when configured threshold exceeded", () => {
    const r = buildDefaultValidationRuleRegistry();
    const huge = "x".repeat(10_000);
    const state = baseState({
      steps: [{ name: "task-a", status: "completed" }],
      taskResults: { "task-a": huge },
    });
    (state as unknown as { validationConfig: { outputBudget: { maxChars: number } } }).validationConfig = {
      outputBudget: { maxChars: 100 },
    };
    const findings = r.evaluateAll(
      ruleCtx({
        state,
        registry: { getLatest: () => null },
      }),
    );
    const finding = findings.find((f) => f.code === "length_budget_exceeded");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.retryable).toBe(false);
  });
});
