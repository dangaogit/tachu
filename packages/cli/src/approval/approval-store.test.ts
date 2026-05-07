import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalStore } from "./approval-store";
import type { ApprovalRecord } from "./approval-store";

const makeRecord = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: crypto.randomUUID(),
  scope: "project",
  tool: "write-file",
  match: { kind: "any" },
  createdAt: Date.now(),
  ...overrides,
});

const withTmpDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "tachu-approval-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};


describe("ApprovalStore", () => {
  describe("append / find", () => {
    test("append 后能 find 到记录", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ tool: "write-file" });
        await store.append(record);
        const found = await store.find("write-file", {});
        expect(found).not.toBeNull();
        expect(found?.id).toBe(record.id);
      });
    });

    test("find 不同工具名返回 null", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        await store.append(makeRecord({ tool: "write-file" }));
        const found = await store.find("run-shell", {});
        expect(found).toBeNull();
      });
    });

    test("过期记录 find 返回 null", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ expiresAt: Date.now() - 1000 });
        await store.append(record);
        const found = await store.find("write-file", {});
        expect(found).toBeNull();
      });
    });

    test("sessionId 不匹配时 find 返回 null", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ sessionId: "sess-1" });
        await store.append(record);
        const found = await store.find("write-file", {}, "sess-2");
        expect(found).toBeNull();
      });
    });

    test("sessionId 匹配时 find 返回记录", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ sessionId: "sess-1" });
        await store.append(record);
        const found = await store.find("write-file", {}, "sess-1");
        expect(found?.id).toBe(record.id);
      });
    });
  });

  describe("list", () => {
    test("list 返回所有记录", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        await store.append(makeRecord({ tool: "write-file" }));
        await store.append(makeRecord({ tool: "run-shell" }));
        const records = await store.list();
        expect(records.length).toBeGreaterThanOrEqual(2);
        const tools = records.map((r) => r.tool);
        expect(tools).toContain("write-file");
        expect(tools).toContain("run-shell");
      });
    });

    test("空 store 返回空数组", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const records = await store.list();
        expect(records).toEqual([]);
      });
    });
  });

  describe("revoke", () => {
    test("revoke 存在的记录返回 true 并删除", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord();
        await store.append(record);
        const ok = await store.revoke(record.id);
        expect(ok).toBe(true);
        const found = await store.find("write-file", {});
        expect(found).toBeNull();
      });
    });

    test("revoke 不存在的记录返回 false", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const ok = await store.revoke("non-existent-id");
        expect(ok).toBe(false);
      });
    });

    test("revoke 后其他记录保留", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const r1 = makeRecord({ tool: "write-file" });
        const r2 = makeRecord({ tool: "run-shell" });
        await store.append(r1);
        await store.append(r2);
        await store.revoke(r1.id);
        const records = await store.list();
        expect(records.some((r) => r.id === r2.id)).toBe(true);
        expect(records.some((r) => r.id === r1.id)).toBe(false);
      });
    });
  });

  describe("clear", () => {
    test("clear 所有记录", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        await store.append(makeRecord({ tool: "write-file" }));
        await store.append(makeRecord({ tool: "run-shell" }));
        const count = await store.clear();
        expect(count).toBe(2);
        const records = await store.list();
        expect(records.length).toBe(0);
      });
    });

    test("clear 按 tool 过滤", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        await store.append(makeRecord({ tool: "write-file" }));
        await store.append(makeRecord({ tool: "run-shell" }));
        const count = await store.clear({ tool: "write-file" });
        expect(count).toBe(1);
        const records = await store.list();
        expect(records.every((r) => r.tool === "run-shell")).toBe(true);
      });
    });

    test("clear expiredOnly 只删过期记录", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const expired = makeRecord({ expiresAt: Date.now() - 1000 });
        const valid = makeRecord();
        await store.append(expired);
        await store.append(valid);
        const count = await store.clear({ expiredOnly: true });
        expect(count).toBe(1);
        const records = await store.list();
        expect(records.some((r) => r.id === valid.id)).toBe(true);
        expect(records.some((r) => r.id === expired.id)).toBe(false);
      });
    });
  });

  describe("promote", () => {
    test("promote 将 project 记录移到 user 级", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ scope: "project" });
        await store.append(record);
        const ok = await store.promote(record.id);
        expect(ok).toBe(true);

        // project 记录应被删除（scope 过滤到 project 后查询 project 文件）
        const projectRecords = await store.list();
        const projectScope = projectRecords.filter((r) => r.id === record.id && r.scope === "project");
        expect(projectScope.length).toBe(0);
      });
    });

    test("promote 不存在的 ID 返回 false", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const ok = await store.promote("non-existent");
        expect(ok).toBe(false);
      });
    });
  });

  describe("project vs user 路径", () => {
    test("append 写入 project 路径 (.tachu/approvals.jsonl)", async () => {
      await withTmpDir(async (dir) => {
        const store = new ApprovalStore(dir, { userStoreDir: dir });
        const record = makeRecord({ scope: "project" });
        await store.append(record);

        const { readFile, existsSync } = await import("node:fs");
        const { promisify } = await import("node:util");
        const readFileAsync = promisify(readFile);
        const projectPath = join(dir, ".tachu", "approvals.jsonl");
        expect(existsSync(projectPath)).toBe(true);
        const content = await readFileAsync(projectPath, "utf8");
        expect(content).toContain(record.id);
      });
    });
  });
});
