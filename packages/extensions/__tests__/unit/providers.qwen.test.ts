import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import {
  coerceStringContentToTextPartsForDashScopeQwenImage,
  mergeSystemIntoLastUserForDashScope,
  QwenProviderAdapter,
} from "../../src/providers/qwen";

describe("QwenProviderAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.DASHSCOPE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DASHSCOPE_API_KEY;
  });

  it("throws when missing api key", () => {
    delete process.env.DASHSCOPE_API_KEY;
    expect(() => new QwenProviderAdapter({})).toThrow();
  });

  it("wanx text2image: async create + poll returns markdown urls", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("image-synthesis")) {
        return new Response(
          JSON.stringify({
            output: { task_id: "tid-1", task_status: "PENDING" },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/tasks/tid-1")) {
        return new Response(
          JSON.stringify({
            output: {
              task_id: "tid-1",
              task_status: "SUCCEEDED",
              results: [{ url: "https://example.com/a.png" }],
            },
            usage: { image_count: 1 },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = new QwenProviderAdapter({
      apiKey: "k",
      timeoutMs: 5000,
      imageTaskPollIntervalMs: 1,
    });
    const res = await adapter.chat(
      {
        model: "wanx-v1",
        messages: [{ role: "user", content: "一只猫" }],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(res.content).toContain("https://example.com/a.png");
    expect(res.content).toContain("![generated-1]");
    expect(res.usage.completionTokens).toBe(1);
  });

  it("exposes id qwen", () => {
    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    expect(adapter.id).toBe("qwen");
  });

  it("wan2.7-image: sync multimodal-generation returns images + structured list", async () => {
    const captured: { url: string; body: unknown; headers: Record<string, string> } = {
      url: "",
      body: null,
      headers: {},
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      captured.url = u;
      captured.body = init?.body ? JSON.parse(init.body as string) : null;
      captured.headers = { ...((init?.headers as Record<string, string>) ?? {}) };
      return new Response(
        JSON.stringify({
          request_id: "req-xyz",
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: [
                    { image: "https://example.com/cat.png" },
                  ],
                },
              },
            ],
          },
          usage: { image_count: 1, input_tokens: 8, output_tokens: 0, total_tokens: 8 },
        }),
        { status: 200 },
      );
    });

    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    const res = await adapter.chat(
      {
        model: "wan2.7-image",
        messages: [{ role: "user", content: "生成一只小猫图片" }],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    expect(captured.url).toContain("/api/v1/services/aigc/multimodal-generation/generation");
    expect(captured.headers["X-DashScope-Async"]).toBeUndefined();
    const body = captured.body as {
      model: string;
      input: { messages: Array<{ role: string; content: Array<{ text?: string }> }> };
    };
    expect(body.model).toBe("wan2.7-image");
    expect(body.input.messages[0]!.content[0]!.text).toBe("生成一只小猫图片");

    expect(res.content).toContain("https://example.com/cat.png");
    expect(res.images?.length).toBe(1);
    expect(res.images?.[0]!.url).toBe("https://example.com/cat.png");
    expect(res.images?.[0]!.index).toBe(0);
    expect(res.images?.[0]!.mimeType).toBe("image/png");
    expect(res.images?.[0]!.providerMetadata).toMatchObject({
      provider: "qwen",
      model: "wan2.7-image",
      endpoint: "multimodal-generation",
      requestId: "req-xyz",
    });
    expect(res.usage.promptTokens).toBe(8);
  });

  it("wan2.7-image: passes watermark / size / promptExtend to parameters", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              { message: { role: "assistant", content: [{ image: "https://x/1.png" }] } },
            ],
          },
          usage: { image_count: 1 },
        }),
        { status: 200 },
      );
    });
    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    await adapter.chat(
      {
        model: "wan2.7-image",
        messages: [{ role: "user", content: "cat" }],
        ...({
          qwenImage: {
            size: "2048*2048",
            n: 1,
            watermark: false,
            promptExtend: true,
            seed: 42,
          },
        } as Record<string, unknown>),
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const parameters = (captured as { parameters: Record<string, unknown> }).parameters;
    expect(parameters.size).toBe("2048*2048");
    expect(parameters.n).toBe(1);
    expect(parameters.watermark).toBe(false);
    expect(parameters.prompt_extend).toBe(true);
    expect(parameters.seed).toBe(42);
  });

  it("wan2.7-image: includes ref image parts from message + qwenImage.refImages", async () => {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              { message: { role: "assistant", content: [{ image: "https://y/1.jpg" }] } },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    await adapter.chat(
      {
        model: "wan2.7-image",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "重绘" },
              { type: "image_url", image_url: { url: "https://a/a.png" } },
            ],
          },
        ],
        ...({
          qwenImage: { refImages: ["https://a/a.png", "https://b/b.png"] },
        } as Record<string, unknown>),
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    const content = (captured as {
      input: { messages: Array<{ content: Array<{ text?: string; image?: string }> }> };
    }).input.messages[0]!.content;
    const texts = content.filter((c) => typeof c.text === "string").map((c) => c.text);
    const images = content.filter((c) => typeof c.image === "string").map((c) => c.image);
    expect(texts).toEqual(["重绘"]);
    expect(images).toEqual(["https://a/a.png", "https://b/b.png"]);
  });

  it("wan2.7-image: maps upstream HTTP 401 to auth error", async () => {
    globalThis.fetch = mock(async () => new Response("no key", { status: 401 }));
    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    await expect(
      adapter.chat(
        {
          model: "wan2.7-image",
          messages: [{ role: "user", content: "cat" }],
        },
        DEFAULT_ADAPTER_CALL_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
  });

  it("wan2.7-image: empty prompt rejected before HTTP", async () => {
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy;
    const adapter = new QwenProviderAdapter({ apiKey: "k" });
    await expect(
      adapter.chat(
        {
          model: "wan2.7-image",
          messages: [{ role: "user", content: "   " }],
        },
        DEFAULT_ADAPTER_CALL_CONTEXT,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_INVALID_INPUT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("mergeSystemIntoLastUserForDashScope", () => {
  it("drops standalone system and prefixes the last user message", () => {
    const out = mergeSystemIntoLastUserForDashScope([
      { role: "system", content: "你是助手。" },
      { role: "user", content: "hello" },
    ]);
    expect(out).toEqual([{ role: "user", content: "你是助手。\n\nhello" }]);
  });

  it("merges into the last user when history contains multiple users", () => {
    const out = mergeSystemIntoLastUserForDashScope([
      { role: "system", content: "S" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "last" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "S\n\nlast" },
    ]);
  });

  it("prepends text part when user content is multimodal without leading text", () => {
    const out = mergeSystemIntoLastUserForDashScope([
      { role: "system", content: "ctx" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "ctx" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
    ]);
  });

  it("returns original messages when there is no system", () => {
    const msgs = [{ role: "user" as const, content: "x" }];
    expect(mergeSystemIntoLastUserForDashScope(msgs)).toBe(msgs);
  });
});

describe("coerceStringContentToTextPartsForDashScopeQwenImage", () => {
  it("converts string user content to text parts for qwen-image models", () => {
    const out = coerceStringContentToTextPartsForDashScopeQwenImage("qwen-image-2.0-pro", [
      { role: "user", content: "橘猫" },
    ]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "橘猫" }] }]);
  });

  it("converts for wan2.x-image style model ids from Bailian console", () => {
    const out = coerceStringContentToTextPartsForDashScopeQwenImage("wan2.7-image", [
      { role: "user", content: "hi" },
    ]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("no-op for wanx models", () => {
    const msgs = [{ role: "user" as const, content: "x" }];
    expect(coerceStringContentToTextPartsForDashScopeQwenImage("wanx-v1", msgs)).toBe(msgs);
  });

  it("no-op for non-qwen-image models", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(coerceStringContentToTextPartsForDashScopeQwenImage("qwen-turbo", msgs)).toBe(msgs);
  });
});
