import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ADAPTER_CALL_CONTEXT,
  createDefaultEngineConfig,
  type EmbeddingRequest,
  type ProviderAdapter,
} from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions";
import {
  resolveProjectionStack,
  resolveVectorIndexAdapter,
} from "../src/resolve-projection-stack";

const embeddingProvider = (id = "fake-embed"): ProviderAdapter =>
  ({
    id,
    name: id,
    async listAvailableModels() {
      return [];
    },
    async chat() {
      throw new Error("not used in this test");
    },
    async *chatStream() {
      throw new Error("not used in this test");
    },
    async embed(request: EmbeddingRequest) {
      return {
        embeddings: request.inputs.map(() => [0.1, 0.2, 0.3]),
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      };
    },
  }) as unknown as ProviderAdapter;

describe("resolveProjectionStack", () => {
  it("fail-closed when required and no embedding runtime", () => {
    const config = createDefaultEngineConfig();
    const observability = { emit() {} };
    const vectorIndex = {
      upsert: async () => {},
      searchVector: async () => [],
      delete: async () => {},
    };
    expect(() =>
      resolveProjectionStack(
        config,
        [new MockProviderAdapter()],
        observability as never,
        { required: true, vectorIndex: vectorIndex as never },
      ),
    ).toThrow(/fail-closed/);
  });

  it("returns undefined with warning when not required and embedding missing", () => {
    const config = createDefaultEngineConfig();
    const events: Array<{ payload: { status?: string } }> = [];
    const observability = {
      emit(event: { payload: { status?: string } }) {
        events.push(event);
      },
    };
    const result = resolveProjectionStack(
      config,
      [new MockProviderAdapter()],
      observability as never,
    );
    expect(result).toBeUndefined();
    expect(events.some((e) => e.payload.status === "projection.disabled")).toBe(true);
  });

  it("with embed-capable provider + default LocalFs adapter, returns a ready-to-wire stack", async () => {
    const config = createDefaultEngineConfig();
    config.models.capabilityMapping = {
      ...config.models.capabilityMapping,
      embedding: { provider: "fake-embed", model: "fake-embed-model" },
    };
    const events: Array<{ payload: { status?: string; vectorIndexKind?: string } }> = [];
    const observability = {
      emit(event: { payload: { status?: string; vectorIndexKind?: string } }) {
        events.push(event);
      },
    };
    const stack = resolveProjectionStack(
      config,
      [embeddingProvider()],
      observability as never,
      { cwd: "/tmp/test-cwd-bl001" },
    );
    expect(stack).toBeDefined();
    expect(stack?.adapterKind).toBe("local-fs");
    const availableEvent = events.find((e) => e.payload.status === "projection.available");
    expect(availableEvent?.payload.vectorIndexKind).toBe("local-fs");

 // bind + drain a synthetic ref: this proves embed + upsert wiring.
    const loadEntry = async (sessionId: string, ref: string) => ({
      entry: {
        id: ref,
        role: "user" as const,
        content: `content-${ref}`,
        timestamp: 1_234,
        anchored: false,
      },
      content: `content-${ref}`,
    });
    const project = stack!.bindProjectionProject(loadEntry, DEFAULT_ADAPTER_CALL_CONTEXT);
    const results = await project("s-1", ["ref-a"], new AbortController().signal);
    expect(results).toEqual([{ ref: "ref-a", vectorId: "s-1-1234" }]);
  });

  it("resolveVectorIndexAdapter constructs Qdrant adapter when config.providers.qdrant carries connection details", () => {
    const config = createDefaultEngineConfig();
    config.providers = {
      qdrant: {
        baseURL: "http://qdrant.local:6333",
        extra: {
          vectorIndex: {
            url: "http://qdrant.local:6333",
            apiKey: "test-token",
            collectionName: "tachu-test",
            vectorSize: 1536,
          },
        },
      },
    };
    const resolved = resolveVectorIndexAdapter(config, { cwd: "/tmp" });
    expect(resolved.kind).toBe("qdrant");
    expect(resolved.adapter).toBeDefined();
  });

  it("resolveVectorIndexAdapter defaults to LocalFs adapter when no provider config exists", () => {
    const config = createDefaultEngineConfig();
    const resolved = resolveVectorIndexAdapter(config, { cwd: "/tmp" });
    expect(resolved.kind).toBe("local-fs");
    expect(resolved.adapter).toBeDefined();
  });
});
