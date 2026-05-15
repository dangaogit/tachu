import { describe, expect, it } from "bun:test";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "@tachu/core";
import {
  GeminiProviderAdapter,
  type GeminiClientLike,
} from "../../src/providers/gemini";

describe("GeminiProviderAdapter", () => {
  it("maps native multimodal chat, tools, structured output, media, and thought signatures", async () => {
    let captured: Record<string, unknown> | undefined;
    const client: GeminiClientLike = {
      models: {
        generateContent: async (params) => {
          captured = params;
          return {
            responseId: "resp-1",
            modelVersion: "gemini-test",
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    { text: "private reasoning", thought: true, thoughtSignature: "sig-thought" },
                    { text: "{\"ok\":true}" },
                    { inlineData: { mimeType: "image/png", data: "QUJD" } },
                    {
                      functionCall: {
                        id: "call-1",
                        name: "lookup",
                        args: { q: "gemini" },
                      },
                      thoughtSignature: "sig-tool",
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 3,
              thoughtsTokenCount: 2,
              totalTokenCount: 15,
            },
          };
        },
        generateContentStream: async function* () {},
        embedContent: async () => ({ embeddings: [] }),
      },
    };
    const adapter = new GeminiProviderAdapter({ client, timeoutMs: 100 });

    const response = await adapter.chat(
      {
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are terse." },
          {
            role: "user",
            content: [
              { type: "text", text: "analyze this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "file", file: { mimeType: "application/pdf", data: "BBBB", name: "a.pdf" } },
            ],
          },
        ],
        tools: [{ name: "lookup", description: "search", inputSchema: { type: "object" } }],
        structuredOutput: { schema: { type: "object", properties: { ok: { type: "boolean" } } } },
        responseModalities: ["TEXT", "IMAGE"],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    const body = captured as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      config: Record<string, unknown>;
    };
    expect(body.config.responseJsonSchema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    expect(body.config.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "lookup",
            description: "search",
            parametersJsonSchema: { type: "object" },
          },
        ],
      },
    ]);
    expect(body.config.systemInstruction).toMatchObject({
      parts: [{ text: "You are terse." }],
    });
    expect(body.contents[0]!.parts).toMatchObject([
      { text: "analyze this" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
      { inlineData: { mimeType: "application/pdf", data: "BBBB" } },
    ]);

    expect(response.content).toBe("{\"ok\":true}");
    expect(response.structured).toEqual({ ok: true });
    expect(response.reasoningContent).toBe("private reasoning");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage.completionTokens).toBe(5);
    expect(response.media?.[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: "QUJD",
    });
    expect(response.images?.[0]?.url).toBe("data:image/png;base64,QUJD");
    expect(response.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "lookup",
      arguments: { q: "gemini" },
      providerMetadata: { gemini: { thoughtSignature: "sig-tool" } },
    });
    expect(response.providerMetadata).toMatchObject({
      provider: "gemini",
      responseId: "resp-1",
    });
    const thoughtParts = response.providerMetadata?.geminiThoughtParts as
      | Array<Record<string, unknown>>
      | undefined;
    expect(thoughtParts?.[0]).toMatchObject({
      text: "private reasoning",
      thoughtSignature: "sig-thought",
    });
  });

  it("replays Gemini thoughtSignature metadata in assistant history", async () => {
    let captured: Record<string, unknown> | undefined;
    const client: GeminiClientLike = {
      models: {
        generateContent: async (params) => {
          captured = params;
          return {
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
          };
        },
        generateContentStream: async function* () {},
        embedContent: async () => ({ embeddings: [] }),
      },
    };
    const adapter = new GeminiProviderAdapter({ client, timeoutMs: 100 });

    await adapter.chat(
      {
        model: "gemini-2.5-pro",
        messages: [
          {
            role: "assistant",
            content: "need tool",
            providerMetadata: {
              geminiThoughtParts: [
                { text: "hidden plan", thought: true, thoughtSignature: "sig-1" },
              ],
            },
            toolCalls: [
              {
                id: "call-1",
                name: "lookup",
                arguments: { q: "x" },
                providerMetadata: { gemini: { thoughtSignature: "sig-tool" } },
              },
            ],
          },
          { role: "tool", toolCallId: "call-1", name: "lookup", content: "{\"ok\":true}" },
        ],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    const body = captured as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]).toMatchObject({
      role: "model",
      parts: [
        { text: "hidden plan", thought: true, thoughtSignature: "sig-1" },
        { text: "need tool" },
        {
          functionCall: { id: "call-1", name: "lookup", args: { q: "x" } },
          thoughtSignature: "sig-tool",
        },
      ],
    });
    expect(body.contents[1]).toMatchObject({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call-1",
            name: "lookup",
            response: { ok: true },
          },
        },
      ],
    });
  });

  it("embeds content and reranks by cosine similarity", async () => {
    const embedCalls: Record<string, unknown>[] = [];
    const client: GeminiClientLike = {
      models: {
        generateContent: async () => ({ candidates: [] }),
        generateContentStream: async function* () {},
        embedContent: async (params) => {
          embedCalls.push(params);
          if (embedCalls.length === 1) {
            return { embeddings: [{ values: [1, 0] }] };
          }
          return { embeddings: [{ values: [0, 1] }, { values: [0.9, 0.1] }] };
        },
      },
    };
    const adapter = new GeminiProviderAdapter({ client, timeoutMs: 100 });

    const result = await adapter.rerank(
      {
        model: "text-embedding-004",
        query: "gemini native sdk",
        documents: [{ text: "unrelated" }, { text: "gemini provider sdk" }],
        topK: 1,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.index).toBe(1);
    expect(embedCalls[0]?.config).toMatchObject({ taskType: "RETRIEVAL_QUERY" });
    expect(embedCalls[1]?.config).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT" });
  });
});
