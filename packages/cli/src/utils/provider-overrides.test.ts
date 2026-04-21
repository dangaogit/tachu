import { describe, expect, test } from "bun:test";
import { createDefaultEngineConfig, type EngineConfig } from "@tachu/core";
import { applyProviderConnectionOverrides } from "./provider-overrides";

const makeConfig = (provider: string): EngineConfig => ({
  ...createDefaultEngineConfig(),
  models: {
    capabilityMapping: {
      "high-reasoning": { provider, model: "test-model" },
      "fast-cheap": { provider, model: "test-model" },
      intent: { provider, model: "test-model" },
      planning: { provider, model: "test-model" },
      validation: { provider, model: "test-model" },
    },
    providerFallbackOrder: [provider],
  },
});

describe("applyProviderConnectionOverrides", () => {
  test("所有 flag 为空时原样返回", () => {
    const config = makeConfig("openai");
    const out = applyProviderConnectionOverrides(config, {});
    expect(out).toBe(config);
  });

  test("仅 --api-base 时写入 baseURL 到 high-reasoning provider", () => {
    const config = makeConfig("openai");
    const out = applyProviderConnectionOverrides(config, {
      "api-base": "https://gateway.example.com/v1",
    });
    expect(out.providers?.openai?.baseURL).toBe("https://gateway.example.com/v1");
    expect(out.providers?.openai?.apiKey).toBeUndefined();
  });

  test("--api-key 与 --organization 同时生效", () => {
    const config = makeConfig("openai");
    const out = applyProviderConnectionOverrides(config, {
      "api-key": "sk-cli",
      organization: "org-xyz",
    });
    expect(out.providers?.openai?.apiKey).toBe("sk-cli");
    expect(out.providers?.openai?.organization).toBe("org-xyz");
  });

  test("显式 --provider 优先于 capabilityMapping", () => {
    const config = makeConfig("openai");
    const out = applyProviderConnectionOverrides(config, {
      provider: "anthropic",
      "api-base": "https://anthropic.gw.example.com",
    });
    expect(out.providers?.anthropic?.baseURL).toBe("https://anthropic.gw.example.com");
    expect(out.providers?.openai).toBeUndefined();
  });

  test("mock provider 不会被注入连接参数", () => {
    const config = makeConfig("mock");
    const out = applyProviderConnectionOverrides(config, {
      "api-base": "https://any.example.com",
    });
    expect(out).toBe(config);
  });

  test("合并已有 providers 字段，不清除其它 provider", () => {
    const config: EngineConfig = {
      ...makeConfig("openai"),
      providers: {
        openai: { timeoutMs: 30_000 },
        anthropic: { baseURL: "https://keep.example.com" },
      },
    };
    const out = applyProviderConnectionOverrides(config, {
      "api-base": "https://new.example.com",
    });
    expect(out.providers?.openai).toEqual({
      timeoutMs: 30_000,
      baseURL: "https://new.example.com",
    });
    expect(out.providers?.anthropic).toEqual({ baseURL: "https://keep.example.com" });
  });

  test("空字符串 flag 被视为未传", () => {
    const config = makeConfig("openai");
    const out = applyProviderConnectionOverrides(config, {
      "api-base": "",
      "api-key": "",
      organization: "",
    });
    expect(out).toBe(config);
  });
});
