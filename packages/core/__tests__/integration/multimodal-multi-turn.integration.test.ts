import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DefaultObservabilityEmitter,
  DescriptorRegistry,
  Engine,
  InMemorySessionManager,
  InMemoryVectorStore,
  RegistryLoader,
  type EngineConfig,
  type Message,
  type MultimodalResolver,
  type ProviderAdapter,
  type ChatRequest,
  type ChatResponse,
} from "../../src";

const createConfig = (): EngineConfig => ({
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: {
    planMode: false,
    maxConcurrency: 4,
    defaultTaskTimeoutMs: 10_000,
    failFast: false,
    streamingOutput: false,
  },
  memory: {
    contextTokenLimit: 16_000,
    compressionThreshold: 0.8,
    headKeep: 4,
    tailKeep: 4,
    archivePath: ".tachu/archive/multimodal-multi-turn.jsonl",
    vectorIndexLimit: 1000,
  },
  budget: { maxTokens: 40_000, maxToolCalls: 20, maxWallTimeMs: 120_000 },
  safety: {
    maxInputSizeBytes: 1024 * 1024,
    maxRecursionDepth: 10,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "capture", model: "dev-medium" },
      planning: { provider: "capture", model: "dev-large" },
      "fast-cheap": { provider: "capture", model: "dev-small" },
      vision: { provider: "capture", model: "dev-vision" },
      "high-reasoning": { provider: "capture", model: "dev-large" },
      validation: { provider: "capture", model: "dev-medium" },
    },
    providerFallbackOrder: ["capture"],
  },
  observability: { enabled: false, maskSensitiveData: true },
  hooks: { writeHookTimeout: 2000, failureBehavior: "continue" },
});

const createCaptureProvider = (): ProviderAdapter & {
  captured: ChatRequest[];
} => {
  const captured: ChatRequest[] = [];
  return {
    id: "capture",
    async listAvailableModels() {
      return [
        {
          modelName: "dev-vision",
          capabilities: {
            supportedModalities: ["text", "image"],
            maxContextTokens: 32_000,
            supportsStreaming: false,
            supportsFunctionCalling: true,
          },
        },
        {
          modelName: "dev-medium",
          capabilities: {
            supportedModalities: ["text"],
            maxContextTokens: 32_000,
            supportsStreaming: false,
            supportsFunctionCalling: false,
          },
        },
      ];
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      captured.push({ model: request.model, messages: [...request.messages] });
      return {
        content: JSON.stringify({
          complexity: "simple",
          intent: "ok",
          contextRelevance: "none",
        }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async chatStream() {
      throw new Error("not used");
    },
    captured,
  };
};

const stubResolver: MultimodalResolver = {
  async resolveResources(refs) {
    const out = new Map<
      string,
      { ok: true; part: { type: "image_url"; image_url: { url: string } } }
    >();
    for (const ref of refs) {
      out.set(ref.key, {
        ok: true,
        part: {
          type: "image_url",
          image_url: {
            url: `data:${ref.mimeType ?? "image/png"};base64,${Buffer.from("abc").toString("base64")}`,
          },
        },
      });
    }
    return out;
  },
};

describe("multimodal multi-turn integration (T4)", () => {
 test("turn 2 provider messages include turn 1 resolved base64 image", async () => {
    const provider = createCaptureProvider();
    const registry = new DescriptorRegistry(new InMemoryVectorStore());
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(join(import.meta.dir, "../fixtures/descriptors"));

    const engine = new Engine(createConfig(), {
      registry,
      providers: [provider],
      sessionManager: new InMemorySessionManager(),
      observability: new DefaultObservabilityEmitter(),
      multimodalResolver: stubResolver,
    });

    const sessionId = "sess-multimodal-1";
    const correlation = {
      sessionId,
      requestId: "req-1",
      traceId: "trace-1",
      turnId: "turn-1",
    };

    const imageParts = [
      { type: "text" as const, text: "what is in this image" },
      { type: "file" as const, file: { mimeType: "image/png", uri: "file-turn-1" } },
    ];

    await engine.run(
      {
        content: imageParts,
        metadata: { modality: "image", size: 20 },
      },
      {
        correlation,
        principal: { role: "tester", tenant: 1 },
        budget: {},
        scopes: ["*"],
      },
    );

    provider.captured.length = 0;

    await engine.run(
      {
        content: "what did I ask about before",
        metadata: { modality: "text", size: 10 },
      },
      {
        correlation: {
          ...correlation,
          requestId: "req-2",
          traceId: "trace-2",
          turnId: "turn-2",
        },
        principal: { role: "tester", tenant: 1 },
        budget: {},
        scopes: ["*"],
      },
    );

    const withImage = provider.captured.flatMap((req) =>
      req.messages.filter((m) => {
        if (m.role !== "user" || typeof m.content === "string") return false;
        return (
          Array.isArray(m.content) &&
          m.content.some(
            (p) =>
              p.type === "image_url" &&
              typeof p.image_url.url === "string" &&
              p.image_url.url.startsWith("data:image/png;base64,"),
          )
        );
      }),
    );
    expect(withImage.length).toBeGreaterThan(0);
  });

 test("resolver failure degrades the resource in-dialogue, chat still proceeds (D6a)", async () => {
    const provider = createCaptureProvider();
    const registry = new DescriptorRegistry(new InMemoryVectorStore());
    const loader = new RegistryLoader(registry);
    await loader.loadFromDirectory(join(import.meta.dir, "../fixtures/descriptors"));

    const failingResolver: MultimodalResolver = {
      async resolveResources(refs) {
        const out = new Map<
          string,
          { ok: false; reason: string; userVisibleReason: string }
        >();
        for (const ref of refs) {
          out.set(ref.key, {
            ok: false,
            reason: "asset-missing",
            userVisibleReason: "无法读取您上传的图片，请重新上传后再试。",
          });
        }
        return out;
      },
    };

    const engine = new Engine(createConfig(), {
      registry,
      providers: [provider],
      sessionManager: new InMemorySessionManager(),
      observability: new DefaultObservabilityEmitter(),
      multimodalResolver: failingResolver,
    });

    for await (const _chunk of engine.runStream(
      {
        content: [{ type: "file", file: { mimeType: "image/png", uri: "missing" } }],
        metadata: { modality: "image", size: 1 },
      },
      {
        correlation: {
          sessionId: "sess-degrade",
          requestId: "req-d1",
          traceId: "trace-d1",
          turnId: "turn-d1",
        },
        principal: { role: "tester", tenant: 1 },
        budget: {},
        scopes: ["*"],
      },
    )) {
 // drain
    }

 // D6 第一层：部分降级——Provider 仍被调用（不再整轮短路），
 // 待物化资源以 [unavailable: …] 降级说明出现在消息中。
    expect(provider.captured.length).toBeGreaterThan(0);
    const hasUnavailableNote = provider.captured.some((req) =>
      req.messages.some((m) => {
        if (!Array.isArray(m.content)) return false;
        return m.content.some(
          (p) => p.type === "text" && p.text.includes("[unavailable"),
        );
      }),
    );
    expect(hasUnavailableNote).toBe(true);
  });
});
