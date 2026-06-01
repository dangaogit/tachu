import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types";
import type { AdapterCallContext } from "../types/context";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import type { Tokenizer } from "../prompt";
import { InMemoryVectorStore } from "../vector";
import { InMemoryMemorySystem, memoryEntryToMessage } from "./memory";
import { DefaultModelRouter } from "./model-router";
import type { ChatRequest, ChatResponse, ProviderAdapter } from "./provider";

const tokenizer: Tokenizer = {
  count: (text) => Math.max(1, Math.ceil(text.length / 4)),
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

const createConfig = (archivePath: string): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: { planMode: false, maxConcurrency: 4, defaultTaskTimeoutMs: 1_000, failFast: false },
  memory: {
    contextTokenLimit: 80,
    compressionThreshold: 0.2,
    headKeep: 1,
    tailKeep: 1,
    archivePath,
    vectorIndexLimit: 1_000,
  },
  budget: { maxTokens: 1_000, maxToolCalls: 10, maxWallTimeMs: 10_000 },
  safety: {
    maxInputSizeBytes: 1_024,
    maxRecursionDepth: 3,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      compress: { provider: "summary", model: "mem-summarizer" },
      "fast-cheap": { provider: "noop", model: "dev-small" },
    },
    providerFallbackOrder: ["summary", "noop"],
  },
  observability: { enabled: true, maskSensitiveData: true },
  hooks: { writeHookTimeout: 1_000, failureBehavior: "continue" },
});

class SummaryProvider implements ProviderAdapter {
  readonly id = "summary";
  readonly name = "SummaryProvider";
  calls = 0;

  async listAvailableModels() {
    return [
      {
        modelName: "mem-summarizer",
        capabilities: {
          supportedModalities: ["text"],
          maxContextTokens: 8_192,
          supportsStreaming: false,
          supportsFunctionCalling: false,
        },
      },
    ];
  }

