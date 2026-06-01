/**
 * @fileoverview Legacy `LocalFsVectorStore` fixture ().
 *
 * This module was the original CLI-default file-backed `VectorStore`
 * implementation. It exposed `embed(texts)` and accepted `string` inputs to
 * `upsert(id, text, …)`, meaning a "production" host could inadvertently let
 * raw text reach `VectorStore.upsert` and rely on the in-memory hash-bag
 * embedder. retired this surface in favour of the policy-aware
 * `EmbeddingRuntime` + `VectorIndexAdapter` stack (see
 * {@link LocalFsVectorIndexAdapter} for the pure-vector replacement).
 *
 * moved this class out of the production source tree (it used to live
 * at `packages/extensions/src/vector/local-fs.ts`). It is preserved here so
 * legacy `VectorStore`-shaped tests still have a tangible disk-backed
 * implementation to exercise, **without** the `check:no-hash-embed` gate
 * picking it up as a production text-embedding adapter.
 *
 * Do not import this module from `packages/extensions/src/`, `packages/cli/src/`
 * or any other production source path.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  InMemoryVectorStore,
  type AdapterCallContext,
  type SparseVector,
  type VectorHit,
  type VectorPayloadFilter,
  type VectorSearchQuery,
  type VectorStore,
} from "@tachu/core";

export interface LegacyLocalFsVectorStoreOptions {
  filePath?: string;
  persistDebounceMs?: number;
  indexLimit?: number;
}

interface PersistedEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

interface PersistedPayload {
  entries: PersistedEntry[];
}

const debugTextVector = (text: string): number[] => {
  const lower = text.toLowerCase();
  return [
    lower.includes("hello") ? 1 : 0,
    lower.includes("persist") ? 1 : 0,
    lower.includes("alpha") ? 1 : 0,
    lower.includes("beta") ? 1 : 0,
    Math.max(1, lower.length) / 100,
  ];
};

/**
 * Legacy file-backed `VectorStore` (retired in ). Kept as a test fixture
 * so we can still verify durability/locking semantics on the deprecated
 * `VectorStore` interface, but explicitly **not** part of the `@tachu/extensions`
 * public surface.
 *
 * @deprecated Use {@link LocalFsVectorIndexAdapter} from `@tachu/extensions`.
 */
export class LegacyLocalFsVectorStore implements VectorStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly persistDebounceMs: number;
  private readonly store: InMemoryVectorStore;
  private readonly entries = new Map<string, PersistedEntry>();
  private readonly initPromise: Promise<void>;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting = Promise.resolve();

  constructor(options: LegacyLocalFsVectorStoreOptions = {}) {
    this.filePath = options.filePath ?? ".tachu/vectors.json";
    this.lockPath = `${this.filePath}.lock`;
    this.persistDebounceMs = options.persistDebounceMs ?? 500;
    this.store = new InMemoryVectorStore({
      ...(options.indexLimit !== undefined ? { indexLimit: options.indexLimit } : {}),
    });
    this.initPromise = this.loadFromDisk();
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.initPromise;
    return texts.map(debugTextVector);
  }

  async upsert(
    id: string,
    vectorOrText: number[] | string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.initPromise;
    const vector =
      typeof vectorOrText === "string" ? debugTextVector(vectorOrText) : vectorOrText;
    await this.store.upsert(id, vector, metadata);
    this.entries.set(id, { id, vector, metadata });
    this.schedulePersist();
  }

  async search(
    query: VectorSearchQuery | { query: number[] | string; topK: number },
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    await this.initPromise;
    const vectorQuery =
      typeof query.query === "string"
        ? { ...query, query: debugTextVector(query.query) }
        : query;
    return this.store.search(vectorQuery, ctx, signal);
  }

  async hybridSearch(
    denseVector: number[],
    sparseVector: SparseVector | null,
    k: number,
    filters: VectorPayloadFilter,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<VectorHit[]> {
    await this.initPromise;
    return this.store.hybridSearch(denseVector, sparseVector, k, filters, ctx, signal);
  }

  async delete(id: string): Promise<void> {
    await this.initPromise;
    await this.store.delete(id);
    this.entries.delete(id);
    this.schedulePersist();
  }

  async clear(): Promise<void> {
    await this.initPromise;
    await this.store.clear();
    this.entries.clear();
    this.schedulePersist();
  }

  size(): number {
    return this.entries.size;
  }

  async snapshot(path: string): Promise<void> {
    await this.initPromise;
    const payload: PersistedPayload = { entries: [...this.entries.values()] };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persisting = this.persisting.then(() => this.persistToDisk());
    }, this.persistDebounceMs);
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) {
      return;
    }
    const payload = JSON.parse(raw) as PersistedPayload;
    for (const entry of payload.entries ?? []) {
      await this.store.upsert(entry.id, entry.vector, entry.metadata);
      this.entries.set(entry.id, entry);
    }
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
      const payload: PersistedPayload = { entries: [...this.entries.values()] };
      await writeFile(tempPath, JSON.stringify(payload), "utf8");
      await rename(tempPath, this.filePath);
    } finally {
      await release();
    }
  }
}
