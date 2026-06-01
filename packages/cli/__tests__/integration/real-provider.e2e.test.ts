/**
 * Opt-in real-provider end-to-end smoke.
 *
 * Skipped by default. Enable only when credentials are preconfigured:
 *
 * TACHU_REAL_E2E=1 \
 * TACHU_E2E_PROVIDER=openai \
 * TACHU_E2E_API_KEY=sk-... \
 * TACHU_E2E_API_BASE=https://your-gateway/v1 \ # optional
 * TACHU_E2E_MODEL=gpt-4o-mini \ # optional
 * bun test packages/cli/__tests__/integration/real-provider.e2e.test.ts
 *
 * Provider-specific env fallbacks when TACHU_E2E_API_KEY is unset:
 * openai → OPENAI_API_KEY, OPENAI_BASE_URL
 * anthropic → ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL
 * qwen → DASHSCOPE_API_KEY (or QWEN_API_KEY)
 * gemini → GEMINI_API_KEY (or GOOGLE_API_KEY)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDefaultEngineConfig,
  type EngineConfig,
  type EngineOutput,
  type ExecutionContext,
  type ProviderAdapter,
} from "@tachu/core";
import { GeminiProviderAdapter } from "@tachu/extensions";
import { createEngineWithProjection } from "../../src/engine-factory";
import { scanDescriptors } from "../../src/config-loader/descriptor-scanner";
import { setNoColor, resetColorState } from "../../src/renderer/color";

const ENABLED = process.env.TACHU_REAL_E2E === "1";
const PROVIDER = (process.env.TACHU_E2E_PROVIDER ?? "openai").trim().toLowerCase();

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  qwen: "qwen-plus",
  gemini: "gemini-2.0-flash",
};

function readCredential(name: string): string {
  return (process.env[name] ?? "").trim();
}

function resolveApiKey(provider: string): string {
  const explicit = readCredential("TACHU_E2E_API_KEY");
  if (explicit) return explicit;
  switch (provider) {
    case "openai":
      return readCredential("OPENAI_API_KEY");
    case "anthropic":
      return readCredential("ANTHROPIC_API_KEY");
    case "qwen":
      return readCredential("DASHSCOPE_API_KEY") || readCredential("QWEN_API_KEY");
    case "gemini":
      return readCredential("GEMINI_API_KEY") || readCredential("GOOGLE_API_KEY");
    default:
      return "";
  }
}

function resolveApiBase(provider: string): string | undefined {
  const explicit = readCredential("TACHU_E2E_API_BASE");
  if (explicit) return explicit;
  switch (provider) {
    case "openai":
      return readCredential("OPENAI_BASE_URL") || undefined;
    case "anthropic":
      return readCredential("ANTHROPIC_BASE_URL") || undefined;
    default:
      return undefined;
  }
}

const API_KEY = resolveApiKey(PROVIDER);
const API_BASE = resolveApiBase(PROVIDER);
const MODEL = (process.env.TACHU_E2E_MODEL ?? DEFAULT_MODELS[PROVIDER] ?? "gpt-4o-mini").trim();
const run = ENABLED && API_KEY ? test : test.skip;

let tmpDir: string;

function buildConfig(provider: string, model: string): EngineConfig {
  const route = { provider, model };
  const providersBlock =
    API_KEY || API_BASE
      ? {
          [provider]: {
            ...(API_KEY ? { apiKey: API_KEY } : {}),
            ...(API_BASE ? { baseURL: API_BASE } : {}),
          },
        }
      : undefined;

  return {
    ...createDefaultEngineConfig(),
    registry: {
      descriptorPaths: [".tachu"],
      enableVectorIndexing: false,
    },
    memory: {
      ...createDefaultEngineConfig().memory,
      persistence: "memory",
    },
    models: {
      capabilityMapping: {
        "high-reasoning": route,
        "fast-cheap": route,
        intent: route,
        planning: route,
        validation: route,
      },
      providerFallbackOrder: [provider],
    },
    ...(providersBlock ? { providers: providersBlock } : {}),
    observability: { enabled: false, maskSensitiveData: true },
  };
}

function buildExplicitProviders(provider: string): ProviderAdapter[] | undefined {
  if (provider !== "gemini") return undefined;
  return [
    new GeminiProviderAdapter({
      apiKey: API_KEY,
      ...(API_BASE ? { baseURL: API_BASE } : {}),
    }),
  ];
}

const createTestContext = (sessionId: string): ExecutionContext => {
  const requestId = randomUUID();
  return {
    correlation: {
      traceId: randomUUID(),
      requestId,
      sessionId,
      turnId: requestId,
    },
    principal: {},
    budget: { maxDurationMs: 120_000 },
    scopes: ["*"],
    startedAt: Date.now(),
  };
};

describe("real provider e2e (opt-in)", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  run(
    `TACHU_REAL_E2E=1 runs a simple prompt via ${PROVIDER}`,
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "tachu-real-e2e-"));
      const tachyDir = join(tmpDir, ".tachu");
      await mkdir(join(tachyDir, "rules"), { recursive: true });
      await mkdir(join(tachyDir, "skills"), { recursive: true });
      await mkdir(join(tachyDir, "tools"), { recursive: true });
      await mkdir(join(tachyDir, "agents"), { recursive: true });

      const config = buildConfig(PROVIDER, MODEL);
      const registry = await scanDescriptors(tachyDir, false);
      const explicitProviders = buildExplicitProviders(PROVIDER);
      const { engine } = createEngineWithProjection(config, {
        cwd: tmpDir,
        registry,
        ...(explicitProviders ? { providers: explicitProviders } : {}),
      });

      let finalOutput: EngineOutput | undefined;
      for await (const chunk of engine.runStream(
        {
          content: "Reply with exactly the single word: pong",
          metadata: { modality: "text" },
        },
        createTestContext(`real-e2e-${PROVIDER}`),
      )) {
        if (chunk.type === "done") {
          finalOutput = chunk.output;
        }
      }

      await engine.dispose();

      expect(finalOutput).toBeDefined();
      expect(finalOutput!.metadata.outcome).toBe("completed");
      const text =
        typeof finalOutput!.content === "string"
          ? finalOutput!.content
          : JSON.stringify(finalOutput!.content);
      expect(text.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );
});
