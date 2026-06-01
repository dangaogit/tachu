import { isAbsolute, join } from "node:path";
import {
  type AdapterCallContext,
  type EmbeddingRuntime,
  type EngineConfig,
  type ObservabilityEmitter,
  type ProviderAdapter,
  type VectorIndexAdapter,
} from "@tachu/core";
import { projectMemoryRefs, type ProjectionProjectorDeps } from "@tachu/extensions/memory";
import { LocalFsVectorIndexAdapter, QdrantVectorIndexAdapter } from "@tachu/extensions/vector";
import { assertCapabilityProvided } from "./capabilities";
import { ENGINE_INIT_CORRELATION } from "./constants";
import { resolveEmbeddingRuntime } from "./resolve-embedding-runtime";

export interface ResolveProjectionStackOptions {
 /** When true, missing embedding runtime or vector index fails closed. */
  required?: boolean | undefined;
 /**
 * Explicit override. When provided, host-side adapter selection is skipped
 * and this adapter is used verbatim. Useful for tests and custom hosts that
 * want to drive a synthetic in-memory adapter.
 */
  vectorIndex?: VectorIndexAdapter | undefined;
 /**
 * Working directory for relative paths in adapter construction (e.g. the
 * LocalFs index defaults to `<cwd>/.tachu/vector-index.json`).
 */
  cwd?: string | undefined;
}

export interface ProjectionStack {
  embeddingRuntime: EmbeddingRuntime;
  vectorIndex: VectorIndexAdapter;
 /** Identifier of the concrete adapter wired (`qdrant`, `local-fs`, or `injected`). */
  adapterKind: "qdrant" | "local-fs" | "injected";
  bindProjectionProject: (
    loadEntry: ProjectionProjectorDeps["loadEntry"],
    ctx: AdapterCallContext,
  ) => (
    sessionId: string,
    refs: readonly string[],
    signal: AbortSignal,
  ) => ReturnType<typeof projectMemoryRefs>;
}

interface QdrantVectorIndexConfig {
  url?: string;
  apiKey?: string;
  collectionName?: string;
  vectorSize?: number;
}

/**
 * Select / construct a {@link VectorIndexAdapter} from config + options.
 *
 * Resolution order (first match wins):
 *
 * 1. `options.vectorIndex` — explicit injection (tests / custom hosts).
 * 2. `config.providers?.qdrant.extra.vectorIndex` — Qdrant connection details
 * (`url`, `apiKey`, `collectionName`, `vectorSize`). When present a
 * {@link QdrantVectorIndexAdapter} is constructed.
 * 3. Default: a {@link LocalFsVectorIndexAdapter} persisting to
 * `<cwd>/.tachu/vector-index.json`.
 *
 * The returned adapter is always pure-vector: it never accepts string `upsert`
 * shortcuts, in line with + /.
 */
