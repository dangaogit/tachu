import { describe, expect, it } from "bun:test";
import { AnthropicProviderAdapter } from "../../src/providers/anthropic";
import { OpenAIProviderAdapter } from "../../src/providers/openai";

const collectStream = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const chunks: T[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("provider adapters credential guard", () => {
  it("openai throws when missing api key", () => {
    expect(() => new OpenAIProviderAdapter({ apiKey: "" })).toThrow();
  });

  it("anthropic throws when missing api key", () => {
    expect(() => new AnthropicProviderAdapter({ apiKey: "" })).toThrow();
  });
});

describe("OpenAIProviderAdapter", () => {
  it("maps model list and capabilities", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: {
        list: async () => ({
          data: [{ id: "gpt-4o-mini" }, { id: "gpt-4-128k" }],
        }),
      },
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "ok" } }] }) } },
    };

    const models = await adapter.listAvailableModels();
    expect(models.length).toBe(2);
    expect(models[0]?.capabilities.supportedModalities).toContain("image");
    expect(models[1]?.capabilities.maxContextTokens).toBe(200000);
  });

  it("maps chat body and returns usage", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    let capturedBody: Record<string, unknown> | undefined;
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            capturedBody = body;
            return {
              choices: [
                {
                  message: { content: [{ text: "hello" }] },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            };
          },
        },
      },
    };

    const response = await adapter.chat(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "请读取文件" },
          { role: "tool", content: "done", toolCallId: "tool-1" },
        ],
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
        temperature: 0.2,
        maxTokens: 64,
        topP: 0.9,
        stop: ["END"],
        toolChoice: { function: { name: "read_file" } },
        responseFormat: { type: "json_object" },
      } as unknown as Parameters<OpenAIProviderAdapter["chat"]>[0],
      undefined,
    );

    expect(response.content).toBe("hello");
    expect(response.finishReason).toBe("stop");
    expect(response.toolCalls).toBeUndefined();
    expect(response.usage.totalTokens).toBe(13);
    expect(capturedBody?.tool_choice).toEqual({ type: "function", function: { name: "read_file" } });
    expect(capturedBody?.top_p).toBe(0.9);
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
  });

  it("parses tool_calls in non-stream response into structured ToolCallRequest[]", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_abc",
                      type: "function",
                      function: { name: "fetch_url", arguments: "{\"url\":\"https://x\"}" },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        },
      },
    };

    const response = await adapter.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "fetch it" }],
    });
    expect(response.content).toBe("");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "call_abc", name: "fetch_url", arguments: { url: "https://x" } },
    ]);
  });

  it("throws PROVIDER_TOOL_ARGUMENTS_INVALID when tool_calls arguments are not valid JSON", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_broken",
                      type: "function",
                      function: { name: "fetch_url", arguments: "{url:" },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
    await expect(
      adapter.chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "break it" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_TOOL_ARGUMENTS_INVALID", retryable: true });
  });

  it("serializes assistant-with-toolCalls into OpenAI tool_calls array on the wire", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    let capturedBody: Record<string, unknown> | undefined;
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            capturedBody = body;
            return {
              choices: [{ finish_reason: "stop", message: { content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      },
    };
    await adapter.chat({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "do x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "fetch_url", arguments: { url: "https://x" } }],
        },
        { role: "tool", toolCallId: "call_1", content: "fetched body" },
      ],
    });
    const wireMessages = capturedBody?.messages as Array<Record<string, unknown>>;
    const assistant = wireMessages?.[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://x" }) },
      },
    ]);
    expect(wireMessages?.[2]?.tool_call_id).toBe("call_1");
  });

  it("maps openai errors to standardized errors", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () => {
            throw { status: 429, message: "rate limited" };
          },
        },
      },
    };
    await expect(
      adapter.chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
  });

  it("maps openai auth errors from model listing", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: {
        list: async () => {
          throw { status: 401, message: "unauthorized" };
        },
      },
      chat: { completions: { create: async () => ({ choices: [] }) } },
    };
    await expect(adapter.listAvailableModels()).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
  });

  it("maps timeout-like network errors to timeout error", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () => {
            throw { code: "ETIMEDOUT", message: "timed out" };
          },
        },
      },
    };
    await expect(
      adapter.chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT_PROVIDER_REQUEST", retryable: true });
  });

  it("streams text, aggregates tool_call fragments, and finishes with finishReason", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { content: "hello" } }] };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "tool-1",
                          function: { name: "search_docs", arguments: "{\"q\":\"" },
                        },
                      ],
                    },
                  },
                ],
              };
              yield {
                choices: [
                  { delta: { tool_calls: [{ index: 0, function: { arguments: "foo\"}" } }] } },
                ],
              };
              yield { choices: [{ finish_reason: "tool_calls", delta: {} }] };
            })(),
        },
      },
    };

    const chunks = await collectStream(
      adapter.chatStream({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "stream" }],
      }),
    );
    const textDelta = chunks.find((item) => item.type === "text-delta");
    expect(textDelta).toBeDefined();
    if (textDelta && textDelta.type === "text-delta") {
      expect(textDelta.delta).toBe("hello");
    }
    const toolDeltas = chunks.filter((item) => item.type === "tool-call-delta");
    expect(toolDeltas.length).toBeGreaterThan(0);
    const complete = chunks.find((item) => item.type === "tool-call-complete");
    expect(complete).toBeDefined();
    if (complete && complete.type === "tool-call-complete") {
      expect(complete.call).toEqual({
        id: "tool-1",
        name: "search_docs",
        arguments: { q: "foo" },
      });
    }
    const finish = chunks.find((item) => item.type === "finish");
    expect(finish).toBeDefined();
    if (finish && finish.type === "finish") {
      expect(finish.finishReason).toBe("tool_calls");
    }
  });

  it("counts tokens and disposes tokenizer", async () => {
    const adapter = new OpenAIProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    const count = await adapter.countTokens(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      "gpt-4o-mini",
    );
    expect(count).toBeGreaterThan(0);
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});

