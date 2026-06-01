import { createHash } from "node:crypto";
import type {
  AdapterCallContext,
  EmbeddingRuntime,
  MemoryEntry,
  VectorIndexAdapter,
} from "@tachu/core";
import type { ProjectionWorkerProjectResult } from "./projection-worker";

export interface ProjectionProjectorDeps {
  embedding: EmbeddingRuntime;
  vectorIndex: VectorIndexAdapter;
  loadEntry: (
    sessionId: string,
    ref: string,
  ) => Promise<{ entry: MemoryEntry; content: string } | null>;
  namespace?: string | undefined;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * embed source text via EmbeddingRuntime, upsert precomputed vectors, mark outbox indexed.
 */
export async function projectMemoryRefs(
  deps: ProjectionProjectorDeps,
  sessionId: string,
  refs: readonly string[],
  ctx: AdapterCallContext,
  signal: AbortSignal,
): Promise<ProjectionWorkerProjectResult[]> {
  const results: ProjectionWorkerProjectResult[] = [];
 const profile = deps.embedding.describe();
  const namespace = deps.namespace ?? sessionId;

  for (const ref of refs) {
    signal.throwIfAborted();
    const loaded = await deps.loadEntry(sessionId, ref);
    if (!loaded) {
      throw new Error(`projection source not found for ref ${ref}`);
    }
    const { entry, content } = loaded;
    const hash = contentHash(content);
    const response = await deps.embedding.embed(
      {
        model: profile.model,
        inputs: [content],
        taskType: "RETRIEVAL_DOCUMENT",
        ...(profile.dimensions !== undefined
          ? { outputDimensionality: profile.dimensions }
          : {}),
      },
      ctx,
      signal,
    );
    const vector = response.embeddings[0];
    if (!vector || vector.length === 0) {
      throw new Error(`embedding runtime returned empty vector for ref ${ref}`);
    }
    const vectorId = `${sessionId}-${entry.timestamp}`;
    await deps.vectorIndex.upsert(
      [
        {
          id: vectorId,
          vector,
          payload: {
            ref: entry.id,
            sourceKind: "memory-entry",
            contentHash: hash,
            sessionId,
            namespace,
            role: entry.role,
            timestamp: entry.timestamp,
            projectionVersion: 1,
            embeddingProvider: profile.providerId,
            embeddingModel: profile.model,
            ...(profile.dimensions !== undefined ? { embeddingDimensions: profile.dimensions } : {}),
          },
        },
      ],
      ctx,
      signal,
    );
    results.push({ ref, vectorId });
  }

  return results;
}
