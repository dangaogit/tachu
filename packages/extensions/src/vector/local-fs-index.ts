import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProviderError,
  type AdapterCallContext,
  type VectorHit,
  type VectorIndexAdapter,
  type VectorPayloadFilter,
  type VectorPoint,
} from "@tachu/core";

export interface LocalFsVectorIndexAdapterOptions {
 /** Persisted index file. Defaults to `.tachu/vector-index.json` under cwd. */
  filePath?: string;
 /** Debounce window (ms) before flushing buffered writes to disk. Default 500. */
  persistDebounceMs?: number;
 /**
 * Optional soft cap on the number of points retained. When exceeded, the
 * oldest insertions are evicted (FIFO) to prevent unbounded growth.
 */
  indexLimit?: number;
}

interface PersistedPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface PersistedPayload {
  version: 1;
  entries: PersistedPoint[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    aNorm += ai * ai;
    bNorm += bi * bi;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function payloadMatchesFilters(
  payload: Record<string, unknown>,
  filters: VectorPayloadFilter,
): boolean {
  const must = filters.must ?? {};
  for (const [key, value] of Object.entries(must)) {
    if (payload[key] !== value) return false;
  }
  return true;
}

/**
 * Pure-vector local filesystem index ( / / ).
 *
 * - Accepts only precomputed numeric `VectorPoint`s. Text-only `upsert(id, string, …)`
 * shortcuts from pre- hosts are rejected — production projection paths
 * must embed via {@link EmbeddingRuntime} before reaching this adapter.
 * - Persisted as a single JSON snapshot at `.tachu/vector-index.json` with
 * debounced atomic rewrites; safe for the CLI default deployment without
 * pulling in an external vector database.
 * - Implements {@link VectorIndexAdapter}, the only interface the
 * {@link ProjectionWorker} and {@link DefaultSemanticRetrievalFacade}
 * consume in production wiring.
 */
export class LocalFsVectorIndexAdapter implements VectorIndexAdapter {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly persistDebounceMs: number;
  private readonly indexLimit: number;
  private readonly entries = new Map<string, PersistedPoint>();
  private readonly initPromise: Promise<void>;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting: Promise<void> = Promise.resolve();

  constructor(options: LocalFsVectorIndexAdapterOptions = {}) {
    this.filePath = options.filePath ?? ".tachu/vector-index.json";
    this.lockPath = `${this.filePath}.lock`;
    this.persistDebounceMs = options.persistDebounceMs ?? 500;
    this.indexLimit = options.indexLimit ?? 100_000;
    this.initPromise = this.loadFromDisk();
  }

  async upsert(
    points: readonly VectorPoint[],
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.initPromise;
    for (const point of points) {
      if (typeof point.id !== "string" || point.id.length === 0) {
        throw new ProviderError(
          "PROVIDER_INVALID_REQUEST",
          "LocalFsVectorIndexAdapter.upsert requires a non-empty point id",
          { retryable: false },
        );
      }
      if (!Array.isArray(point.vector) || point.vector.length === 0) {
        throw new ProviderError(
          "PROVIDER_INVALID_REQUEST",
          `LocalFsVectorIndexAdapter.upsert requires a numeric vector for ${point.id}; ` +
            "legacy string-embed shortcuts are not supported",
          { retryable: false },
        );
      }
      if (point.vector.some((value) => typeof value !== "number")) {
        throw new ProviderError(
          "PROVIDER_INVALID_REQUEST",
          `LocalFsVectorIndexAdapter.upsert vector for ${point.id} contains non-numeric values`,
          { retryable: false },
        );
      }
      const cloned: PersistedPoint = {
        id: point.id,
        vector: [...point.vector],
        payload: { ...(point.payload ?? {}) },
      };
      if (!this.entries.has(point.id) && this.entries.size >= this.indexLimit) {
 // FIFO eviction: drop the oldest entry to keep the file bounded.
        const oldest = this.entries.keys().next();
        if (!oldest.done && oldest.value !== undefined) {
          this.entries.delete(oldest.value);
        }
      }
      this.entries.set(point.id, cloned);
    }
    this.schedulePersist();
  }

  async searchVector(
    query: number[],
    topK: number,
    filters: VectorPayloadFilter,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    signal?.throwIfAborted();
    await this.initPromise;
    if (!Array.isArray(query) || query.some((value) => typeof value !== "number")) {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "LocalFsVectorIndexAdapter.searchVector requires a numeric query vector",
        { retryable: false },
      );
    }
    const k = Math.max(0, Math.floor(topK));
    if (k === 0) return [];
    const ranked: VectorHit[] = [];
    for (const entry of this.entries.values()) {
      if (!payloadMatchesFilters(entry.payload, filters)) continue;
      const score = cosineSimilarity(query, entry.vector);
      ranked.push({ id: entry.id, score, metadata: { ...entry.payload } });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, k);
  }

  async delete(
    ids: readonly string[],
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.initPromise;
    if (ids.length === 0) return;
    let changed = false;
    for (const id of ids) {
      if (this.entries.delete(id)) changed = true;
    }
    if (changed) this.schedulePersist();
  }

 /** Test-only inspection helper. Not part of the {@link VectorIndexAdapter} contract. */
  snapshot(): PersistedPoint[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      vector: [...entry.vector],
      payload: { ...entry.payload },
    }));
  }

 /**
 * Flush any pending writes synchronously. Hosts wiring this adapter into a
 * graceful shutdown should `await flush()` before the process exits to avoid
 * losing buffered upserts.
 */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persisting = this.persisting.then(() => this.persistToDisk());
    await this.persisting;
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) return;
    let payload: PersistedPayload;
    try {
      payload = JSON.parse(raw) as PersistedPayload;
    } catch {
      return;
    }
    for (const entry of payload.entries ?? []) {
      if (
        typeof entry?.id !== "string" ||
        !Array.isArray(entry.vector) ||
        entry.vector.some((value: unknown) => typeof value !== "number")
      ) {
        continue;
      }
      this.entries.set(entry.id, {
        id: entry.id,
        vector: [...entry.vector],
        payload: { ...(entry.payload ?? {}) },
      });
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persisting = this.persisting.then(() => this.persistToDisk());
    }, this.persistDebounceMs);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await mkdir(dirname(this.lockPath), { recursive: true });
        const handle = await open(this.lockPath, "wx");
        return async () => {
          await handle.close().catch(() => undefined);
          await rm(this.lockPath, { force: true }).catch(() => undefined);
        };
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw new Error(`无法获取文件锁: ${this.lockPath}`);
  }

  private async persistToDisk(): Promise<void> {
    const release = await this.acquireLock();
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      const payload: PersistedPayload = {
        version: 1,
        entries: [...this.entries.values()].map((entry) => ({
          id: entry.id,
          vector: [...entry.vector],
          payload: { ...entry.payload },
        })),
      };
      await writeFile(tempPath, JSON.stringify(payload), "utf8");
      await rename(tempPath, this.filePath);
    } finally {
      await release();
    }
  }

 // Keep `existsSync` reachable so tree-shakers don't drop the dependency
 // when callers only invoke async paths.
  static fileExists(path: string): boolean {
    return existsSync(path);
  }
}
