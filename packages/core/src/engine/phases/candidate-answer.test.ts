import { describe, expect, test } from "bun:test";
import { InMemoryRuntimeState } from "../../modules/runtime-state";
import type { ProviderAdapter } from "../../modules/provider";
import type {
  AnyDescriptor,
  EngineConfig,
  ExecutionContext,
  InputEnvelope,
  StepStatus,
  ToolDescriptor,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { createDefaultEngineConfig } from "../../utils";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";
import { runCandidateAnswerPhase } from "./candidate-answer";

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

const buildExecutionState = (overrides: {
  intent: { intent: string };
  taskResults?: Record<string, unknown>;
  steps?: StepStatus[];
}): ExecutionPhaseOutput => {
  const input: InputEnvelope = {
    content: "noop",
    metadata: { modality: "text", size: 4 },
  };
  const context: ExecutionContext = {
    correlation: {
      traceId: "t-candidate",
      requestId: "r-candidate",
      sessionId: "s-candidate",
      turnId: "turn-r-candidate",
    },
    principal: {},
    budget: { maxTokens: 1_000, maxDurationMs: 3_000 },
    scopes: ["*"],
  };
  return {
    input,
    context,
    violations: [],
    intent: overrides.intent,
    route: { tasks: [], edges: [] },
    steps: overrides.steps ?? [],
    taskResults: overrides.taskResults ?? {},
    taskErrors: {},
  } as unknown as ExecutionPhaseOutput;
};

describe("runCandidateAnswerPhase", () => {
 test("无 tool-use / agent 结果时 candidateAnswer 退化为空内容(ADR-0006 C1:direct-answer 已删除)", async () => {
    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "hi" },
        taskResults: {},
      }),
      buildEnv(),
    );
    expect(state.candidateAnswer.content).toBe("");
    expect(state.candidateAnswer.claims).toHaveLength(0);
    expect(state.candidateAnswer.producedBy).toBe("execution");
  });

 test("matrix: 当 plan 含 write descriptor 时 collectEvidence 产出 file-changed claim（不依赖关键词匹配）", async () => {
    const writeDescriptor: ToolDescriptor = {
      name: "write-file",
      kind: "tool",
      version: "1",
      description: "",
      sideEffect: "write",
      idempotent: false,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: {},
      execute: "noop",
    };
    const adapter: ProviderAdapter = {
      id: "scripted-bl006",
      name: "scripted-bl006",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        return {
          content: "已写入指定文件。",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        } as never;
      },
      async *chatStream() {
        throw new Error("non-streaming path expected");
      },
    };

    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = false;
    env.providers = new Map([["scripted-bl006", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted-bl006", model: "scripted-bl006-model" }),
    } as never;
    env.registry = {
      get: (_kind: string, ref: string): AnyDescriptor | undefined =>
        ref === "write-file" ? writeDescriptor : undefined,
    } as unknown as PhaseEnvironment["registry"];

    const baseState = buildExecutionState({
      intent: { intent: "write a file" },
      taskResults: {
        "task-tool-use": {
          kind: "tool-use-result",
          status: "ready_for_output",
          steps: [],
          observations: [
            { source: "tool", tool: "write-file", callId: "w1", text: "wrote 42 bytes" },
          ],
        },
      },
      steps: [{ name: "t-write", status: "completed" }],
    });
    const stateWithPlan = {
      ...baseState,
      route: {
        tasks: [
          { id: "t-write", type: "tool", ref: "write-file", input: {} },
        ],
        edges: [],
      },
    } as unknown as ExecutionPhaseOutput;

    const candidate = await runCandidateAnswerPhase(stateWithPlan, env);
    const fileWrite = candidate.evidence.find((entry) => entry.recordType === "file-write");
    expect(fileWrite).toBeDefined();
    expect(fileWrite?.source).toBe("write-file:w1");
    const fileChanged = candidate.candidateAnswer.claims.find(
      (claim) => claim.kind === "file-changed",
    );
    expect(fileChanged).toBeDefined();
    expect(fileChanged?.requiredEvidence).toBe("same-source");
    expect(fileChanged?.sourceRef).toBe("write-file:w1");
  });

 test("matrix: 当 plan 含 external descriptor 时 collectEvidence 产出 external-fact claim", async () => {
    const externalDescriptor: ToolDescriptor = {
      name: "web-fetch",
      kind: "tool",
      version: "1",
      description: "",
      sideEffect: "readonly",
      idempotent: true,
      requiresApproval: false,
      timeout: 1_000,
      inputSchema: {},
      execute: "noop",
      dataSource: "external",
    };
    const adapter: ProviderAdapter = {
      id: "scripted-ext",
      name: "scripted-ext",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        return {
          content: "已获取在线文档。",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        } as never;
      },
      async *chatStream() {
        throw new Error("non-streaming path expected");
      },
    };

    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = false;
    env.providers = new Map([["scripted-ext", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted-ext", model: "scripted-ext-model" }),
    } as never;
    env.registry = {
      get: (_kind: string, ref: string): AnyDescriptor | undefined =>
        ref === "web-fetch" ? externalDescriptor : undefined,
    } as unknown as PhaseEnvironment["registry"];

    const stateWithPlan = {
      ...buildExecutionState({
        intent: { intent: "fetch online doc" },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [
              {
                source: "tool",
                tool: "web-fetch",
                callId: "f1",
                text: "https://example.com snapshot",
              },
            ],
          },
        },
        steps: [{ name: "t-fetch", status: "completed" }],
      }),
      route: {
        tasks: [
          { id: "t-fetch", type: "tool", ref: "web-fetch", input: {} },
        ],
        edges: [],
      },
    } as unknown as ExecutionPhaseOutput;

    const candidate = await runCandidateAnswerPhase(stateWithPlan, env);
    const external = candidate.evidence.find((entry) => entry.recordType === "external-source");
    expect(external).toBeDefined();
    expect(external?.purpose).toBe("claim-support");
    const externalClaim = candidate.candidateAnswer.claims.find(
      (claim) => claim.kind === "external-fact",
    );
    expect(externalClaim).toBeDefined();
    expect(externalClaim?.requiredEvidence).toBe("same-source");
    expect(externalClaim?.sourceRef).toBe("web-fetch:f1");
  });

 test("matrix: agent evidence 通道仍走 source-derived(any)", async () => {
    const env = buildEnv();
    const candidate = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "delegate to agent" },
        taskResults: {
          "task-agent-1": {
            kind: "agent-run-result",
            agent: "analyst",
            status: "completed",
            output: "agent finished",
            evidence: [
              {
                source: "agent:analyst:r1",
                content: "agent text",
                producedBy: "agent-runtime",
                purpose: "execution-observation",
              },
            ],
          },
        },
      }),
      env,
    );
    const agentEv = candidate.evidence.find((entry) => entry.recordType === "agent-run");
    expect(agentEv).toBeDefined();
    const sourceDerived = candidate.candidateAnswer.claims.find(
      (claim) => claim.kind === "source-derived" && claim.producedBy === "agent-runtime",
    );
    expect(sourceDerived).toBeDefined();
    expect(sourceDerived?.requiredEvidence).toBe("any");
  });

 test("matrix: 无执行 evidence 时 candidateAnswer.claims 也为空（no evidence → no claims）", async () => {
    const env = buildEnv();
    const candidate = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "hi" },
        taskResults: {},
      }),
      env,
    );
    expect(candidate.evidence).toEqual([]);
    expect(candidate.candidateAnswer.claims).toEqual([]);
  });

 test("tool-use ready_for_output：terminalDraft 直接作为 candidateAnswer.content，不发起 LLM 调用（ADR-0006 D4/C3）", async () => {
    const adapter: ProviderAdapter = {
      id: "must-not-be-called",
      name: "must-not-be-called",
      async listAvailableModels() {
        return [];
      },
      async chat(): Promise<never> {
        throw new Error("candidate-answer must not call an LLM for the tool-use path");
      },
      async *chatStream(): AsyncGenerator<never> {
        throw new Error("candidate-answer must not call an LLM for the tool-use path");
      },
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.providers = new Map([["must-not-be-called", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "must-not-be-called", model: "n/a" }),
    } as never;

    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          intent: "summarise searched result",
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [{ step: 1, modelNotes: "我查一下", toolCalls: [] }],
            observations: [
              {
                source: "tool",
                tool: "mcp.web-search.web_search",
                callId: "call-1",
                text: "raw search output",
              },
            ],
            terminalDraft: "过程草稿",
          },
        },
      }),
      env,
    );

    expect(state.candidateAnswer.content).toBe("过程草稿");
    expect(state.candidateAnswer.producedBy).toBe("tool-use");
    expect(state.candidateAnswer.claims.length).toBeGreaterThan(0);
    expect(state.evidence).toHaveLength(1);
  });

 test("tool-use ready_for_output 但 terminalDraft 为空 → candidateAnswer.content 为空（不捏造兜底文案）", async () => {
    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "no draft" },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [],
          },
        },
      }),
      buildEnv(),
    );
    expect(state.candidateAnswer.content).toBe("");
    expect(state.candidateAnswer.producedBy).toBe("tool-use");
  });

 test("tool-use status=partial → candidateAnswer.content 为空，不软性捏造叙述兜底（可恢复路由留给 turnStop seam）", async () => {
    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "partial fetch" },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "partial",
            steps: [],
            observations: [
              { source: "tool", tool: "web-fetch", callId: "f1", text: "partial content" },
            ],
            error: { code: "TOOL_LOOP_EMPTY_TERMINAL_RESPONSE", message: "empty terminal", retryable: true },
          },
        },
      }),
      buildEnv(),
    );
    expect(state.candidateAnswer.content).toBe("");
    expect(state.candidateAnswer.content).not.toContain("partial content");
    expect(state.candidateAnswer.producedBy).toBe("tool-use");
 // evidence/claims 仍从 observations 派生，只是不合成叙述性正文。
    expect(state.evidence).toHaveLength(1);
  });

 test("tool-use status=exhausted → candidateAnswer.content 同样为空（诚实报错留给 Output fallback 模板）", async () => {
    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { intent: "long research" },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "exhausted",
            steps: [],
            observations: [
              { source: "tool", tool: "web-search", callId: "s1", text: "some findings" },
            ],
            error: { code: "TOOL_LOOP_STEPS_EXHAUSTED", message: "steps exhausted", retryable: false },
          },
        },
      }),
      buildEnv(),
    );
    expect(state.candidateAnswer.content).toBe("");
  });
});
