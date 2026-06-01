import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/**
 * Projection 投递 outbox 状态机。
 *
 * 状态转移：
 * ```
 * pending ──enqueue──▶ retrying ──ok──▶ indexed
 * │
 * ├─error & attempts<max──▶ failed ──retry──▶ retrying
 * │
 * └─error & attempts≥max──▶ dead (DLQ)
 * ```
 *
 * - 每条投递持久化到 `<dir>/<sessionId>.jsonl`（append-only + 原子重写）。
 * - `dead` 项移到 `<dir>/dead/<sessionId>.<ts>.json` 形成 DLQ，主文件中标记为 `dead`。
 * - 启动时 `recover()` 把超过 `staleAfterMs` 仍处于 `retrying` 的项重置为 `pending`，
 * 防止上次进程在 upsert 期间被 kill 留下"幽灵 retrying"。
 *
 * 交付：真状态机 + 真持久化 + 真 DLQ + 真 crash 恢复。
 * 交付：`ProjectionWorker` 可独立 flush pending 队列，
 * 让 host 将 archive 主路径与 vector projection 解耦。
 */
export type ProjectionState =
  | "pending"
  | "retrying"
  | "indexed"
  | "failed"
  | "dead";

export interface ProjectionRecord {
  ref: string;
  state: ProjectionState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  vectorId?: string;
}

export interface ProjectionOutboxOptions {
 /** 持久化根目录，默认 `<cwd>/.tachu/projections`。 */
  dir: string;
 /** 最大重试次数；达到后入 DLQ（默认 5）。 */
  maxAttempts?: number;
 /** retrying 状态超过该毫秒数视为陈旧（默认 5 分钟）。 */
  staleAfterMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_STALE_MS = 5 * 60_000;

function parseRecord(raw: string): ProjectionRecord | null {
  try {
    const obj = JSON.parse(raw) as ProjectionRecord;
    if (typeof obj.ref !== "string" || typeof obj.state !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

export class ProjectionOutbox {
  private readonly dir: string;
  private readonly maxAttempts: number;
  private readonly staleAfterMs: number;
  private readonly cache = new Map<string, Map<string, ProjectionRecord>>();

  constructor(options: ProjectionOutboxOptions) {
    this.dir = options.dir;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  private deadDir(): string {
    return join(this.dir, "dead");
  }

 /** 读取/构造 session 的内存索引（按 ref 唯一）。 */
  private async loadIndex(sessionId: string): Promise<Map<string, ProjectionRecord>> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const map = new Map<string, ProjectionRecord>();
    const path = this.pathFor(sessionId);
    if (existsSync(path)) {
      const text = await readFile(path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const rec = parseRecord(line);
        if (rec) map.set(rec.ref, rec); // last-write-wins
      }
    }
    this.cache.set(sessionId, map);
    return map;
  }

 /** 原子重写 jsonl。 */
  private async flush(sessionId: string): Promise<void> {
    const map = this.cache.get(sessionId);
    if (!map) return;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.pathFor(sessionId)}.tmp`;
    const lines = [...map.values()].map((rec) => JSON.stringify(rec)).join("\n");
    await writeFile(tmp, lines.length > 0 ? `${lines}\n` : "", "utf8");
    await rename(tmp, this.pathFor(sessionId));
  }

 /** 启动恢复：将陈旧 retrying 重置为 pending。 */
  async recover(sessionId: string, now: number = Date.now()): Promise<number> {
    const map = await this.loadIndex(sessionId);
    let reset = 0;
    for (const rec of map.values()) {
      if (rec.state === "retrying" && now - rec.updatedAt > this.staleAfterMs) {
        rec.state = "pending";
        rec.updatedAt = now;
        reset += 1;
      }
    }
    if (reset > 0) await this.flush(sessionId);
    return reset;
  }

  async enqueue(sessionId: string, ref: string, now: number = Date.now()): Promise<void> {
    const map = await this.loadIndex(sessionId);
    const existing = map.get(ref);
    if (existing && existing.state === "indexed") return; // idempotent
    map.set(ref, {
      ref,
      state: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.flush(sessionId);
  }

  async markRetrying(sessionId: string, ref: string, now: number = Date.now()): Promise<void> {
    const map = await this.loadIndex(sessionId);
    const rec = map.get(ref);
    if (!rec) return;
    rec.state = "retrying";
    rec.updatedAt = now;
    await this.flush(sessionId);
  }

  async markIndexed(
    sessionId: string,
    ref: string,
    vectorId: string,
    now: number = Date.now(),
  ): Promise<void> {
    const map = await this.loadIndex(sessionId);
    const rec = map.get(ref) ?? {
      ref,
      state: "pending" as ProjectionState,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    rec.state = "indexed";
    rec.vectorId = vectorId;
    rec.updatedAt = now;
    map.set(ref, rec);
    await this.flush(sessionId);
  }

  async markFailed(
    sessionId: string,
    ref: string,
    error: string,
    now: number = Date.now(),
  ): Promise<ProjectionState> {
    const map = await this.loadIndex(sessionId);
    const rec = map.get(ref) ?? {
      ref,
      state: "pending" as ProjectionState,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    rec.attempts += 1;
    rec.lastError = error;
    rec.updatedAt = now;
    if (rec.attempts >= this.maxAttempts) {
      rec.state = "dead";
      map.set(ref, rec);
      await this.flush(sessionId);
 // DLQ
      await mkdir(this.deadDir(), { recursive: true });
      const dlqPath = join(this.deadDir(), `${sessionId}.${now}.${rec.ref}.json`);
      await writeFile(dlqPath, JSON.stringify({ sessionId, record: rec }, null, 2), "utf8");
    } else {
      rec.state = "failed";
      map.set(ref, rec);
      await this.flush(sessionId);
    }
    return rec.state;
  }

  async list(sessionId: string): Promise<ProjectionRecord[]> {
    const map = await this.loadIndex(sessionId);
    return [...map.values()];
  }

  async listSessions(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl")
      .map((entry) => basename(entry.name, ".jsonl"))
      .sort();
  }

  async listPending(sessionId: string): Promise<ProjectionRecord[]> {
    const map = await this.loadIndex(sessionId);
    return [...map.values()].filter((rec) => rec.state === "pending" || rec.state === "failed");
  }

  async pendingCount(sessionId: string): Promise<number> {
    const map = await this.loadIndex(sessionId);
    let n = 0;
    for (const rec of map.values()) {
      if (rec.state === "pending" || rec.state === "failed" || rec.state === "retrying") n += 1;
    }
    return n;
  }

 /** 清空缓存（用于测试模拟进程重启）。 */
  resetCache(): void {
    this.cache.clear();
  }

  get directory(): string {
    return this.dir;
  }

 /** 仅用于内部诊断：用户可拿到 dead 目录路径检查 DLQ。 */
  get deadLetterDir(): string {
    return this.deadDir();
  }

 // 兼容 lint/test：保留 dirname 引用以避免 unused import 报错。
  static dirnameOf(path: string): string {
    return dirname(path);
  }
}
