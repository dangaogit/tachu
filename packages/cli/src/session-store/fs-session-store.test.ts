import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryEntry, MemorySystem } from "@tachu/core";
import {
  FsSessionStore,
  createEmptySession,
  loadAndMigrate,
  migrateLegacyMessages,
  type LegacySessionMessage,
} from "./fs-session-store";

let tmpDir: string;

async function makeTempStore(): Promise<{ store: FsSessionStore; dir: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-test-"));
  const sessionsDir = join(tmpDir, "sessions");
  const store = new FsSessionStore(sessionsDir);
  return { store, dir: sessionsDir };
}

/**
 * 轻量 stub —— 只实现 patch-02 迁移路径用到的方法（getSize / append）。其余
 * 接口方法保持 no-op，足够覆盖 FsSessionStore + migrate util 的单元范畴。
 */
const buildMemoryStub = (): {
  ms: MemorySystem;
  appended: Array<{ sessionId: string; entry: MemoryEntry }>;
} => {
  const store = new Map<string, MemoryEntry[]>();
  const appended: Array<{ sessionId: string; entry: MemoryEntry }> = [];
  const ms: MemorySystem = {
    async load(sid) {
      return {
        entries: [...(store.get(sid) ?? [])],
        tokenCount: 0,
        limit: 8_000,
      };
    },
    async append(sid, entry) {
      const bucket = store.get(sid) ?? [];
      bucket.push(entry);
      store.set(sid, bucket);
      appended.push({ sessionId: sid, entry });
    },
    async compress() {
      /* no-op */
    },
    async recall() {
      return [];
    },
    async archive() {
      /* no-op */
    },
    async getSize(sid) {
      const bucket = store.get(sid) ?? [];
      return { entries: bucket.length, tokens: 0 };
    },
    async trim() {
      /* no-op */
    },
    async clear(sid) {
      store.delete(sid);
    },
  };
  return { ms, appended };
};

