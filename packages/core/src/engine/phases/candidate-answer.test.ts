import { describe, expect, test } from "bun:test";
import { InMemoryRuntimeState } from "../../modules/runtime-state";
import type { ProviderAdapter } from "../../modules/provider";
import type {
  AnyDescriptor,
  EngineConfig,
  ExecutionContext,
  InputEnvelope,
  IntentResult,
  Message,
  SkillDescriptor,
  StepStatus,
  ToolDescriptor,
} from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { createDefaultEngineConfig } from "../../utils";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";
import { resolveFinalAnswerSkills, runCandidateAnswerPhase } from "./candidate-answer";

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
  intent: IntentResult;
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
    precheck: { budget: { allowed: true } },
    planning: { plans: [{ rank: 1, tasks: [], edges: [] }] },
    graphCheck: { passed: true },
    steps: overrides.steps ?? [],
    taskResults: overrides.taskResults ?? {},
    taskErrors: {},
  } as unknown as ExecutionPhaseOutput;
};

describe("runCandidateAnswerPhase", () => {
 test("direct-answer 路径产出 candidateAnswer 且 claims 为空", async () => {
    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: { complexity: "simple", intent: "hi", contextRelevance: "unrelated" },
        taskResults: { "task-direct-answer": "你好" },
      }),
      buildEnv(),
    );
    expect(state.candidateAnswer.content).toBe("你好");
    expect(state.candidateAnswer.claims).toHaveLength(0);
    expect(state.candidateAnswer.producedBy).toBe("direct-answer");
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
      intent: { complexity: "complex", intent: "write a file", contextRelevance: "unrelated" },
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
      planning: {
        plans: [
          {
            rank: 1,
            tasks: [
              { id: "t-write", type: "tool", ref: "write-file", input: {} },
            ],
            edges: [],
          },
        ],
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
        intent: { complexity: "complex", intent: "fetch online doc", contextRelevance: "unrelated" },
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
      planning: {
        plans: [
          {
            rank: 1,
            tasks: [
              { id: "t-fetch", type: "tool", ref: "web-fetch", input: {} },
            ],
            edges: [],
          },
        ],
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
        intent: { complexity: "complex", intent: "delegate to agent", contextRelevance: "unrelated" },
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
        intent: { complexity: "simple", intent: "hi", contextRelevance: "unrelated" },
        taskResults: {},
      }),
      env,
    );
    expect(candidate.evidence).toEqual([]);
    expect(candidate.candidateAnswer.claims).toEqual([]);
  });

 test("tool-use 路径调用 final-answer LLM 并流式输出正文", async () => {
    const streamed: string[] = [];
    const adapter: ProviderAdapter = {
      id: "scripted",
      name: "scripted",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("streaming final-answer path should use chatStream");
      },
      async *chatStream() {
        yield { type: "text-delta", delta: "最终" };
        yield { type: "text-delta", delta: "答案" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        };
      },
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = true;
    env.providers = new Map([["scripted", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted", model: "scripted-final" }),
    } as never;
    env.onFinalAnswerDelta = (text) => streamed.push(text);

    const state = await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          complexity: "complex",
          intent: "summarise searched result",
          contextRelevance: "unrelated",
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

    expect(state.candidateAnswer.content).toBe("最终答案");
    expect(streamed).toEqual(["最终", "答案"]);
    expect(state.candidateAnswer.claims.length).toBeGreaterThan(0);
    expect(state.evidence).toHaveLength(1);
  });

 test("tool-use final-answer system prompt inherits Active Skills when provided", async () => {
    let capturedMessages: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: "scripted-skills",
      name: "scripted-skills",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("streaming final-answer path should use chatStream");
      },
      async *chatStream(input) {
        capturedMessages = input.messages;
        yield { type: "text-delta", delta: "done" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        };
      },
    };
    const mockSkill: SkillDescriptor = {
      kind: "skill",
      name: "mock-chart-output",
      description: "chart contract",
      instructions: "ECHARTS-FENCE-CONTRACT-XYZ",
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = true;
    env.providers = new Map([["scripted-skills", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted-skills", model: "scripted-skills-model" }),
    } as never;
    env.onFinalAnswerDelta = () => {};
    env.finalAnswerActiveSkills = [mockSkill];

    await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          complexity: "complex",
          intent: "chart summary",
          contextRelevance: "unrelated",
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [
              {
                source: "tool",
                tool: "web-search",
                callId: "call-1",
                text: "market data",
              },
            ],
          },
        },
      }),
      env,
    );

    const systemContent =
      typeof capturedMessages?.[0]?.content === "string"
        ? capturedMessages[0].content
        : "";
    expect(systemContent).toContain("## Active Skills");
    expect(systemContent).toContain("ECHARTS-FENCE-CONTRACT-XYZ");
    expect(systemContent).toContain("### mock-chart-output");
  });

 test("toolUse.finalAnswerSystemPromptBase 替换 final-answer system base", async () => {
    let capturedMessages: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: "scripted-custom-final-base",
      name: "scripted-custom-final-base",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("streaming final-answer path should use chatStream");
      },
      async *chatStream(input) {
        capturedMessages = input.messages;
        yield { type: "text-delta", delta: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = true;
    env.config.toolUse = {
      finalAnswerSystemPromptBase: "HOST-FINAL-ANSWER-BASE",
    };
    env.providers = new Map([["scripted-custom-final-base", adapter]]);
    env.modelRouter = {
      resolve: () => ({
        provider: "scripted-custom-final-base",
        model: "scripted-custom-final-base-model",
      }),
    } as never;
    env.onFinalAnswerDelta = () => {};

    await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          complexity: "complex",
          intent: "summarize page",
          contextRelevance: "unrelated",
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [
              {
                source: "tool",
                tool: "web-fetch",
                callId: "call-1",
                text: "page content",
              },
            ],
          },
        },
      }),
      env,
    );

    const systemContent =
      typeof capturedMessages?.[0]?.content === "string"
        ? capturedMessages[0].content
        : "";
    expect(systemContent.startsWith("HOST-FINAL-ANSWER-BASE")).toBe(true);
  });

 test("tool-use final-answer without active skills keeps legacy system prompt shape", async () => {
    let capturedMessages: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: "scripted-no-skills",
      name: "scripted-no-skills",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("streaming final-answer path should use chatStream");
      },
      async *chatStream(input) {
        capturedMessages = input.messages;
        yield { type: "text-delta", delta: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = true;
    env.providers = new Map([["scripted-no-skills", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted-no-skills", model: "scripted-no-skills-model" }),
    } as never;
    env.onFinalAnswerDelta = () => {};

    await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          complexity: "complex",
          intent: "summarise",
          contextRelevance: "unrelated",
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [],
          },
        },
      }),
      env,
    );

    const systemContent =
      typeof capturedMessages?.[0]?.content === "string"
        ? capturedMessages[0].content
        : "";
    expect(systemContent).toContain("You are the final answer writer for a tool-assisted task.");
    expect(systemContent).not.toContain("## Active Skills");
  });

 test("output-format-only scope filters skills and warns when none match", () => {
    const warnings: unknown[] = [];
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.finalAnswerSkillScope = "output-format-only";
    env.finalAnswerActiveSkills = [
      {
        kind: "skill",
        name: "workflow-skill",
        description: "workflow",
        instructions: "do workflow things",
      },
    ];
    env.observability = {
      emit(event: { type: string; payload?: unknown }) {
        if (event.type === "warning") {
          warnings.push(event.payload);
        }
      },
    } as never;

    const resolved = resolveFinalAnswerSkills(
      env,
      buildExecutionState({
        intent: { complexity: "complex", intent: "chart", contextRelevance: "unrelated" },
      }),
    );

    expect(resolved).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      purpose: "final-answer",
      scope: "output-format-only",
      activeSkillCount: 1,
    });
  });

 test("output-format-only scope keeps tagged output-format skills", () => {
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.finalAnswerSkillScope = "output-format-only";
    env.finalAnswerActiveSkills = [
      {
        kind: "skill",
        name: "chart-output",
        description: "charts",
        instructions: "use echarts fences",
        tags: ["output-format"],
      },
      {
        kind: "skill",
        name: "other",
        description: "other",
        instructions: "ignored",
      },
    ];

    const resolved = resolveFinalAnswerSkills(
      env,
      buildExecutionState({
        intent: { complexity: "complex", intent: "chart", contextRelevance: "unrelated" },
      }),
    );

    expect(resolved.map((skill) => skill.name)).toEqual(["chart-output"]);
  });

 test("chart-output pin adds echarts hard rules and ignores python terminal draft", async () => {
    let capturedMessages: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: "scripted-chart-output",
      name: "scripted-chart-output",
      async listAvailableModels() {
        return [];
      },
      async chat() {
        throw new Error("streaming final-answer path should use chatStream");
      },
      async *chatStream(input) {
        capturedMessages = input.messages;
        yield { type: "text-delta", delta: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        };
      },
    };
    const chartSkill: SkillDescriptor = {
      kind: "skill",
      name: "chart-output",
      description: "charts",
      instructions: "use echarts fences",
      tags: ["chart", "visualization"],
    };
    const env = buildEnv();
    env.config = createDefaultEngineConfig();
    env.config.runtime.streamingOutput = true;
    env.providers = new Map([["scripted-chart-output", adapter]]);
    env.modelRouter = {
      resolve: () => ({ provider: "scripted-chart-output", model: "scripted-chart-output-model" }),
    } as never;
    env.onFinalAnswerDelta = () => {};
    env.finalAnswerActiveSkills = [chartSkill];

    await runCandidateAnswerPhase(
      buildExecutionState({
        intent: {
          complexity: "complex",
          intent: "用图表总结科技股",
          contextRelevance: "unrelated",
        },
        taskResults: {
          "task-tool-use": {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [
              {
                source: "tool",
                tool: "mcp.web-search.web_search",
                callId: "call-1",
                text: "market data",
              },
            ],
            terminalDraft: "```python\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\n```",
          },
        },
      }),
      env,
    );

    const systemContent =
      typeof capturedMessages?.[0]?.content === "string"
        ? capturedMessages[0].content
        : "";
    const userContent =
      typeof capturedMessages?.[1]?.content === "string"
        ? capturedMessages[1].content
        : "";
    expect(systemContent).toContain("Chart Output Requirements (mandatory)");
    expect(systemContent).toContain("Do NOT output `python`");
    expect(systemContent).toContain("### chart-output");
    expect(userContent).toContain("ignore that draft");
    expect(userContent).toContain("matplotlib");
  });
});
