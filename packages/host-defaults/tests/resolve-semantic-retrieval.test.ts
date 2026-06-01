import { describe, expect, it } from "bun:test";
import { createDefaultEngineConfig } from "@tachu/core";
import { GeminiProviderAdapter, MockProviderAdapter } from "@tachu/extensions";
import { resolveSemanticRetrievalFacade } from "../src/semantic-retrieval";

describe("resolveSemanticRetrievalFacade", () => {
  it("emits status=available when provider exposes embed()", () => {
    const events: Array<{ phase?: string; payload?: unknown }> = [];
    const observability = {
      emit(event: { phase?: string; payload?: unknown }) {
        events.push(event);
      },
    };
    const config = createDefaultEngineConfig();
    const provider = new GeminiProviderAdapter({ apiKey: "test-key" });
    const { facade } = resolveSemanticRetrievalFacade(
      config,
      [provider],
      observability as never,
    );
    expect(facade).toBeDefined();
    const semantic = events.find((e) => e.phase === "semantic-retrieval");
    expect((semantic?.payload as { status?: string }).status).toBe("available");
    expect((semantic?.payload as { providerId?: string }).providerId).toBe("gemini");
  });

  it("emits status=disabled when no embed-capable provider", () => {
    const events: Array<{ phase?: string; payload?: unknown }> = [];
    const observability = {
      emit(event: { phase?: string; payload?: unknown }) {
        events.push(event);
      },
    };
    const config = createDefaultEngineConfig();
    const { facade } = resolveSemanticRetrievalFacade(
      config,
      [new MockProviderAdapter()],
      observability as never,
    );
    expect(facade).toBeDefined();
    const semantic = events.find((e) => e.phase === "semantic-retrieval");
    expect((semantic?.payload as { status?: string }).status).toBe("disabled");
  });
});
