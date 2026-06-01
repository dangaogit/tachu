/**
 * `tachu memory rebuild` 命令单元测试（TDD）。
 *
 * 目标：扫 `<persistDir>/*.jsonl` 中未在 outbox 中出现的 entry，
 * 全量 enqueue 到 ProjectionOutbox 走标准 worker 流程。
 *
 * - started/enqueued/completed 事件流
 * - 默认全量（无 --session），可单挑某个 session
 * - 幂等：已 indexed 的 entry 不重复 enqueue
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectionOutbox, sanitizeSessionId } from "@tachu/extensions";

import {
  rebuildMemoryProjections,
  type RebuildEvent,
} from "./memory-rebuild";

let workDir: string;

async function setup(): Promise<{
  persistDir: string;
  projectionDir: string;
}> {
  workDir = await mkdtemp(join(tmpdir(), "tachu-memory-rebuild-"));
  const persistDir = join(workDir, "memory");
  const projectionDir = join(workDir, "projections");
  await mkdir(persistDir, { recursive: true });
  return { persistDir, projectionDir };
}

async function writeSessionJsonl(
  persistDir: string,
  sessionId: string,
  entryIds: readonly string[],
): Promise<void> {
  const path = join(persistDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  const lines = entryIds.map((id, index) =>
    JSON.stringify({
      id,
      role: "user",
      content: `entry ${id}`,
      timestamp: 1_700_000_000_000 + index,
      anchored: false,
    }),
  );
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

describe("rebuildMemoryProjections", () => {
  beforeEach(async () => {
 // 每个用例独立 tmp 目录在 setup() 中创建
  });

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = "";
    }
  });

  it("将 jsonl 中未在 outbox 出现的 entry 全量入队", async () => {
    const { persistDir, projectionDir } = await setup();
    await writeSessionJsonl(persistDir, "s1", ["e1", "e2", "e3"]);

    const summary = await rebuildMemoryProjections({
      persistDir,
      projectionDir,
    });

    expect(summary.sessions).toBe(1);
    expect(summary.enqueued).toBe(3);
    expect(summary.skipped).toBe(0);

    const outbox = new ProjectionOutbox({ dir: projectionDir });
    const records = await outbox.list("s1");
    expect(records.map((r) => r.ref).sort()).toEqual(["e1", "e2", "e3"]);
    for (const rec of records) {
      expect(rec.state).toBe("pending");
    }
  });

  it("已 indexed 的 entry 不重复 enqueue（幂等）", async () => {
    const { persistDir, projectionDir } = await setup();
    await writeSessionJsonl(persistDir, "s1", ["e1", "e2", "e3"]);

 // 模拟 outbox 已经投递成功 e1
    const seedOutbox = new ProjectionOutbox({ dir: projectionDir });
    await seedOutbox.enqueue("s1", "e1");
    await seedOutbox.markIndexed("s1", "e1", "vec-e1");

    const summary = await rebuildMemoryProjections({
      persistDir,
      projectionDir,
    });

    expect(summary.enqueued).toBe(2);
    expect(summary.skipped).toBe(1);

    const verifyOutbox = new ProjectionOutbox({ dir: projectionDir });
    const records = await verifyOutbox.list("s1");
    const byRef = new Map(records.map((r) => [r.ref, r.state]));
    expect(byRef.get("e1")).toBe("indexed");
    expect(byRef.get("e2")).toBe("pending");
    expect(byRef.get("e3")).toBe("pending");
  });

  it("--session 过滤只处理指定 session", async () => {
    const { persistDir, projectionDir } = await setup();
    await writeSessionJsonl(persistDir, "s1", ["a1"]);
    await writeSessionJsonl(persistDir, "s2", ["b1", "b2"]);

    const summary = await rebuildMemoryProjections({
      persistDir,
      projectionDir,
      sessionId: "s2",
    });

    expect(summary.sessions).toBe(1);
    expect(summary.enqueued).toBe(2);

    const outbox = new ProjectionOutbox({ dir: projectionDir });
    expect((await outbox.list("s1")).length).toBe(0);
    expect((await outbox.list("s2")).length).toBe(2);
  });

  it("emit started / enqueued / completed 事件流", async () => {
    const { persistDir, projectionDir } = await setup();
    await writeSessionJsonl(persistDir, "s1", ["e1", "e2"]);

    const events: RebuildEvent[] = [];
    await rebuildMemoryProjections({
      persistDir,
      projectionDir,
      onEvent: (event) => events.push(event),
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("memory.rebuild.started");
    expect(types[types.length - 1]).toBe("memory.rebuild.completed");
    const enqueued = events.filter((e) => e.type === "memory.rebuild.enqueued");
    expect(enqueued.length).toBe(2);
    expect(enqueued.map((e) => (e as { ref: string }).ref).sort()).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("persistDir 无 jsonl 时返回 0 session、不报错", async () => {
    const { persistDir, projectionDir } = await setup();

    const summary = await rebuildMemoryProjections({
      persistDir,
      projectionDir,
    });

    expect(summary.sessions).toBe(0);
    expect(summary.enqueued).toBe(0);
  });
});
