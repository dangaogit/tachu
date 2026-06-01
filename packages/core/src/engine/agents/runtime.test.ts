import { describe, expect, test } from "bun:test";

import type { ProviderAdapter } from "../../modules/provider";
import type { AgentDescriptor, ExecutionContext } from "../../types";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { DefaultAgentRuntimeAdapter } from "./runtime";

const agent: AgentDescriptor = {
  kind: "agent",
  name: "reviewer",
  description: "Reviews a scoped result",
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 5_000,
  maxDepth: 1,
  availableTools: ["read-file"],
  instructions: "Return a concise review.",
};

const context: ExecutionContext = {
  correlation: {
    traceId: "trace-agent",
    requestId: "request-agent",
    sessionId: "session-agent",
    turnId: "turn-agent",
  },
  principal: {},
  budget: {},
  scopes: ["*"],
};

describe("DefaultAgentRuntimeAdapter", () => {
 test("runs an agent with a scoped context envelope and returns structured evidence", async () => {
    const seenMessages: string[] = [];
    const provider: ProviderAdapter = {
      id: "scripted",
      name: "Scripted",
      async listAvailableModels() {
        return [
          {
            modelName: "agent-model",
            capabilities: {
              supportedModalities: ["text"],
              maxContextTokens: 8_192,
              supportsStreaming: false,
              supportsFunctionCalling: false,
            },
          },
        ];
      },
      async chat(req) {
        seenMessages.push(req.messages.map((m) => String(m.content)).join("\n"));
        return {
          content: "Reviewed scoped objective only.",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
      async *chatStream() {
        yield { type: "text-delta", delta: "Reviewed scoped objective only." };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map([[provider.id, provider]]),
      route: { provider: "scripted", model: "agent-model" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    });

    const result = await runtime.run(
      {
        id: "invoke-1",
        agent,
        objective: "Review design docs only",
        input: { prompt: "Do not inspect unrelated files" },
        context: {
          scope: "sub-agent",
          parentTraceId: "trace-agent",
          inherited: { tools: ["read-file"], memory: "none" },
          budget: {
            maxInputTokens: 1_000,
            maxWorkingTokens: 1_000,
            maxOutputTokens: 500,
          },
        },
        constraints: { maxDepth: 1, timeoutMs: 5_000, allowedTools: ["read-file"] },
      },
      context,
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      throw new Error("expected completed agent result");
    }
    expect(result.output).toBe("Reviewed scoped objective only.");
    expect(result.evidence?.[0]).toMatchObject({
      source: "agent-run:invoke-1",
      producedBy: "agent-runtime",
      purpose: "execution-observation",
      agentRunId: "invoke-1",
      content: {
        agent: "reviewer",
        provider: "scripted",
        model: "agent-model",
        objective: "Review design docs only",
      },
    });
    expect(seenMessages.join("\n")).toContain("Review design docs only");
    expect(seenMessages.join("\n")).toContain("Allowed tools: read-file");
  });

 test("renders structured context envelope without JSON.stringify dumping", async () => {
    let lastPrompt = "";
    const provider: ProviderAdapter = {
      id: "scripted",
      name: "Scripted",
      async listAvailableModels() {
        return [];
      },
      async chat(req) {
        lastPrompt = req.messages.map((m) => String(m.content)).join("\n");
        return {
          content: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      async *chatStream() {
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map([[provider.id, provider]]),
      route: { provider: "scripted", model: "agent-model" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    });

    await runtime.run(
      {
        id: "invoke-structured",
        agent,
        objective: "Inspect",
        input: {},
        context: {
          scope: "sub-agent",
          parentTraceId: "trace-agent",
          inherited: {
            tools: ["read-file"],
            memory: "task-relevant",
            structured: {
              instructions: ["Only scan design docs"],
              evidence: [
                {
                  source: "docs/design/0014.md",
                  content: { hits: 3 },
                  producedBy: "host",
                  purpose: "context",
                },
              ],
              rules: [{ id: "no-write", description: "Read-only" }],
              priorTurns: [{ role: "user", content: "previous question" }],
            },
          },
          budget: { maxInputTokens: 1000, maxWorkingTokens: 500, maxOutputTokens: 200 },
        },
        constraints: { maxDepth: 1, timeoutMs: 5000, allowedTools: ["read-file"] },
      },
      context,
      new AbortController().signal,
    );

    expect(lastPrompt).toContain("Additional instructions:");
    expect(lastPrompt).toContain("Only scan design docs");
    expect(lastPrompt).toContain("Evidence:");
    expect(lastPrompt).toContain("docs/design/0014.md");
    expect(lastPrompt).toContain("Rules:");
    expect(lastPrompt).toContain("no-write");
    expect(lastPrompt).toContain("Prior turns");
    expect(lastPrompt).toContain("previous question");
 // 反退化断言：禁止整包 JSON.stringify 的标志（{"file":... 紧跟 "hits":...} 的全量序列）。
    expect(lastPrompt).not.toContain('{"instructions":["Only scan design docs"],"evidence"');
  });

 test("fails closed when an agent exceeds maxDepth", async () => {
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map(),
      route: { provider: "missing", model: "missing" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    });

    const result = await runtime.run(
      {
        id: "invoke-2",
        agent: { ...agent, maxDepth: 0 },
        objective: "Review",
        input: {},
        context: {
          scope: "sub-agent",
          parentTraceId: "trace-agent",
          inherited: { memory: "none" },
          budget: { maxInputTokens: 10, maxWorkingTokens: 10, maxOutputTokens: 10 },
        },
        constraints: { maxDepth: 0, timeoutMs: 5_000, allowedTools: [] },
      },
      context,
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected failed agent result");
    }
    expect(result.error.code).toBe("AGENT_MAX_DEPTH_EXCEEDED");
  });

 test(" P3 γ: rejects when currentDepth exceeds maxDepth", async () => {
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map(),
      route: { provider: "missing", model: "missing" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
    });

    const result = await runtime.run(
      {
        id: "invoke-depth",
        agent: { ...agent, maxDepth: 2 },
        objective: "Review",
        input: {},
        context: {
          scope: "sub-agent",
          parentTraceId: "trace-agent",
          inherited: { memory: "none" },
          budget: { maxInputTokens: 10, maxWorkingTokens: 10, maxOutputTokens: 10 },
        },
        constraints: {
          maxDepth: 2,
          timeoutMs: 5_000,
          allowedTools: [],
          currentDepth: 3, // exceeds maxDepth=2
        },
      },
      context,
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.code).toBe("AGENT_MAX_DEPTH_EXCEEDED");
    expect(result.error.message).toContain("currentDepth=3");
  });

 test(" P3 δ: when toolUseExecutor + contextFactory are injected, runs multi-turn tool-use and tags ctx with agentRunId=invocation.id", async () => {
    let executorCalls = 0;
    let observedAgentRunId: string | undefined;
    let observedPrompt: string | undefined;
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map(),
      route: { provider: "scripted", model: "agent-model" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
      toolUseExecutor: {
        async execute(input, ctx) {
          executorCalls += 1;
          observedAgentRunId = ctx.agentRunId;
          observedPrompt = input.prompt;
          return {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [],
            terminalDraft: "multi-turn done",
          } as never;
        },
      },
      toolUseContextFactory: (invocation) =>
        ({
          agentRunId: invocation.id,
        }) as never,
    });

    const result = await runtime.run(
      {
        id: "invoke-multi",
        agent,
        objective: "Inspect tool history",
        input: { prompt: "actual prompt body" },
        context: {
          scope: "sub-agent",
          parentTraceId: "trace-agent",
          inherited: { memory: "none" as const },
          budget: { maxInputTokens: 100, maxWorkingTokens: 100, maxOutputTokens: 100 },
        },
        constraints: { maxDepth: 1, timeoutMs: 5_000, allowedTools: ["read-file"] },
      },
      context,
      new AbortController().signal,
    );

    expect(executorCalls).toBe(1);
    expect(observedAgentRunId).toBe("invoke-multi");
 // prompt 应来自 invocation.objective + envelope，至少包含 objective
    expect(observedPrompt ?? "").toContain("Inspect tool history");
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.output).toBe("multi-turn done");
    expect(result.evidence?.[0]).toMatchObject({
      source: "agent-run:invoke-multi",
      producedBy: "agent-runtime",
      purpose: "execution-observation",
      agentRunId: "invoke-multi",
      content: {
        agent: "reviewer",
        mode: "tool-use",
      },
    });
  });

 test(" P3 δ: parent and sub-agent history are isolated via distinct agentRunIds", async () => {
    const seen: string[] = [];
    const runtime = new DefaultAgentRuntimeAdapter({
      providers: new Map(),
      route: { provider: "scripted", model: "agent-model" },
      adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
      toolUseExecutor: {
        async execute(_input, ctx) {
          seen.push(ctx.agentRunId ?? "<none>");
          return {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps: [],
            observations: [],
            terminalDraft: "ok",
          } as never;
        },
      },
      toolUseContextFactory: (invocation) =>
        ({ agentRunId: invocation.id }) as never,
    });

    const makeInvocation = (id: string) => ({
      id,
      agent,
      objective: `obj-${id}`,
      input: { prompt: "p" },
      context: {
        scope: "sub-agent" as const,
        parentTraceId: "trace-agent",
        inherited: { memory: "none" as const },
        budget: { maxInputTokens: 10, maxWorkingTokens: 10, maxOutputTokens: 10 },
      },
      constraints: { maxDepth: 1, timeoutMs: 5_000, allowedTools: [] },
    });

    await runtime.run(makeInvocation("agent-a"), context, new AbortController().signal);
    await runtime.run(makeInvocation("agent-b"), context, new AbortController().signal);
    expect(seen).toEqual(["agent-a", "agent-b"]);
    expect(new Set(seen).size).toBe(2);
  });
});
