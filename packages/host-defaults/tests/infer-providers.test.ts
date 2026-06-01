import { describe, expect, it } from "bun:test";
import { createDefaultEngineConfig, type EngineConfig } from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions";
import { inferProviders } from "../src/providers";

describe("inferProviders", () => {
  it("collects mock provider from capabilityMapping", () => {
    const config: EngineConfig = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "mock", model: "mock-chat" },
          "fast-cheap": { provider: "mock", model: "mock-chat" },
          intent: { provider: "mock", model: "mock-chat" },
          planning: { provider: "mock", model: "mock-chat" },
          validation: { provider: "mock", model: "mock-chat" },
        },
        providerFallbackOrder: ["mock"],
      },
    };
    const providers = inferProviders(config);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(MockProviderAdapter);
    expect(providers[0]?.id).toBe("mock");
  });

  it("filters noop from fallback order", () => {
    const config: EngineConfig = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "noop", model: "x" },
          "fast-cheap": { provider: "noop", model: "x" },
          intent: { provider: "noop", model: "x" },
          planning: { provider: "noop", model: "x" },
          validation: { provider: "noop", model: "x" },
        },
        providerFallbackOrder: ["noop"],
      },
    };
    expect(inferProviders(config)).toHaveLength(0);
  });

  it("deduplicates openai and qwen from mapping", () => {
    const config: EngineConfig = {
      ...createDefaultEngineConfig(),
      models: {
        capabilityMapping: {
          "high-reasoning": { provider: "openai", model: "gpt-4o" },
          "fast-cheap": { provider: "qwen", model: "qwen-turbo" },
          intent: { provider: "openai", model: "gpt-4o-mini" },
          planning: { provider: "qwen", model: "qwen-plus" },
          validation: { provider: "openai", model: "gpt-4o-mini" },
        },
        providerFallbackOrder: ["openai", "qwen"],
      },
      providers: {
        openai: { apiKey: "sk-test" },
        qwen: { apiKey: "sk-qwen" },
      },
    };
    const providers = inferProviders(config);
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["openai", "qwen"]);
  });
});
