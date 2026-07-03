import { describe, expect, test } from "bun:test";

import { InMemoryRuntimeState } from "../../modules/runtime-state";
import { DefaultHookRegistry } from "../../modules/hooks";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import type {
  EngineConfig,
  ExecutionContext,
  ExecutionRoute,
  InputEnvelope,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import type { ExecutionPhaseOutput } from "./execution";
import type { CandidateAnswerPhaseOutput } from "./candidate-answer";
import type { PhaseEnvironment } from "./index";
import { runValidationPhase } from "./validation";
import { ValidationRuleRegistry } from "./validation";

const buildEnv = (): PhaseEnvironment =>
  ({
    config: {} as EngineConfig,
    registry: {} as never,
    sessionManager: {} as never,
    memorySystem: {} as never,
    runtimeState: new InMemoryRuntimeState(),
    modelRouter: {} as never,
    providers: new Map(),
    safetyModule: {} as never,
    observability: { emit() {} } as never,
    hooks: {} as never,
    scheduler: {} as never,
    activeAbortSignal: new AbortController().signal,
    adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
  }) satisfies PhaseEnvironment;

const context: ExecutionContext = {
  correlation: {
    traceId: "trace-validation",
    requestId: "request-validation",
    sessionId: "session-validation",
    turnId: "turn-validation",
  },
  principal: {},
  budget: {},
  scopes: ["*"],
};

const input: InputEnvelope = {
  content: "please run checks",
  metadata: { modality: "text", size: 17 },
};

const intent = { intent: "run checks" };

const route: ExecutionRoute = {
  tasks: [{ id: "task-a", type: "tool", ref: "run-tests", input: {} }],
  edges: [],
};

const buildState = (
  overrides: Partial<ExecutionPhaseOutput>,
): CandidateAnswerPhaseOutput =>
  ({
    input,
    context,
    violations: [],
    intent,
    route,
    steps: [],
    taskResults: {},
    taskErrors: {},
    evidence: [],
    candidateAnswer: {
      content: "",
      producedBy: "execution",
      claims: [],
      evidence: [],
    },
    ...overrides,
  }) as CandidateAnswerPhaseOutput;

describe("runValidationPhase", () => {
 test("returns pass outcome when execution has no failed or partial signals", async () => {
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      buildEnv(),
    );

    expect(result.validation.passed).toBe(true);
    expect(result.validation.outcome).toEqual({ kind: "pass" });
    expect(result.validation.findings).toEqual([]);
  });

 test("retryable task failures become retry outcome without leaking task ids into user reason", async () => {
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "failed", reason: "ECONNRESET task-a" }],
        taskErrors: {
          "task-a": {
            code: "PROVIDER_UPSTREAM_ERROR",
            message: "upstream failed",
            retryable: true,
            source: "provider",
          },
        },
      }),
      buildEnv(),
    );

    expect(result.validation.passed).toBe(false);
    expect(result.validation.diagnosis?.reason).toBe("执行过程中有 1 个步骤未成功完成");
    expect(result.validation.diagnosis?.failedTaskIds).toEqual(["task-a"]);
    expect(result.validation.outcome).toMatchObject({
      kind: "retry",
      target: "retry-turn",
    });
    expect(result.validation.findings?.[0]).toMatchObject({
      code: "execution_failed",
      severity: "error",
      retryable: true,
    });
  });

 test("partial tool-use result degrades instead of claiming completed", async () => {
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-tool-use", status: "completed" }],
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "partial",
            steps: [],
            observations: [],
            error: {
              code: "TOOL_LOOP_PARTIAL",
              message: "some tools failed",
              retryable: false,
            },
          },
        },
      }),
      buildEnv(),
    );

    expect(result.validation.passed).toBe(false);
    expect(result.validation.outcome).toMatchObject({
      kind: "degrade",
      userVisibleReason: expect.stringContaining("部分"),
    });
    expect(result.validation.findings?.[0]).toMatchObject({
      code: "tool_use_partial",
      severity: "error",
    });
  });

 test("hasFileWrites is descriptor-driven, NOT regex on step.name (audit anti-pattern fix)", async () => {
 // A step whose name *contains* the historical regex keywords MUST NOT
 // trigger hasFileWrites if the underlying tool descriptor declares
 // sideEffect === "readonly".
    const env = buildEnv();
    (env as { registry: unknown }).registry = {
      get: (kind: string, ref: string) => {
        if (kind === "tool" && ref === "edit-readonly") {
          return { kind: "tool", sideEffect: "readonly" };
        }
        return undefined;
      },
    };
    const result = await runValidationPhase(
      buildState({
        route: {
          tasks: [{ id: "edit-step", type: "tool", ref: "edit-readonly", input: {} }],
          edges: [],
        },
        steps: [{ name: "edit-step", status: "completed" }],
        taskResults: { "edit-step": "ok" },
      }),
      env,
    );
    expect(result.validation.signals?.hasFileWrites).toBe(false);
  });

 test("hasFileWrites is true when descriptor declares sideEffect=write", async () => {
    const env = buildEnv();
    (env as { registry: unknown }).registry = {
      get: (kind: string, ref: string) => {
        if (kind === "tool" && ref === "writer") {
          return { kind: "tool", sideEffect: "write" };
        }
        return undefined;
      },
    };
    const result = await runValidationPhase(
      buildState({
        route: {
          tasks: [{ id: "innocuous-name", type: "tool", ref: "writer", input: {} }],
          edges: [],
        },
        steps: [{ name: "innocuous-name", status: "completed" }],
        taskResults: { "innocuous-name": "ok" },
      }),
      env,
    );
    expect(result.validation.signals?.hasFileWrites).toBe(true);
  });

 test("policyMode reflects engine config (not hardcoded deterministic-only)", async () => {
    const env = buildEnv();
    (env.config as { validation?: { policyMode?: string } }).validation = {
      policyMode: "auto",
    };
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
    );
    expect(result.validation.signals?.policyMode).toBe("auto");
  });

 test("P1 β — semantic judge is NOT invoked when policyMode === 'deterministic-only'", async () => {
    const env = buildEnv();
    (env.config as { validation?: { policyMode?: string } }).validation = {
      policyMode: "deterministic-only",
    };
    let calls = 0;
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
      undefined,
      {
        judge: async () => {
          calls += 1;
          return [];
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.validation.outcome?.kind).toBe("pass");
  });

 test("P1 β — semantic judge IS invoked when policyMode === 'always'", async () => {
    const env = buildEnv();
    (env.config as { validation?: { policyMode?: string } }).validation = {
      policyMode: "always",
    };
    let calls = 0;
    await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
      undefined,
      {
        judge: async () => {
          calls += 1;
          return [];
        },
      },
    );
    expect(calls).toBe(1);
  });

 test("P1 β — judge timeout returns info finding but does NOT fail the turn", async () => {
    const env = buildEnv();
    (env.config as {
      validation?: { policyMode?: string; semanticJudge?: { timeoutMs?: number } };
    }).validation = {
      policyMode: "always",
      semanticJudge: { timeoutMs: 10 },
    };
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
      undefined,
      {
        judge: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve([]), 100);
          }),
      },
    );
    expect(result.validation.outcome?.kind).toBe("pass");
    expect(result.validation.passed).toBe(true);
    expect(result.validation.findings?.some((f) => f.code === "semantic.judge.timeout")).toBe(true);
  });

 test("P1 β — judge can promote outcome to degrade via error finding", async () => {
    const env = buildEnv();
    (env.config as { validation?: { policyMode?: string } }).validation = {
      policyMode: "always",
    };
    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
      undefined,
      {
        judge: async () => [
          {
            ruleId: "semantic.claim.support",
            kind: "semantic" as const,
            severity: "error" as const,
            code: "claim_unsupported",
            message: "claim X has no supporting evidence",
            userVisibleMessage: "本次回答涉及无法核实的主张",
          },
        ],
      },
    );
    expect(result.validation.outcome).toMatchObject({
      kind: "degrade",
      reason: "claim_unsupported",
    });
    expect(result.validation.passed).toBe(false);
  });

  test("turnStop finding hooks surface deterministic and semantic findings with the same outcome reducer", async () => {
    const env = buildEnv();
    const hooks = new DefaultHookRegistry(new DefaultObservabilityEmitter());
    hooks.register("turnStop", async () => ({
      type: "finding",
      findings: [
        {
          ruleId: "deterministic.test.warning",
          kind: "deterministic",
          severity: "warning",
          code: "deterministic_warning",
          message: "deterministic warning",
        },
      ],
    }));
    hooks.register("turnStop", async () => ({
      type: "finding",
      findings: [
        {
          ruleId: "semantic.test.error",
          kind: "semantic",
          severity: "error",
          code: "semantic_error",
          message: "semantic error",
          userVisibleMessage: "semantic degraded",
        },
      ],
    }));
    (env as unknown as { hooks: DefaultHookRegistry }).hooks = hooks;

    const result = await runValidationPhase(
      buildState({
        steps: [{ name: "task-a", status: "completed" }],
        taskResults: { "task-a": "ok" },
      }),
      env,
      new ValidationRuleRegistry(),
    );

    expect(result.validation.findings?.map((finding) => finding.kind)).toEqual([
      "deterministic",
      "semantic",
    ]);
    expect(result.validation.outcome).toEqual({
      kind: "degrade",
      reason: "semantic_error",
      userVisibleReason: "semantic degraded",
    });
  });
});