export function resolveVectorIndexAdapter(
  config: EngineConfig,
  options: { cwd?: string | undefined; vectorIndex?: VectorIndexAdapter | undefined } = {},
): { adapter: VectorIndexAdapter; kind: "qdrant" | "local-fs" | "injected" } {
  if (options.vectorIndex !== undefined) {
    return { adapter: options.vectorIndex, kind: "injected" };
  }

  const qdrant = readQdrantConfig(config);
  if (qdrant !== undefined) {
    return {
      adapter: new QdrantVectorIndexAdapter({
        url: qdrant.url,
        ...(qdrant.apiKey !== undefined ? { apiKey: qdrant.apiKey } : {}),
        collectionName: qdrant.collectionName,
        vectorSize: qdrant.vectorSize,
      }),
      kind: "qdrant",
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(".tachu/vector-index.json")
    ? ".tachu/vector-index.json"
    : join(cwd, ".tachu", "vector-index.json");
  return {
    adapter: new LocalFsVectorIndexAdapter({ filePath }),
    kind: "local-fs",
  };
}

interface ProviderConnectionLike {
  apiKey?: string;
  baseURL?: string;
  extra?: Record<string, unknown>;
}

function readQdrantConfig(config: EngineConfig): {
  url: string;
  apiKey: string | undefined;
  collectionName: string;
  vectorSize: number;
} | undefined {
  const providers = config.providers as Record<string, ProviderConnectionLike | undefined> | undefined;
  const qdrant = providers?.qdrant;
  if (!qdrant) return undefined;
  const extra = (qdrant.extra ?? {}) as { vectorIndex?: QdrantVectorIndexConfig };
  const vi = extra.vectorIndex ?? {};
  const url = vi.url ?? qdrant.baseURL;
  const collectionName = vi.collectionName ?? "tachu-memory";
  const vectorSize = typeof vi.vectorSize === "number" ? vi.vectorSize : undefined;
  if (typeof url !== "string" || url.length === 0) return undefined;
  if (typeof vectorSize !== "number" || vectorSize <= 0) return undefined;
  return {
    url,
    apiKey: vi.apiKey ?? qdrant.apiKey,
    collectionName,
    vectorSize,
  };
}

/**
 * Wire embed + vector index for memory projection ( / / ).
 *
 * The returned {@link ProjectionStack} is plug-and-play for hosts: pass
 * `vectorIndex` and `bindProjectionProject(loadEntry, ctx)` to
 * {@link FsMemorySystem} alongside a {@link ProjectionOutbox}, and the
 * {@link ProjectionWorker} produced by `createProjectionWorker()` will index
 * memory entries through the host-resolved {@link EmbeddingRuntime} +
 * {@link VectorIndexAdapter} stack — never through the retired
 * `InMemoryMemorySystem.project()` text-embed shortcut.
 */
export function resolveProjectionStack(
  config: EngineConfig,
  providers: readonly ProviderAdapter[],
  observability: ObservabilityEmitter,
  options: ResolveProjectionStackOptions = {},
): ProjectionStack | undefined {
  const resolved = resolveEmbeddingRuntime(config, providers);
  const { adapter: vectorIndex, kind: adapterKind } = (() => {
    try {
      return resolveVectorIndexAdapter(config, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.vectorIndex !== undefined ? { vectorIndex: options.vectorIndex } : {}),
      });
    } catch (error) {
      observability.emit({
        timestamp: Date.now(),
        correlation: ENGINE_INIT_CORRELATION,
        phase: "init",
        type: "warning",
        payload: {
          status: "projection.vector-index.error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return { adapter: undefined as unknown as VectorIndexAdapter, kind: "local-fs" as const };
    }
  })();

  if (options.required === true) {
    assertCapabilityProvided(
      observability,
      "embedding-runtime",
      resolved !== undefined,
      "embedding runtime required for memory projection",
    );
    assertCapabilityProvided(
      observability,
      "vector-index",
      vectorIndex !== undefined,
      "vector index required for memory projection",
    );
  }

  if (!resolved || !vectorIndex) {
    if (options.required !== true) {
      observability.emit({
        timestamp: Date.now(),
        correlation: ENGINE_INIT_CORRELATION,
        phase: "init",
        type: "warning",
        payload: {
          status: "projection.disabled",
          reason: !resolved
            ? "no embedding runtime available"
            : "no vector index adapter configured",
        },
      });
    }
    return undefined;
  }

  observability.emit({
    timestamp: Date.now(),
    correlation: ENGINE_INIT_CORRELATION,
    phase: "init",
    type: "progress",
    payload: {
      status: "projection.available",
      providerId: resolved.provider.id,
      model: resolved.model,
      vectorIndexKind: adapterKind,
    },
  });

  return {
    embeddingRuntime: resolved.runtime,
    vectorIndex,
    adapterKind,
    bindProjectionProject: (loadEntry, ctx) => (sessionId, refs, signal) =>
      projectMemoryRefs(
        {
          embedding: resolved.runtime,
          vectorIndex,
          loadEntry,
        },
        sessionId,
        refs,
        ctx,
        signal,
      ),
  };
}
