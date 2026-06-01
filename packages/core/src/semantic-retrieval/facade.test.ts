import { describe, expect, test } from "bun:test";

import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../types/context";
import { DefaultSemanticRetrievalFacade } from "./facade";
import { ProviderEmbeddingRuntimeAdapter } from "./provider-embedding";
import type { EmbeddingRuntime, RetrievalPolicyRegistry } from "./types";

const policy: RetrievalPolicyRegistry = {
  get() {
    return { topK: 2, staleFallback: "local_scan" };
  },
};

describe("DefaultSemanticRetrievalFacade", () => {
 test("uses vector index when corpus empty and vectorIndex + embedding configured", async () => {
    const embedding = {
 describe() {
        return { providerId: "fake", model: "embed", dimensions: 2 };
      },
      async embed(req: { inputs: string[] }) {
        return { embeddings: req.inputs.map(() => [1, 0]) };
      },
    };
    const vectorIndex = {
      async upsert() {},
      async searchVector(_query: number[], topK: number) {
        return [{ id: "vec-doc", score: 0.95, metadata: { namespace: "default" } }];
      },
      async delete() {},
    };
    const facade = new DefaultSemanticRetrievalFacade({
      policy,
      embedding: embedding as never,
      vectorIndex,
    });
    const result = await facade.retrieve(
      {
        caller: "memory",
        namespace: "default",
        query: "recall something",
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );
    expect(result.strategy).toBe("vector_index");
    expect(result.degraded).toBe(false);
    expect(result.hits[0]?.id).toBe("vec-doc");
  });

 test("falls back to local scan when embedding runtime is not configured", async () => {
    const facade = new DefaultSemanticRetrievalFacade({ policy });
    const result = await facade.retrieve(
      {
        caller: "tool",
        namespace: "default",
        query: "read file",
        corpus: [
          { id: "read-file", text: "read a local file from the workspace" },
          { id: "web-search", text: "search the web" },
        ],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    expect(result.strategy).toBe("local_scan");
    expect(result.degraded).toBe(true);
    expect(result.hits[0]?.id).toBe("read-file");
  });

 test("uses embedding runtime and records model/dimension compatibility", async () => {
    const embedding: EmbeddingRuntime = {
 describe() {
        return {
          providerId: "fake",
          model: "fake-embed",
          dimensions: 2,
          normalized: true,
        };
      },
      async embed(req) {
        return {
          embeddings: req.inputs.map((text) =>
            String(text).includes("read") ? [1, 0] : [0, 1],
          ),
        };
      },
    };
    const facade = new DefaultSemanticRetrievalFacade({ policy, embedding });
    const result = await facade.retrieve(
      {
        caller: "skill",
        namespace: "default",
        query: "read",
        corpus: [
          { id: "reader", text: "read files" },
          { id: "writer", text: "write files" },
        ],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    expect(result.strategy).toBe("embedding_runtime");
    expect(result.profile).toMatchObject({
      providerId: "fake",
      model: "fake-embed",
      dimensions: 2,
    });
    expect(result.hits[0]?.id).toBe("reader");
  });

 test("ProviderEmbeddingRuntimeAdapter delegates to ProviderAdapter.embed with runtime profile", async () => {
    const calls: unknown[] = [];
    const adapter = new ProviderEmbeddingRuntimeAdapter({
      provider: {
        id: "provider-a",
        name: "Provider A",
        async listAvailableModels() {
          return [];
        },
        async chat() {
          throw new Error("not used");
        },
        async *chatStream() {},
        async embed(req) {
          calls.push(req);
          return { embeddings: [[1, 0]] };
        },
      },
      model: "embed-model",
      dimensions: 2,
      normalized: true,
    });

    const result = await adapter.embed(
      {
        model: "embed-model",
        inputs: ["hello"],
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 2,
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

 expect(adapter.describe()).toMatchObject({
      providerId: "provider-a",
      model: "embed-model",
      dimensions: 2,
      normalized: true,
    });
    expect(calls).toEqual([
      {
        model: "embed-model",
        inputs: ["hello"],
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 2,
      },
    ]);
    expect(result.embeddings).toEqual([[1, 0]]);
  });

 test(" P4 ε: tokenizes Chinese via Intl.Segmenter in local_scan fallback", async () => {
    const facade = new DefaultSemanticRetrievalFacade({ policy });
    const result = await facade.retrieve(
      {
        caller: "tool",
        namespace: "default",
        query: "读取文件内容",
        corpus: [
          { id: "read-file", text: "读取本地文件并返回内容" },
          { id: "web-search", text: "搜索网络信息" },
        ],
      },
      DEFAULT_ADAPTER_CALL_CONTEXT,
    );

    expect(result.strategy).toBe("local_scan");
    expect(result.hits[0]?.id).toBe("read-file");
 // 关键：Intl.Segmenter 切出"读取""文件"等词，命中 read-file 而非 web-search。
 // 若降级到旧 `[^\p{L}\p{N}_-]+` 正则，整句被视为一个 token，匹配会失败或顺序错乱。
    expect(result.hits.find((h) => h.id === "read-file")).toBeDefined();
  });
});
