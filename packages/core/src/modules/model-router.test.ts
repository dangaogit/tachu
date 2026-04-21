import { describe, expect, test } from "bun:test";
import { RegistryError } from "../errors";
import type { EngineConfig } from "../types";
import { DefaultModelRouter } from "./model-router";
import { NoopProvider } from "./provider";

const config: EngineConfig = {
  registry: { descriptorPaths: [], enableVectorIndexing: false },
  runtime: { planMode: false, maxConcurrency: 4, defaultTaskTimeoutMs: 1000, failFast: false },
  memory: {
    contextTokenLimit: 1000,
    compressionThreshold: 0.8,
    headKeep: 3,
    tailKeep: 3,
    archivePath: ".tachu/archive/x.jsonl",
    vectorIndexLimit: 1000,
  },
  budget: { maxTokens: 1000, maxToolCalls: 10, maxWallTimeMs: 10000 },
  safety: {
    maxInputSizeBytes: 1024,
    maxRecursionDepth: 3,
    workspaceRoot: process.cwd(),
    promptInjectionPatterns: [],
  },
  models: {
    capabilityMapping: {
      intent: { provider: "noop", model: "dev-small" },
      planning: { provider: "unknown-provider", model: "x" },
      validation: { provider: "noop", model: "not-exist" },
    },
    providerFallbackOrder: ["noop"],
  },
  observability: { enabled: true, maskSensitiveData: true },
  hooks: { writeHookTimeout: 1000, failureBehavior: "continue" },
};

describe("DefaultModelRouter", () => {
  test("resolves mapping and checks provider capabilities", async () => {
    const router = new DefaultModelRouter(config);
    const route = router.resolve("intent");
    expect(route.model).toBe("dev-small");
    const override = router.resolve({
      task: "intent",
      override: { provider: "noop", model: "dev-large" },
    });
    expect(override.model).toBe("dev-large");
    const check = await router.checkCapabilities([new NoopProvider()]);
    expect(check.warnings.length).toBeGreaterThanOrEqual(2);
    expect(check.providers.noop?.available).toBe(true);
    expect(Array.isArray(check.providers.noop?.models)).toBe(true);
    expect(check.capabilityCoverage.intent).toBe(true);
    expect(check.capabilityCoverage.planning).toBe(false);
    expect(check.capabilityCoverage.validation).toBe(false);
    expect(check.missingCapabilities).toContain("planning");
    expect(check.missingCapabilities).toContain("validation");
    expect(check.valid).toBe(false);
  });

  test("throws when mapping is missing", () => {
    const router = new DefaultModelRouter(config);
    expect(() => router.resolve("missing-capability")).toThrow(RegistryError);
  });
});

