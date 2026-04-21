/**
 * Stage 4 集成测试：真实 fetch-url executor × Bun.serve 本地 HTTP server。
 *
 * 场景：
 *   1. 起一个 Bun.serve 监听 127.0.0.1 的随机端口，返回一个固定 HTML 页面
 *   2. 放行 loopback（仅测试内）
 *   3. 用 scripted MockProviderAdapter 让模型请求 `fetch-url`
 *   4. TaskExecutor 走真实 `fetchUrlExecutor`（从 @tachu/extensions.toolExecutors 取）
 *   5. 断言：stdout 出现工具调用进度；EngineOutput.content 含 HTTP 返回的标题；
 *      metadata.toolCalls 包含 fetch-url 记录
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
  type ExecutionContext,
  type StreamChunk,
  type TaskNode,
  type ToolDescriptor,
} from "@tachu/core";
import {
  MockProviderAdapter,
  configureNetSafety,
  toolExecutors,
} from "@tachu/extensions";
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
    archivePath: ".tachu/archive/cli-tool-use-http.jsonl",
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

const fetchUrlDescriptor: ToolDescriptor = {
  kind: "tool",
  name: "fetch-url",
  description: "发送 HTTP 请求并返回响应内容。",
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

interface FixtureServer {
  url: string;
  stop: () => Promise<void>;
}

const startFixtureServer = async (): Promise<FixtureServer> => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/hello") {
        return new Response(
          "<html><head><title>Tachu Fixture</title></head><body>hello-from-server</body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    url: `${base}/hello`,
    stop: async () => {
      await server.stop();
    },
  };
};

describe("CLI integration: real fetch-url × Bun.serve", () => {
  let fixture: FixtureServer | undefined;

  beforeEach(async () => {
    setNoColor(true);
    configureNetSafety({ allowLoopbackForTests: true });
    fixture = await startFixtureServer();
  });

  afterEach(async () => {
    resetColorState();
    configureNetSafety({ allowLoopbackForTests: false });
    if (fixture) {
      await fixture.stop();
      fixture = undefined;
    }
  });

  it("LLM 选择 fetch-url → 真实 executor 抓取本地固定页面并收束为自然语言回复", async () => {
    const targetUrl = fixture!.url;
    const provider = new MockProviderAdapter({
      replies: [
        {
          content:
            '{"intent":"抓取本地 fixture 页面","complexity":"complex","contextRelevance":"related"}',
          finishReason: "stop",
        },
        {
          content: "好的，开始抓取。",
          toolCalls: [
            {
              id: "fetch-real-1",
              name: "fetch-url",
              arguments: { url: targetUrl, method: "GET" },
            },
          ],
          finishReason: "tool_calls",
        },
        {
          content:
            "页面抓取成功：标题为 **Tachu Fixture**，正文中出现 `hello-from-server`。",
          finishReason: "stop",
        },
      ],
    });

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register(fetchUrlDescriptor);

    const realFetch = toolExecutors["fetch-url"];
    if (!realFetch) {
      throw new Error("@tachu/extensions.toolExecutors['fetch-url'] 缺失");
    }

    const cwd = process.cwd();
    const taskExecutor = async (
      task: TaskNode,
      context: ExecutionContext,
      signal: AbortSignal,
    ): Promise<unknown> => {
      if (task.type === "tool" && task.ref === "fetch-url") {
        return realFetch(task.input, {
          abortSignal: signal,
          workspaceRoot: cwd,
          session: {
            id: context.sessionId,
            status: "active",
            createdAt: context.startedAt ?? Date.now(),
            lastActiveAt: Date.now(),
          },
        });
      }
      throw new Error(`unexpected task: ${task.type}:${task.ref}`);
    };

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability: new DefaultObservabilityEmitter(),
      sessionManager: new InMemorySessionManager(),
      taskExecutor,
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
        { content: `抓取 ${targetUrl}`, metadata: { modality: "text" } },
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

    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeUndefined();

    const stdout = stdoutBuf.join("");
    expect(stdout).toContain("fetch-url");
    expect(stdout).toContain("✓");
    expect(stdout).toMatch(/\d+ms/);

    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(true);
    expect(chunks.some((c) => c.type === "tool-call-end")).toBe(true);

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.output.content).toContain("Tachu Fixture");
      expect(done.output.content).toContain("hello-from-server");
      const record = done.output.metadata.toolCalls.find(
        (r) => r.name === "fetch-url",
      );
      expect(record).toBeDefined();
      expect(record?.success).toBe(true);
    }
  });

  it("审批拒绝 fetch-url → tool message 告知 LLM，最终自然语言回复不发起真实请求", async () => {
    const targetUrl = fixture!.url;
    const provider = new MockProviderAdapter({
      replies: [
        {
          content:
            '{"intent":"抓取本地 fixture","complexity":"complex","contextRelevance":"related"}',
          finishReason: "stop",
        },
        {
          content: "准备抓取。",
          toolCalls: [
            {
              id: "fetch-approval-1",
              name: "fetch-url",
              arguments: { url: targetUrl, method: "GET" },
            },
          ],
          finishReason: "tool_calls",
        },
        {
          content: "我已经放弃了网络请求，按常识给出回答。",
          finishReason: "stop",
        },
      ],
    });

    const vectorStore = new InMemoryVectorStore();
    const registry = new DescriptorRegistry({ vectorStore });
    await registry.register({
      ...fetchUrlDescriptor,
      requiresApproval: true,
    });

    let realExecutorInvoked = false;
    const realFetch = toolExecutors["fetch-url"];
    if (!realFetch) throw new Error("fetch-url executor 缺失");
    const cwd = process.cwd();
    const taskExecutor = async (
      task: TaskNode,
      context: ExecutionContext,
      signal: AbortSignal,
    ): Promise<unknown> => {
      if (task.type === "tool" && task.ref === "fetch-url") {
        realExecutorInvoked = true;
        return realFetch(task.input, {
          abortSignal: signal,
          workspaceRoot: cwd,
          session: {
            id: context.sessionId,
            status: "active",
            createdAt: context.startedAt ?? Date.now(),
            lastActiveAt: Date.now(),
          },
        });
      }
      throw new Error(`unexpected task: ${task.type}:${task.ref}`);
    };

    const engine = new Engine(createConfig(), {
      registry,
      vectorStore,
      providers: [provider],
      observability: new DefaultObservabilityEmitter(),
      sessionManager: new InMemorySessionManager(),
      taskExecutor,
      onBeforeToolCall: async (request) => ({
        type: "deny",
        reason: `用例显式拒绝 ${request.tool}`,
      }),
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
        { content: `抓取 ${targetUrl}`, metadata: { modality: "text" } },
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

    expect(realExecutorInvoked).toBe(false);

    const stdout = stdoutBuf.join("");
    expect(stdout).toContain("已拒绝");
    expect(stdout).toContain("fetch-url");

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done && done.type === "done") {
      expect(done.output.content).toContain("放弃");
      const record = done.output.metadata.toolCalls.find(
        (r) => r.name === "fetch-url",
      );
      expect(record).toBeDefined();
      expect(record?.success).toBe(false);
      expect(record?.errorCode).toBe("TOOL_LOOP_APPROVAL_DENIED");
    }
  });
});