  async chat(request: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
    this.calls += 1;
    const source = request.messages.at(-1)?.content ?? "";
    return {
      content: `provider-summary:${source.slice(0, 24)}`,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async *chatStream(_req: ChatRequest, _ctx: AdapterCallContext) {
    yield { type: "finish" as const, finishReason: "stop" as const };
  }
}

describe("InMemoryMemorySystem", () => {
 test("compress uses provider-generated middle summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-provider-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const summaryProvider = new SummaryProvider();
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>([
        ["summary", summaryProvider],
        ["noop", summaryProvider],
      ]),
      vector,
    );

    const now = Date.now();
    await memory.append(
      "s1",
      { id: "s1-e1", role: "user", content: "head", timestamp: now, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s1",
      {
        id: "s1-e2",
        role: "assistant",
        content: "middle one with context",
        timestamp: now + 1,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s1",
      {
        id: "s1-e3",
        role: "user",
        content: "middle two with context",
        timestamp: now + 2,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s1",
      { id: "s1-e4", role: "assistant", content: "tail", timestamp: now + 3, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    await memory.compress("s1");

    const window = await memory.load("s1", DEFAULT_ADAPTER_CALL_CONTEXT);
    const summary = window.entries.find(
      (entry) => entry.role === "system" && String(entry.content).includes("provider-summary:"),
    );
    expect(summary).toBeDefined();
    expect(summaryProvider.calls).toBeGreaterThan(0);
  });

 test("compress falls back to local summary when provider unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-fallback-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>(),
      vector,
    );

    const now = Date.now();
    await memory.append(
      "s2",
      { id: "s2-e1", role: "user", content: "head", timestamp: now, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s2",
      {
        id: "s2-e2",
        role: "assistant",
        content: "middle fallback one",
        timestamp: now + 1,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s2",
      {
        id: "s2-e3",
        role: "user",
        content: "middle fallback two",
        timestamp: now + 2,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s2",
      { id: "s2-e4", role: "assistant", content: "tail", timestamp: now + 3, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    await memory.compress("s2");

    const window = await memory.load("s2", DEFAULT_ADAPTER_CALL_CONTEXT);
    const summary = window.entries.find((entry) => String(entry.content).startsWith("中段摘要:"));
    expect(summary).toBeDefined();
    expect(String(summary?.content)).toContain("middle fallback");
  });

 test("append archives source without legacy vector projection and trim reduces token size", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-archive-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>([
        ["summary", new SummaryProvider()],
        ["noop", new SummaryProvider()],
      ]),
      vector,
    );

    const baseTs = Date.now();
    await memory.append(
      "s3",
      {
        id: "s3-e1",
        role: "user",
        content: "hello world memory",
        timestamp: baseTs,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s3",
      {
        id: "s3-e2",
        role: "assistant",
        content: "first-filler-message-content",
        timestamp: baseTs + 1,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s3",
      {
        id: "s3-e3",
        role: "user",
        content: "second-filler-message-content",
        timestamp: baseTs + 2,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "s3",
      {
        id: "s3-e4",
        role: "assistant",
        content: "final-message-content",
        timestamp: baseTs + 3,
        anchored: false,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.archive("s3");
    const recalled = await memory.recall("s3", "hello", 1);
    expect(recalled).toEqual([]);
    await expect(memory.project("s3")).rejects.toThrow(/retired/);
    const before = await memory.getSize("s3");
    expect(before.entries).toBeGreaterThanOrEqual(4);
    expect(before.tokens).toBeGreaterThan(0);
    await memory.trim("s3", { keepHead: 1, keepTail: 1 });
    const after = await memory.getSize("s3");
    expect(after.entries).toBeLessThanOrEqual(before.entries);
    expect(after.tokens).toBeLessThanOrEqual(before.tokens);
  });

 test("append auto-generates id on entries that lack one", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-id-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>(),
      vector,
    );

    const now = Date.now();
    await memory.append(
      "sid",
 // @ts-expect-error intentionally omitting id to test auto-generation
      { role: "user", content: "hello", timestamp: now, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const window = await memory.load("sid", DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(window.entries[0]?.id).toBeTypeOf("string");
    expect((window.entries[0]?.id ?? "").length).toBeGreaterThan(0);
  });

 test("append preserves id when already set", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-id-preserve-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>(),
      vector,
    );

    const now = Date.now();
    await memory.append(
      "sid2",
      { id: "my-custom-id", role: "user", content: "hi", timestamp: now, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const window = await memory.load("sid2", DEFAULT_ADAPTER_CALL_CONTEXT);
    expect(window.entries[0]?.id).toBe("my-custom-id");
  });

 test("loadFull returns all entries from the context window", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-memory-loadfull-"));
    const config = createConfig(join(root, "memory.jsonl"));
    const router = new DefaultModelRouter(config);
    const vector = new InMemoryVectorStore();
    const memory = new InMemoryMemorySystem(
      config,
      tokenizer,
      router,
      new Map<string, ProviderAdapter>(),
      vector,
    );

    const now = Date.now();
    await memory.append(
      "sfull",
      { id: "e1", role: "user", content: "alpha", timestamp: now, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    await memory.append(
      "sfull",
      { id: "e2", role: "assistant", content: "beta", timestamp: now + 1, anchored: false },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    const all = await memory.loadFull("sfull");
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((e) => e.id)).toContain("e1");
    expect(all.map((e) => e.id)).toContain("e2");
  });
});

describe("memoryEntryToMessage", () => {
 test("preserves image_url and file uri parts without stringify (T3)", () => {
    const parts = [
      { type: "text" as const, text: "hi" },
      { type: "file" as const, file: { mimeType: "image/png", uri: "opaque-1" } },
    ];
    const message = memoryEntryToMessage({
      id: "1",
      role: "user",
      content: parts,
      timestamp: Date.now(),
      anchored: false,
    });
    expect(message).not.toBeNull();
    expect(message?.content).toEqual(parts);
    expect(typeof message?.content).not.toBe("string");
  });
});
