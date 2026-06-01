import type {
  EmbeddingRuntime,
  RetrievalPolicyRegistry,
  SemanticRetrievalFacade,
  SemanticRetrievalHit,
  SemanticRetrievalRequest,
  SemanticRetrievalResult,
  VectorIndexAdapter,
} from "./types";

export interface DefaultSemanticRetrievalFacadeOptions {
  policy: RetrievalPolicyRegistry;
  embedding?: EmbeddingRuntime | undefined;
  vectorIndex?: VectorIndexAdapter | undefined;
 /** Namespace filter key stored in vector payload (default `namespace`). */
  vectorNamespaceKey?: string | undefined;
}

/**
 * 中文/多语言 tokenize。
 *
 * 优先使用 `Intl.Segmenter`（granularity: word），可正确切分中日韩、阿语等无空格语言；
 * 在运行时不可用（极旧引擎）时回退到 Unicode 类别正则。
 * 这是默认 fallback；当 embedding runtime 在线时实际不会进入此路径。
 */
const segmenter: Intl.Segmenter | undefined = (() => {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return new Intl.Segmenter(undefined, { granularity: "word" });
    }
  } catch {
 // fall through to regex
  }
  return undefined;
})();

const tokenize = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  if (segmenter) {
    const tokens = new Set<string>();
    for (const segment of segmenter.segment(lower)) {
      if (segment.isWordLike && segment.segment.length > 1) {
        tokens.add(segment.segment);
      }
    }
    return tokens;
  }
  return new Set(
    lower.split(/[^\p{L}\p{N}_-]+/u).filter((part) => part.length > 1),
  );
};

const localScore = (query: string, text: string): number => {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const d = tokenize(text);
  let overlap = 0;
  for (const item of q) {
    if (d.has(item) || text.toLowerCase().includes(item)) {
      overlap += 1;
    }
  }
  return overlap / q.size;
};

const cosine = (left: number[], right: number[]): number => {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    a += l * l;
    b += r * r;
  }
  if (a === 0 || b === 0) return 0;
  return dot / (Math.sqrt(a) * Math.sqrt(b));
};

const rankLocal = (
  request: SemanticRetrievalRequest,
  topK: number,
  threshold = 0,
): SemanticRetrievalHit[] =>
  [...(request.corpus ?? [])]
    .map((item) => ({ id: item.id, score: localScore(request.query, item.text) }))
    .filter((item) => item.score > threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);

export class DefaultSemanticRetrievalFacade implements SemanticRetrievalFacade {
  constructor(private readonly options: DefaultSemanticRetrievalFacadeOptions) {}

  async retrieve(
    request: SemanticRetrievalRequest,
    ctx: import("../types/context").AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<SemanticRetrievalResult> {
    const policy = this.options.policy.get(request.caller, request.namespace);
    const namespaceKey = this.options.vectorNamespaceKey ?? "namespace";

    if (
      this.options.vectorIndex &&
      this.options.embedding &&
      (!request.corpus || request.corpus.length === 0)
    ) {
 const profile = this.options.embedding.describe();
      const response = await this.options.embedding.embed(
        {
          model: profile.model,
          inputs: [request.query],
          taskType: "RETRIEVAL_QUERY",
          ...(profile.dimensions !== undefined
            ? { outputDimensionality: profile.dimensions }
            : {}),
        },
        ctx,
        signal,
      );
      const queryVector = response.embeddings[0] ?? [];
      const hits = await this.options.vectorIndex.searchVector(
        queryVector,
        policy.topK,
        { must: { [namespaceKey]: request.namespace } },
        ctx,
        signal,
      );
      const threshold = policy.minScoreThreshold ?? 0;
      return {
        caller: request.caller,
        namespace: request.namespace,
        strategy: "vector_index",
        hits: hits
          .filter((item) => item.score > threshold)
          .map((item) => ({ id: item.id, score: item.score })),
        degraded: false,
        profile,
      };
    }

    if (!request.corpus || request.corpus.length === 0) {
      return {
        caller: request.caller,
        namespace: request.namespace,
        strategy: "bypass",
        hits: [],
        degraded: this.options.embedding === undefined,
        ...(this.options.embedding !== undefined
 ? { profile: this.options.embedding.describe() }
          : {}),
      };
    }
    if (!this.options.embedding) {
      if (policy.staleFallback === "throw_error") {
        throw new Error("semantic retrieval embedding runtime is not configured");
      }
      if (policy.staleFallback === "bypass_semantic") {
        return {
          caller: request.caller,
          namespace: request.namespace,
          strategy: "bypass",
          hits: [],
          degraded: true,
        };
      }
      return {
        caller: request.caller,
        namespace: request.namespace,
        strategy: "local_scan",
        hits: rankLocal(request, policy.topK, policy.minScoreThreshold ?? 0),
        degraded: true,
      };
    }
 const profile = this.options.embedding.describe();
    const response = await this.options.embedding.embed(
      {
        model: profile.model,
        inputs: [request.query, ...request.corpus.map((item) => item.text)],
        taskType: "SEMANTIC_SIMILARITY",
        ...(profile.dimensions !== undefined
          ? { outputDimensionality: profile.dimensions }
          : {}),
      },
      ctx,
      signal,
    );
    const queryVector = response.embeddings[0] ?? [];
    const hits = request.corpus
      .map((item, index) => ({
        id: item.id,
        score: cosine(queryVector, response.embeddings[index + 1] ?? []),
      }))
      .filter((item) => item.score > (policy.minScoreThreshold ?? 0))
      .sort((left, right) => right.score - left.score)
      .slice(0, policy.topK);
    return {
      caller: request.caller,
      namespace: request.namespace,
      strategy: "embedding_runtime",
      hits,
      degraded: false,
      profile,
    };
  }
}
