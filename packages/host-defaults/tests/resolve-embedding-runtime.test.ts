import { describe, expect, it } from "bun:test";
import { createDefaultEngineConfig, type EngineConfig } from "@tachu/core";
import { GeminiProviderAdapter, MockProviderAdapter, OpenAIProviderAdapter } from "@tachu/extensions";
import { resolveEmbeddingProvider, resolveEmbeddingRuntime } from "../src/resolve-embedding-runtime";

describe("resolveEmbeddingRuntime", () => {
  it("prefers capabilityMapping.embedding.provider over incidental order", () => {
    const config: EngineConfig = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "openai", model: "gpt-4o" },
          "fast-cheap": { provider: "gemini", model: "gemini-flash" },
          intent: { provider: "openai", model: "gpt-4o-mini" },
          planning: { provider: "openai", model: "gpt-4o" },
          validation: { provider: "openai", model: "gpt-4o-mini" },
          embedding: { provider: "gemini", model: "text-embedding-004" },
        },
        providerFallbackOrder: ["openai", "gemini"],
      },
      providers: {
        openai: { apiKey: "sk-openai" },
        gemini: { apiKey: "gemini-key" },
      },
    };
    const providers = [
      new OpenAIProviderAdapter({ apiKey: "sk-openai" }),
      new GeminiProviderAdapter({ apiKey: "gemini-key" }),
    ];
    const picked = resolveEmbeddingProvider(config, providers);
    expect(picked?.id).toBe("gemini");
    const resolved = resolveEmbeddingRuntime(config, providers);
    expect(resolved?.provider.id).toBe("gemini");
    expect(resolved?.model).toBe("text-embedding-004");
  });

  it("returns undefined when no embed-capable provider", () => {
    const config = createDefaultEngineConfig();
    expect(resolveEmbeddingRuntime(config, [new MockProviderAdapter()])).toBeUndefined();
  });
});