describe("FsSessionStore", () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("save + load 正常路径（v2 schema，不含 messages）", async () => {
    const { store } = await makeTempStore();
    const session = createEmptySession("test-id-1");
    session.budget.tokensUsed = 42;

    await store.save(session);
    const loaded = await store.load("test-id-1");

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("test-id-1");
    expect(loaded!.version).toBe(2);
    expect(loaded!.budget.tokensUsed).toBe(42);
  });

  it("load 不存在的 ID 返回 null", async () => {
    const { store } = await makeTempStore();
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("delete 删除已存在的 session", async () => {
    const { store } = await makeTempStore();
    const session = createEmptySession("to-delete");
    await store.save(session);
    await store.delete("to-delete");
    const loaded = await store.load("to-delete");
    expect(loaded).toBeNull();
  });

  it("delete 不存在的 ID 不抛出（幂等）", async () => {
    const { store } = await makeTempStore();
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });

  it("list 按 lastActiveAt 倒序返回", async () => {
    const { store } = await makeTempStore();
    const s1 = createEmptySession("oldest");
    s1.lastActiveAt = 1000;
    const s2 = createEmptySession("newest");
    s2.lastActiveAt = 2000;

    await store.save(s1);
    await store.save(s2);

    const metas = await store.list();
    expect(metas.length).toBe(2);
    expect(metas[0]!.id).toBe("newest");
    expect(metas[1]!.id).toBe("oldest");
  });

  it("list 空目录返回空数组", async () => {
    const { store } = await makeTempStore();
    const metas = await store.list();
    expect(metas).toEqual([]);
  });

  it("list 传入 MessageCounter 时以 counter 结果填充 messageCount", async () => {
    const { store } = await makeTempStore();
    const s = createEmptySession("counted");
    await store.save(s);
    const metas = await store.list(async () => 7);
    expect(metas[0]!.messageCount).toBe(7);
  });

  it("loadLatest 返回最近 session", async () => {
    const { store } = await makeTempStore();
    const s1 = createEmptySession("old");
    s1.lastActiveAt = 1000;
    const s2 = createEmptySession("recent");
    s2.lastActiveAt = 3000;

    await store.save(s1);
    await store.save(s2);

    const latest = await store.loadLatest();
    expect(latest!.id).toBe("recent");
  });

  it("loadLatest 无 session 时返回 null", async () => {
    const { store } = await makeTempStore();
    const result = await store.loadLatest();
    expect(result).toBeNull();
  });

  it("export 生成 Markdown 文件（由调用方提供消息快照）", async () => {
    const { store } = await makeTempStore();
    const session = createEmptySession("export-test");
    await store.save(session);

    const messages: MemoryEntry[] = [
      { role: "user", content: "test msg", timestamp: Date.now(), anchored: false },
    ];
    const outPath = join(tmpDir, "export.md");
    await store.export("export-test", outPath, messages);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(outPath, "utf8");
    expect(content).toContain("# Session export-test");
    expect(content).toContain("test msg");
  });

  it("export 未传 messages 时渲染占位说明", async () => {
    const { store } = await makeTempStore();
    const session = createEmptySession("empty-export");
    await store.save(session);
    const outPath = join(tmpDir, "empty.md");
    await store.export("empty-export", outPath);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(outPath, "utf8");
    expect(content).toContain("无消息历史");
  });

  it("export 不存在的 session 抛出 SessionStoreError", async () => {
    const { store } = await makeTempStore();
    await expect(store.export("nonexistent", "/tmp/out.md")).rejects.toThrow();
  });

  it("createEmptySession 包含初始默认值（v2）", () => {
    const session = createEmptySession("new-id");
    expect(session.id).toBe("new-id");
    expect(session.version).toBe(2);
    expect(session.budget.tokensUsed).toBe(0);
    expect(session.budget.toolCallsUsed).toBe(0);
    expect((session as unknown as { messages?: unknown }).messages).toBeUndefined();
  });

  it("loadWithLegacy 能识别老版 messages 字段并在 legacyMessages 中返回", async () => {
    const { store, dir } = await makeTempStore();
    const legacy = {
      id: "legacy-1",
      createdAt: 1,
      lastActiveAt: 2,
      messages: [
        { role: "user", content: "old hi", timestamp: 3 },
      ] satisfies LegacySessionMessage[],
      context: null,
      budget: { tokensUsed: 1, toolCallsUsed: 2, wallTimeMs: 3 },
      checkpoint: null,
    };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "legacy-1.json"), JSON.stringify(legacy), "utf8");

    const result = await store.loadWithLegacy("legacy-1");
    expect(result).not.toBeNull();
    expect(result!.legacyMessages.length).toBe(1);
    expect(result!.session.version).toBe(2);
    expect((result!.session as unknown as { messages?: unknown }).messages).toBeUndefined();
  });

  it("migrateLegacyMessages 把老消息灌入 MemorySystem 并保留幂等", async () => {
    const { store, dir } = await makeTempStore();
    const legacy = {
      id: "legacy-2",
      createdAt: 1,
      lastActiveAt: 2,
      messages: [
        { role: "user", content: "a", timestamp: 1 },
        { role: "assistant", content: "b", timestamp: 2 },
      ] satisfies LegacySessionMessage[],
      context: null,
      budget: { tokensUsed: 0, toolCallsUsed: 0, wallTimeMs: 0 },
      checkpoint: null,
    };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "legacy-2.json"), JSON.stringify(legacy), "utf8");

    const { ms, appended } = buildMemoryStub();
    const result = await store.loadWithLegacy("legacy-2");
    const n1 = await migrateLegacyMessages(ms, result!);
    expect(n1).toBe(2);
    expect(appended.map((a) => a.entry.content)).toEqual(["a", "b"]);

    // 幂等：MemorySystem 已有条目 → 再次迁移不重复 append
    const n2 = await migrateLegacyMessages(ms, result!);
    expect(n2).toBe(0);
    expect(appended.length).toBe(2);
  });

  it("loadAndMigrate 一次性完成 load + 迁移 + 写回 v2 schema", async () => {
    const { store, dir } = await makeTempStore();
    const legacy = {
      id: "legacy-3",
      createdAt: 1,
      lastActiveAt: 2,
      messages: [{ role: "user", content: "x", timestamp: 1 }] satisfies LegacySessionMessage[],
      context: null,
      budget: { tokensUsed: 0, toolCallsUsed: 0, wallTimeMs: 0 },
      checkpoint: null,
    };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "legacy-3.json"), JSON.stringify(legacy), "utf8");

    const { ms } = buildMemoryStub();
    const { session, migrated } = await loadAndMigrate(store, ms, "legacy-3");
    expect(session).not.toBeNull();
    expect(migrated).toBe(1);

    // 再 load 一次 —— 已经是 v2 schema、无残留 messages
    const reload = await store.loadWithLegacy("legacy-3");
    expect(reload!.legacyMessages.length).toBe(0);
    expect(reload!.session.version).toBe(2);
  });
});
