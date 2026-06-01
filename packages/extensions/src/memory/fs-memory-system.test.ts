/**
 * FsMemorySystem 单元测试
 *
 * 覆盖 patch-02-session-persistence 的关键契约：
 * - append → 新实例 load → 跨进程还原
 * - hydrate 幂等（多次 load 不重复注入）
 * - compress 后磁盘 jsonl atomic rewrite
 * - 行级损坏容错（脏行被跳过）
 * - clear 同时清空内存与磁盘
 * - sanitizeSessionId 规则
 */
import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_ADAPTER_CALL_CONTEXT,
  InMemoryMemorySystem,
  InMemoryVectorStore,
  DefaultModelRouter,
  type EngineConfig,
  type MemoryEntry,
  type ProviderAdapter,
  type Tokenizer,
} from "@tachu/core";

import { FsMemorySystem, sanitizeSessionId } from "./fs-memory-system";

const AC = DEFAULT_ADAPTER_CALL_CONTEXT;

const tokenizer: Tokenizer = {
  count: (text) => Math.max(1, Math.ceil(text.length / 4)),
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

function makeConfig(archivePath: string, contextTokenLimit = 8_192): EngineConfig {
  return {
    registry: { descriptorPaths: [], enableVectorIndexing: false },
    runtime: { planMode: false, maxConcurrency: 4, defaultTaskTimeoutMs: 1_000, failFast: false },
    memory: {
      contextTokenLimit,
      compressionThreshold: 0.8,
      headKeep: 1,
      tailKeep: 1,
      archivePath,
      vectorIndexLimit: 1_000,
      persistence: "fs",
      persistDir: ".tachu/memory",
    },
    budget: { maxTokens: 1_000, maxToolCalls: 10, maxWallTimeMs: 10_000 },
    safety: {
      maxInputSizeBytes: 1_024,
      maxRecursionDepth: 3,
      workspaceRoot: process.cwd(),
      promptInjectionPatterns: [],
    },
    models: {
      capabilityMapping: {
        "fast-cheap": { provider: "noop", model: "dev-small" },
        compress: { provider: "noop", model: "dev-small" },
      },
      providerFallbackOrder: ["noop"],
    },
    observability: { enabled: false, maskSensitiveData: true },
    hooks: { writeHookTimeout: 1_000, failureBehavior: "continue" },
  };
}

function makeInner(config: EngineConfig): InMemoryMemorySystem {
  const router = new DefaultModelRouter(config);
  const vector = new InMemoryVectorStore();
  return new InMemoryMemorySystem(
    config,
    tokenizer,
    router,
    new Map<string, ProviderAdapter>(),
    vector,
  );
}

function makeFsMemory(persistDir: string, config: EngineConfig): FsMemorySystem {
  const inner = makeInner(config);
  return new FsMemorySystem({
    persistDir,
    inner,
    compressionThreshold: config.memory.compressionThreshold,
  });
}

describe("FsMemorySystem", () => {
 test("append 后新实例 load 能恢复所有 entries（跨进程语义）", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

    const mem1 = makeFsMemory(persistDir, config);
    await mem1.append(
      "sess-A",
      {
        id: "sess-A-1",
        role: "user",
        content: "第一条",
        timestamp: 1_000,
        anchored: false,
      },
      AC,
    );
    await mem1.append(
      "sess-A",
      {
        id: "sess-A-2",
        role: "assistant",
        content: "第二条",
        timestamp: 2_000,
        anchored: false,
      },
      AC,
    );

 // 模拟进程重启：全新内存实例 + 全新 FsMemorySystem
    const mem2 = makeFsMemory(persistDir, config);
    const window = await mem2.load("sess-A", AC);
    expect(window.entries.map((e) => e.content)).toEqual(["第一条", "第二条"]);
    expect(window.entries[0]!.role).toBe("user");
    expect(window.entries[1]!.role).toBe("assistant");

    await rm(root, { recursive: true, force: true });
  });

 test("hydrate 幂等：多次 load 不重复注入", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

    const mem = makeFsMemory(persistDir, config);
    await mem.append(
      "sess-B",
      {
        id: "sess-B-1",
        role: "user",
        content: "a",
        timestamp: 100,
        anchored: false,
      },
      AC,
    );
    await mem.append(
      "sess-B",
      {
        id: "sess-B-2",
        role: "assistant",
        content: "b",
        timestamp: 200,
        anchored: false,
      },
      AC,
    );

    const first = await mem.load("sess-B", AC);
    const second = await mem.load("sess-B", AC);
    const third = await mem.load("sess-B", AC);

    expect(first.entries.length).toBe(2);
    expect(second.entries.length).toBe(2);
    expect(third.entries.length).toBe(2);

    await rm(root, { recursive: true, force: true });
  });

 test("越过阈值触发 compress 后 jsonl atomic rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
 // 故意把 contextTokenLimit 压到极小，触发 compress
    const config = makeConfig(join(root, "archive.jsonl"), 40);
    config.memory.compressionThreshold = 0.2;
    config.memory.headKeep = 1;
    config.memory.tailKeep = 1;

    const mem = makeFsMemory(persistDir, config);
    const now = Date.now();
    await mem.append(
      "sess-C",
      { id: "sess-C-1", role: "user", content: "head-msg", timestamp: now, anchored: false },
      AC,
    );
    await mem.append(
      "sess-C",
      {
        id: "sess-C-2",
        role: "assistant",
        content: "middle-one with some context long enough",
        timestamp: now + 1,
        anchored: false,
      },
      AC,
    );
    await mem.append(
      "sess-C",
      {
        id: "sess-C-3",
        role: "user",
        content: "middle-two with more context here",
        timestamp: now + 2,
        anchored: false,
      },
      AC,
    );
    await mem.append(
      "sess-C",
      {
        id: "sess-C-4",
        role: "assistant",
        content: "tail-msg final answer",
        timestamp: now + 3,
        anchored: false,
      },
      AC,
    );

    const window = await mem.load("sess-C", AC);
 // 压缩后应含至少一条系统摘要
    expect(window.entries.some((e) => e.role === "system" && String(e.content).includes("摘要"))).toBe(
      true,
    );
 // 磁盘文件的 line 数应 = 内存 entries 数（atomic rewrite 保持一致）
    const diskRaw = await readFile(join(persistDir, "sess-C.jsonl"), "utf8");
    const diskLines = diskRaw.split("\n").filter((line) => line.trim().length > 0);
    expect(diskLines.length).toBe(window.entries.length);

    await rm(root, { recursive: true, force: true });
  });

 test("损坏行（非 JSON）在 hydrate 时被跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

 // 先手工写一个包含脏行的 jsonl
    const mem = makeFsMemory(persistDir, config);
    const filePath = mem.pathFor("sess-D");
    await mem.append(
      "sess-D",
      {
        id: "sess-D-1",
        role: "user",
        content: "good",
        timestamp: 1,
        anchored: false,
      },
      AC,
    );
 // 尾巴追加一行坏数据（非法 JSON）
    await appendFile(filePath, "not-a-json-line\n", "utf8");
    await appendFile(
      filePath,
      `${JSON.stringify({ id: "sess-D-2", role: "assistant", content: "also good", timestamp: 2, anchored: false })}\n`,
      "utf8",
    );

    const mem2 = makeFsMemory(persistDir, config);
    const window = await mem2.load("sess-D", AC);
    expect(window.entries.map((e) => e.content)).toEqual(["good", "also good"]);

    await rm(root, { recursive: true, force: true });
  });

 test("readRaw 直读磁盘条目，不触发 hydrate 副作用", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

    const mem = makeFsMemory(persistDir, config);
    const ts = Date.now();
    await mem.append(
      "sess-E",
      {
        id: "sess-E-1",
        role: "user",
        content: "raw-1",
        timestamp: ts,
        anchored: false,
      },
      AC,
    );

    const mem2 = makeFsMemory(persistDir, config);
    const raw = await mem2.readRaw("sess-E");
    expect(raw.length).toBe(1);
    expect(raw[0]!.content).toBe("raw-1");

 // 尚未触发过 hydrate —— 再次 load 也能正确返回所有 entries
    const window = await mem2.load("sess-E", AC);
    expect(window.entries.length).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

 test("clear 删除内存 window 与磁盘 jsonl 文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

    const mem = makeFsMemory(persistDir, config);
    await mem.append(
      "sess-F",
      {
        id: "sess-F-1",
        role: "user",
        content: "to-be-cleared",
        timestamp: 1,
        anchored: false,
      },
      AC,
    );
    const filePath = mem.pathFor("sess-F");
    expect(existsSync(filePath)).toBe(true);

    await mem.clear("sess-F");
    expect(existsSync(filePath)).toBe(false);

    const window = await mem.load("sess-F", AC);
    expect(window.entries.length).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

 test("clear 对不存在的 session 幂等（no-throw）", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));
    const mem = makeFsMemory(persistDir, config);
    await expect(mem.clear("nonexistent")).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

 test("pathFor 将特殊字符 sessionId 标准化后拼接到 persistDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));
    const mem = makeFsMemory(persistDir, config);
    const p = mem.pathFor("../../etc/passwd");
    expect(p.startsWith(persistDir)).toBe(true);
    expect(p.endsWith(".jsonl")).toBe(true);
 // 路径分隔符 / \ 必须被过滤，不得让攻击者跳出 persistDir
    const relative = p.slice(persistDir.length + 1);
    expect(relative.includes("/")).toBe(false);
    expect(relative.includes("\\")).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

 test("多会话互不干扰：各自独立 jsonl + hydrate", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));

    const mem1 = makeFsMemory(persistDir, config);
    await mem1.append(
      "alpha",
      { id: "alpha-1", role: "user", content: "A1", timestamp: 1, anchored: false },
      AC,
    );
    await mem1.append(
      "beta",
      { id: "beta-1", role: "user", content: "B1", timestamp: 1, anchored: false },
      AC,
    );
    await mem1.append(
      "alpha",
      { id: "alpha-2", role: "assistant", content: "A2", timestamp: 2, anchored: false },
      AC,
    );

    const mem2 = makeFsMemory(persistDir, config);
    const a = await mem2.load("alpha", AC);
    const b = await mem2.load("beta", AC);
    expect(a.entries.map((e) => e.content)).toEqual(["A1", "A2"]);
    expect(b.entries.map((e) => e.content)).toEqual(["B1"]);

    await rm(root, { recursive: true, force: true });
  });

 test("loadView(export) 提供 CLI 可复用的 durable memory 视图，不暴露文件解析细节", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));
    const mem = makeFsMemory(persistDir, config);

    await mem.append(
      "view-session",
      { id: "view-1", role: "user", content: "question", timestamp: 1, anchored: false },
      AC,
    );
    await mem.append(
      "view-session",
      { id: "view-2", role: "assistant", content: "answer", timestamp: 2, anchored: false },
      AC,
    );

    const view = await mem.loadView("view-session", { kind: "export" }, AC);

    expect(view.kind).toBe("export");
    expect(view.entries.map((entry) => entry.content)).toEqual(["question", "answer"]);
    expect(view.projectionStatus.every((item) => item.kind === "pending")).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

 test("projection outbox 记录 append 后待索引的 source refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-fsmem-"));
    const persistDir = join(root, "memory");
    const config = makeConfig(join(root, "archive.jsonl"));
    const mem = makeFsMemory(persistDir, config);

    await mem.append(
      "projection-session",
      { id: "projection-1", role: "user", content: "needs indexing", timestamp: 1, anchored: false },
      AC,
    );

    const snapshot = await mem.loadSession("projection-session", AC);

    expect(snapshot.hotLog).toHaveLength(1);
    expect(snapshot.projectionStatus).toEqual([
      {
        kind: "pending",
        ref: "projection-1",
        reason: "awaiting semantic projection",
        createdAt: expect.any(Number),
      },
    ]);

    await rm(root, { recursive: true, force: true });
  });

 test(" P5: archive() routes entries through ProjectionOutbox + archiveRefs persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-outbox-"));
    const persistDir = join(root, "memory");
    const outboxDir = join(root, "projections");
    const config = makeConfig(join(root, "archive.jsonl"));
    const inner = makeInner(config);
    const { ProjectionOutbox } = await import("./projection-outbox");
    const outbox = new ProjectionOutbox({ dir: outboxDir });
 // production parity requires an injected projectionProject — the
 // legacy fallback to inner.project() (which forwarded raw text to
 // VectorStore.upsert) has been retired. Use a host-style projector that
 // emits the same vectorId scheme so existing assertions remain stable.
    const innerProjectCalls: string[] = [];
    const innerProjectSpy = inner.project.bind(inner);
    inner.project = async (...args) => {
      innerProjectCalls.push(args[0] ?? "");
      return innerProjectSpy(...args);
    };
    const projectionProject = async (
      sessionId: string,
      refs: readonly string[],
    ) => {
      const entries = await inner.loadFull(sessionId);
      return refs.map((ref) => {
        const entry = entries.find((item) => item.id === ref);
        const ts = entry?.timestamp ?? 0;
        return { ref, vectorId: `${sessionId}-${ts}` };
      });
    };
    const mem = new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: config.memory.compressionThreshold,
      projectionOutbox: outbox,
      projectionProject,
    });

    await mem.append(
      "sess-outbox",
      {
        id: "ob-1",
        role: "user",
        content: "Hello outbox",
        timestamp: 1_000,
        anchored: false,
      },
      AC,
    );
    await mem.archive("sess-outbox");

    const list = await outbox.list("sess-outbox");
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("indexed");
    expect(list[0]?.vectorId).toBe("sess-outbox-1000");
 // Hard regression: the production projection path must never delegate to
 // inner.project() (which would re-introduce the deprecated text-embed
 // shortcut on VectorStore.upsert).
    expect(innerProjectCalls).toEqual([]);

    const snapshot = await mem.loadSession("sess-outbox", AC);
    expect(snapshot.projectionStatus[0]?.kind).toBe("indexed");

 // archiveRefs persistence via compact()
    await mem.compact("sess-outbox", { method: "manual" }, AC);
    const reloaded = new FsMemorySystem({
      persistDir,
      inner: makeInner(config),
      compressionThreshold: config.memory.compressionThreshold,
    });
    const snap2 = await reloaded.loadSession("sess-outbox", AC);
    expect(snap2.archiveRefs.length).toBeGreaterThan(0);
    expect(snap2.archiveRefs[0]?.entryIds).toContain("ob-1");

    await rm(root, { recursive: true, force: true });
  });

 test(" P5 omega: archive(awaitProjection=false) enqueues and worker flush indexes later", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-outbox-worker-"));
    const persistDir = join(root, "memory");
    const outboxDir = join(root, "projections");
    const config = makeConfig(join(root, "archive.jsonl"));
    const inner = makeInner(config);
    const { ProjectionOutbox } = await import("./projection-outbox");
    const outbox = new ProjectionOutbox({ dir: outboxDir });
    const innerProjectCalls: string[] = [];
    const innerProjectSpy = inner.project.bind(inner);
    inner.project = async (...args) => {
      innerProjectCalls.push(args[0] ?? "");
      return innerProjectSpy(...args);
    };
    const projectionProject = async (
      sessionId: string,
      refs: readonly string[],
    ) => {
      const entries = await inner.loadFull(sessionId);
      return refs.map((ref) => {
        const entry = entries.find((item) => item.id === ref);
        const ts = entry?.timestamp ?? 0;
        return { ref, vectorId: `${sessionId}-${ts}` };
      });
    };
    const mem = new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: config.memory.compressionThreshold,
      projectionOutbox: outbox,
      projectionProject,
    });
    const worker = mem.createProjectionWorker();

    await mem.append(
      "sess-worker",
      { id: "w-1", role: "user", content: "one", timestamp: 1_000, anchored: false },
      AC,
    );
    await mem.append(
      "sess-worker",
      { id: "w-2", role: "assistant", content: "two", timestamp: 2_000, anchored: false },
      AC,
    );

    await mem.archive("sess-worker", { awaitProjection: false });
    expect((await outbox.list("sess-worker")).map((record) => record.state)).toEqual([
      "pending",
      "pending",
    ]);

    const result = await worker.flush("sess-worker");
    expect(result).toEqual({ sessions: 1, projected: 2, failed: 0 });
    const list = await outbox.list("sess-worker");
    expect(list.map((record) => record.state)).toEqual(["indexed", "indexed"]);
    expect(list.map((record) => record.vectorId)).toEqual([
      "sess-worker-1000",
      "sess-worker-2000",
    ]);
    expect(innerProjectCalls).toEqual([]);

    await rm(root, { recursive: true, force: true });
  });

 test("fail-closed: createProjectionWorker() throws when projectionProject is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-failclosed-"));
    const persistDir = join(root, "memory");
    const outboxDir = join(root, "projections");
    const config = makeConfig(join(root, "archive.jsonl"));
    const inner = makeInner(config);
    const { ProjectionOutbox } = await import("./projection-outbox");
    const outbox = new ProjectionOutbox({ dir: outboxDir });
 // Intentionally do NOT pass projectionProject — the legacy inner.project()
 // fallback must not silently take over.
    const mem = new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: config.memory.compressionThreshold,
      projectionOutbox: outbox,
    });

    expect(() => mem.createProjectionWorker()).toThrow(/projectionProject/);

 // archive() with default awaitProjection (true) → triggers worker creation
 // → must also fail closed instead of indexing through inner.project().
    await mem.append(
      "fail-sess",
      { id: "f-1", role: "user", content: "x", timestamp: 1, anchored: false },
      AC,
    );
    await expect(mem.archive("fail-sess")).rejects.toThrow(/projectionProject/);

    await rm(root, { recursive: true, force: true });
  });

 test("regression: production projector receives refs and inner.project() is never invoked", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-bl002-regression-"));
    const persistDir = join(root, "memory");
    const outboxDir = join(root, "projections");
    const config = makeConfig(join(root, "archive.jsonl"));
    const inner = makeInner(config);
    const { ProjectionOutbox } = await import("./projection-outbox");
    const outbox = new ProjectionOutbox({ dir: outboxDir });

 // Replace inner.project with a hard-fail stub: if production projection
 // ever reaches the deprecated text-embed path, this test fails loudly.
    inner.project = async () => {
      throw new Error(
        "inner.project() must not be invoked from FsMemorySystem projection paths",
      );
    };

    const projectedRefs: string[] = [];
    const projectionProject = async (
      sessionId: string,
      refs: readonly string[],
    ) => {
      for (const ref of refs) projectedRefs.push(`${sessionId}:${ref}`);
      return refs.map((ref) => ({ ref, vectorId: `${sessionId}-${ref}` }));
    };

    const mem = new FsMemorySystem({
      persistDir,
      inner,
      compressionThreshold: config.memory.compressionThreshold,
      projectionOutbox: outbox,
      projectionProject,
    });

    await mem.append(
      "regression",
      { id: "r-1", role: "user", content: "one", timestamp: 1_000, anchored: false },
      AC,
    );
    await mem.archive("regression");

    expect(projectedRefs).toEqual(["regression:r-1"]);
    const records = await outbox.list("regression");
    expect(records.map((record) => record.state)).toEqual(["indexed"]);

    await rm(root, { recursive: true, force: true });
  });

 test(" P5: outbox recover() promotes stale retrying to pending after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tachu-recover-"));
    const outboxDir = join(root, "projections");
    const { ProjectionOutbox } = await import("./projection-outbox");
    const outbox1 = new ProjectionOutbox({ dir: outboxDir, staleAfterMs: 1_000 });
    await outbox1.enqueue("s", "r-1", 1_000);
    await outbox1.markRetrying("s", "r-1", 2_000); // 2s mark
 // Simulate process kill mid-upsert: a brand-new outbox starts.
    const outbox2 = new ProjectionOutbox({ dir: outboxDir, staleAfterMs: 1_000 });
    const reset = await outbox2.recover("s", 10_000); // 8s after retrying mark > 1s stale
    expect(reset).toBe(1);
    const list = await outbox2.list("s");
    expect(list[0]?.state).toBe("pending");

    await rm(root, { recursive: true, force: true });
  });
});

describe("sanitizeSessionId", () => {
 test("保留合法字符", () => {
    expect(sanitizeSessionId("abc-123_def.txt")).toBe("abc-123_def.txt");
  });

 test("路径穿越字符被替换为下划线", () => {
 // `/` → `_`，开头的 `..` 被 `^\.+` 整体替换成单个 `_`
    expect(sanitizeSessionId("../foo/bar")).toBe("__foo_bar");
  });

 test("首位不允许为点", () => {
    expect(sanitizeSessionId(".hidden")).not.toStartWith(".");
  });

 test("空字符串兜底为 default", () => {
    expect(sanitizeSessionId("")).toBe("default");
  });

 test("超长输入被截断到 120 字符", () => {
    const raw = "a".repeat(500);
    expect(sanitizeSessionId(raw).length).toBe(120);
  });
});
