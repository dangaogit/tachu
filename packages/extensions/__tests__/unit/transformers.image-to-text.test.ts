import { describe, expect, it } from "bun:test";
import { ImageToTextTransformer } from "../../src/transformers/image-to-text";
import type { ProviderAdapter, ChatRequest, ChatResponse, ChatStreamChunk, ModelInfo } from "@tachu/core";

class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  readonly name = "fake";

  async listAvailableModels(): Promise<ModelInfo[]> {
    return [];
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    return {
      content: "image description",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async *chatStream(): AsyncIterable<ChatStreamChunk> {
    yield { type: "finish", finishReason: "stop" };
  }
}

describe("ImageToTextTransformer", () => {
  it("transforms image payload into text envelope", async () => {
    const transformer = new ImageToTextTransformer({ provider: new FakeProvider() });
    const output = await transformer.transform({
      content: { imageUrl: "https://example.com/a.png", mimeType: "image/png" },
      metadata: { modality: "image", mimeType: "image/png" },
    });
    expect(output.metadata.modality).toBe("text");
    expect(output.content).toBe("image description");
  });
});
