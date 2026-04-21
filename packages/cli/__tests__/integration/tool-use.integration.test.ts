/**
 * ADR-0002 Stage 2 集成测试：CLI StreamRenderer 对 Agentic Loop 事件的渲染。
 *
 * 场景：脚本化 MockProviderAdapter 驱动 Engine.runStream 跑一轮 tool-use，
 *      StreamRenderer 接收事件流。验收点：
 *   1. stdout 中出现工具调用进展相关提示（"调用工具"、工具名、"✓"、"ms"）
 *   2. 最终 EngineOutput.content 来自 scripted 第 3 轮的终止文本
 *   3. EngineOutput.metadata.toolCalls 包含 echo-tool 的记录
 *   4. 无错误 chunk
 *
 * 与 @tachu/core 的 tool-use 集成测试互补：这里验证 CLI 层对新事件流的适配。
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DefaultObservabilityEmitter,
  DescriptorRegistry,
  Engine,
  InMemorySessionManager,
  InMemoryVectorStore,
  type EngineConfig,
  type StreamChunk,
  type ToolDescriptor,
} from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions";
import { StreamRenderer } from "../../src/renderer/stream-renderer";
import { setNoColor, resetColorState } from "../../src/renderer/color";

const createConfig = (): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: {
    planMode: false,
    maxConcurrency: 2,
    defaultTaskTimeoutMs: 10_000,
    failFast: false,
    toolLoop: { maxSteps: 4, parallelism: 1, requireApprovalGlobal: false },
  },
  memory: {
    contextTokenLimit: 2_000,
    compressionThreshold: 0.8,
    headKeep: 2,
    tailKeep: 2,
    archivePath: ".tachu/archive/cli-tool-use-integration.jsonl",
    vectorIndexLimit: 500,
  },
  budget: { maxTokens: 20_000, maxToolCalls: 10, maxWallTimeMs: 30_000 },
  safety: {
    maxInputSizeBytes: 1024 * 1024,
    maxRecursionDepth: 5,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "mock", model: "mock-chat" },
      planning: { provider: "mock", model: "mock-chat" },
      "fast-cheap": { provider: "mock", model: "mock-chat" },
      "high-reasoning": { provider: "mock", model: "mock-chat" },
      validation: { provider: "mock", model: "mock-chat" },
    },
    providerFallbackOrder: ["mock"],
  },
  observability: { enabled: false, maskSensitiveData: false },
  hooks: { writeHookTimeout: 1_000, failureBehavior: "continue" },
});

const echoToolDescriptor: ToolDescriptor = {
  kind: "tool",
  name: "echo-tool",
  description: "回显输入的 text。",
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 3_000,
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: "echo",
};

const fetchUrlDescriptor: ToolDescriptor = {
  kind: "tool",
  name: "fetch-url",
  description: "发送 HTTP 请求并返回响应内容（集成测试用 stub）。",
  sideEffect: "readonly",
  idempotent: false,
  requiresApproval: false,
  timeout: 5_000,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { type: "string" },
    },
    required: ["url"],
  },
  execute: "fetch-url",
};

describe("CLI integration: StreamRenderer × Agentic Loop", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(() => {
    resetColorState();
  });

  it("渲染 tool-loop-* / tool-call-* 进度并输出终止文本", async () => {
    const provider = new MockProviderAdapter({
      replies: [
        {
          content:
            '{"intent":"调用 echo 工具","complexity":"complex","contextRelevance":"related"}',
          finishReason: "stop",
        },
        {
          content: "",
          toolCalls: [
            { id: "call-1", name: "echo-tool", arguments: { text: "world" } },
          ],
          finishReason: "tool_calls",
        },
        { content: "已完成：echoed:world。", finishReason: "stop" },
      ],
    });

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register(echoToolDescriptor);

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability: new DefaultObservabilityEmitter(),
      sessionManager: new InMemorySessionManager(),
      taskExecutor: async (task) => {
        if (task.type === "tool" && task.ref === "echo-tool") {
          const args = (task.input ?? {}) as { text?: string };
          return { text: `echoed:${args.text ?? ""}` };
        }
        throw new Error(`unexpected task: ${task.type}:${task.ref}`);
      },
    });

    const renderer = new StreamRenderer({ verbose: true, renderMarkdown: false });
    const stdoutBuf: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      stdoutBuf.push(String(chunk));
      return true;
    };

    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of engine.runStream(
        { content: "请用 echo 工具回显 world", metadata: { modality: "text" } },
        {
          requestId: randomUUID(),
          sessionId: randomUUID(),
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: Date.now(),
        },
      )) {
        chunks.push(chunk);
        renderer.render(chunk);
      }
    } finally {
      process.stdout.write = origWrite;
      await engine.dispose();
      await renderer.dispose();
    }

    const stdout = stdoutBuf.join("");
    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeUndefined();

    // 1. CLI 渲染流包含 Agentic Loop 进展提示
    expect(stdout).toContain("调用工具");
    expect(stdout).toContain("echo-tool");
    expect(stdout).toContain("✓"); // 工具调用成功标记
    // 验证时长单位出现
    expect(stdout).toMatch(/\d+ms/);

    // 2. Stream chunk 里确实触发了新事件
    expect(chunks.some((c) => c.type === "tool-loop-step")).toBe(true);
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(true);
    expect(chunks.some((c) => c.type === "tool-call-end")).toBe(true);

    // 3. 最终输出为 scripted 终止文本，metadata 含 echo-tool 记录
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(typeof done.output.content).toBe("string");
      expect(done.output.content).toContain("echoed:world");
      const call = done.output.metadata.toolCalls.find(
        (r) => r.name === "echo-tool",
      );
      expect(call).toBeDefined();
      if (call) expect(call.success).toBe(true);
    }
  });

  it("fetch-url 跃迁场景（Mock scripted + stub executor）：工具调用闭环", async () => {
    // 真实 CLI 跃迁的代表性用例：LLM 决定调用 fetch-url → 收到 HTTP 响应 → 总结成文本。
    // 这里用 scripted provider + stub TaskExecutor 闭合整个链路，避免集成测试依赖外网。
    const provider = new MockProviderAdapter({
      replies: [
        {
          content:
            '{"intent":"抓取 example.com 首页","complexity":"complex","contextRelevance":"related"}',
          finishReason: "stop",
        },
        {
          content: "好的，我来抓取。",
          toolCalls: [
            {
              id: "fetch-1",
              name: "fetch-url",
              arguments: { url: "https://example.com", method: "GET" },
            },
          ],
          finishReason: "tool_calls",
        },
        {
          content: "抓取完成，页面标题包含 Example Domain。",
          finishReason: "stop",
        },
      ],
    });

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register(fetchUrlDescriptor);

    let fetchCalledWith: Record<string, unknown> | undefined;

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability: new DefaultObservabilityEmitter(),
      sessionManager: new InMemorySessionManager(),
      taskExecutor: async (task) => {
        if (task.type === "tool" && task.ref === "fetch-url") {
          fetchCalledWith = task.input as Record<string, unknown>;
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html><head><title>Example Domain</title></head></html>",
            truncated: false,
          };
        }
        throw new Error(`unexpected task: ${task.type}:${task.ref}`);
      },
    });

    const renderer = new StreamRenderer({ verbose: false, renderMarkdown: false });
    const stdoutBuf: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      stdoutBuf.push(String(chunk));
      return true;
    };

    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of engine.runStream(
        { content: "帮我抓取 https://example.com 的首页", metadata: { modality: "text" } },
        {
          requestId: randomUUID(),
          sessionId: randomUUID(),
          traceId: randomUUID(),
          principal: {},
          budget: {},
          scopes: ["*"],
          startedAt: Date.now(),
        },
      )) {
        chunks.push(chunk);
        renderer.render(chunk);
      }
    } finally {
      process.stdout.write = origWrite;
      await engine.dispose();
      await renderer.dispose();
    }

    expect(fetchCalledWith).toEqual({
      url: "https://example.com",
      method: "GET",
    });

    const stdout = stdoutBuf.join("");
    expect(stdout).toContain("fetch-url");
    expect(stdout).toMatch(/\d+ms/);

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.output.content).toContain("Example Domain");
      const call = done.output.metadata.toolCalls.find(
        (r) => r.name === "fetch-url",
      );
      expect(call).toBeDefined();
      if (call) expect(call.success).toBe(true);
    }
  });
});