describe("AnthropicProviderAdapter", () => {
  it("returns known model list", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    const models = await adapter.listAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.modelName.startsWith("claude")).toBe(true);
  });

  it("maps messages/tool choice and returns normalized usage with structured toolCalls", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    let capturedBody: Record<string, unknown> | undefined;
    (adapter as { client: unknown }).client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          capturedBody = body;
          return {
            content: [
              { type: "text", text: "done" },
              { type: "tool_use", id: "tool-1", name: "search", input: { q: "x" } },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 12,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 1,
              output_tokens: 4,
            },
          };
        },
        countTokens: async () => ({ input_tokens: 9 }),
      },
    };

    const result = await adapter.chat(
      {
        model: "claude-3-5-sonnet-latest",
        messages: [
          { role: "system", content: "system rule" },
          { role: "user", content: "hello" },
          { role: "tool", content: "tool output", toolCallId: "tool-1" },
        ],
        tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
        toolChoice: { function: { name: "search" } },
      } as unknown as Parameters<AnthropicProviderAdapter["chat"]>[0],
      undefined,
    );
    expect(result.content).toBe("done");
    expect(result.content.includes("tool_use")).toBe(false);
    expect(result.toolCalls).toEqual([
      { id: "tool-1", name: "search", arguments: { q: "x" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage.promptTokens).toBe(15);
    expect(capturedBody?.tool_choice).toEqual({ type: "tool", name: "search" });
    expect(capturedBody?.system).toBe("system rule");
  });

  it("serializes assistant-with-toolCalls into Anthropic tool_use blocks on the wire", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    let capturedBody: Record<string, unknown> | undefined;
    (adapter as { client: unknown }).client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          capturedBody = body;
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        countTokens: async () => ({ input_tokens: 1 }),
      },
    };
    await adapter.chat({
      model: "claude-3-5-sonnet-latest",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "fetch_url", arguments: { url: "https://x" } }],
        },
        { role: "tool", toolCallId: "toolu_1", content: "fetched" },
      ],
    });
    const wireMessages = capturedBody?.messages as Array<Record<string, unknown>>;
    const assistant = wireMessages?.[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_1",
      name: "fetch_url",
      input: { url: "https://x" },
    });
    const toolResultMessage = wireMessages?.[2] as { content: Array<Record<string, unknown>> };
    expect(toolResultMessage.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
    });
  });

  it("maps anthropic upstream errors", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      messages: {
        create: async () => {
          throw { status: 503, message: "upstream down" };
        },
        countTokens: async () => ({ input_tokens: 1 }),
      },
    };
    await expect(
      adapter.chat({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UPSTREAM_ERROR", retryable: true });
  });

  it("maps anthropic auth errors", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      messages: {
        create: async () => {
          throw { status: 401, message: "unauthorized" };
        },
        countTokens: async () => ({ input_tokens: 1 }),
      },
    };
    await expect(
      adapter.chat({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "auth" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
  });

  it("streams text_delta + tool_use blocks and aggregates into tool-call-complete", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    (adapter as { client: unknown }).client = {
      messages: {
        create: async () =>
          (async function* () {
            yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "hello" },
            };
            yield { type: "content_block_stop", index: 0 };
            yield {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tool-1", name: "search" },
            };
            yield {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "{\"x\":" },
            };
            yield {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "1}" },
            };
            yield { type: "content_block_stop", index: 1 };
            yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
            yield { type: "message_stop" };
          })(),
        countTokens: async () => ({ input_tokens: 7 }),
      },
    };

    const chunks = await collectStream(
      adapter.chatStream({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "stream" }],
      }),
    );
    const textChunk = chunks.find((c) => c.type === "text-delta");
    expect(textChunk && textChunk.type === "text-delta" && textChunk.delta).toBe("hello");
    const completed = chunks.find((c) => c.type === "tool-call-complete");
    expect(completed).toBeDefined();
    if (completed && completed.type === "tool-call-complete") {
      expect(completed.call).toEqual({
        id: "tool-1",
        name: "search",
        arguments: { x: 1 },
      });
    }
    const finish = chunks.find((c) => c.type === "finish");
    expect(finish).toBeDefined();
    if (finish && finish.type === "finish") {
      expect(finish.finishReason).toBe("tool_calls");
    }
  });

  it("uses countTokens endpoint", async () => {
    const adapter = new AnthropicProviderAdapter({ apiKey: "test-key", timeoutMs: 100 });
    let countTokensPayload: Record<string, unknown> | undefined;
    (adapter as { client: unknown }).client = {
      messages: {
        create: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
        countTokens: async (payload: Record<string, unknown>) => {
          countTokensPayload = payload;
          return { input_tokens: 11 };
        },
      },
    };

    const count = await adapter.countTokens(
      [
        { role: "system", content: "policy" },
        { role: "user", content: "hello" },
      ],
      "claude-3-5-haiku-latest",
    );
    expect(count).toBe(11);
    expect(countTokensPayload?.system).toBe("policy");
  });
});
