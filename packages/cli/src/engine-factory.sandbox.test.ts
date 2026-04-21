import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionContext, TaskNode } from "@tachu/core";
import {
  resolveAllowedPath,
  type ToolExecutionContext,
  type ToolExecutor,
} from "@tachu/extensions";
import { buildAllowedRoots, buildTaskExecutor } from "./engine-factory";

/**
 * 这些测试只关心"沙箱白名单与审批豁免是否正确装配进 ToolExecutionContext"，
 * 不涉及完整 Engine / tool-use subflow。通过替换 toolExecutors 为探针函数，
 * 直接断言 buildTaskExecutor 传下去的 context。
 */
describe("buildAllowedRoots — 静态白名单装配", () => {
  it("默认返回 cwd + os.tmpdir() + /tmp 三条（/tmp 已覆盖 POSIX 共享临时目录）", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, []);
    expect(roots).toContain(resolve(cwd));
    expect(roots).toContain(resolve(tmpdir()));
    // 以 POSIX 语义兜底：macOS 上 os.tmpdir() 是 /var/folders/...，
    // 必须额外把 /tmp 放进去用户才能写 /tmp/cat.txt。
    expect(roots).toContain("/tmp");
  });

  it("相同目录多次出现只保留一次（去重，包含 realpath 去重）", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, [cwd, cwd, tmpdir()]);
    expect(roots.filter((r) => r === resolve(cwd))).toHaveLength(1);
    expect(roots.filter((r) => r === resolve(tmpdir()))).toHaveLength(1);
  });

  it("相对路径以 cwd 展开，绝对路径直接保留", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    mkdirSync(join(cwd, "scratch"), { recursive: true });
    const roots = buildAllowedRoots(cwd, ["./scratch", "/opt/shared-nonexistent"]);
    expect(roots).toContain(resolve(cwd, "scratch"));
    expect(roots).toContain("/opt/shared-nonexistent");
  });

  it("空串或仅空白的 extras 会被忽略", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, ["", "   ", "/opt/real-nonexistent"]);
    expect(roots).not.toContain("");
    expect(roots).toContain("/opt/real-nonexistent");
  });

  it("symlink 根会被 realpath 展开一次，字面形态与真实形态同时在列表里", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const real = realpathSync(mkdtempSync(join(tmpdir(), "tachu-real-")));
    const link = join(cwd, "link-to-real");
    symlinkSync(real, link, "dir");
    const roots = buildAllowedRoots(cwd, [link]);
    expect(roots).toContain(resolve(link));
    expect(roots).toContain(real);
  });

  it("不存在的路径不会让 realpath 抛错打断装配（字面形态仍保留）", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const ghost = "/definitely/does/not/exist/at/all";
    const roots = buildAllowedRoots(cwd, [ghost]);
    expect(roots).toContain(ghost);
  });

  it("回归：用户场景 `/tmp/cat.txt` 在默认白名单下能被 read-file 通过", () => {
    // 复现原始 bug：macOS 上 os.tmpdir() = /var/folders/...，与 /tmp 不在同一目录，
    // 导致 readonly 工具（无审批豁免）读取 /tmp/cat.txt 被拦截。
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, []);
    expect(() =>
      resolveAllowedPath("/tmp/cat.txt", { allowedRoots: roots }),
    ).not.toThrow();
  });

  it("回归：`/tmp` 的 macOS symlink 形态（/private/tmp）也能通过判定", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, []);
    // /tmp 在 macOS 上的 realpath 是 /private/tmp；即使模型给出 /private/tmp/foo
    // 这种规范化后的路径，也应能落在白名单之内。
    const tmpReal = (() => {
      try {
        return realpathSync("/tmp");
      } catch {
        return "/tmp";
      }
    })();
    expect(() =>
      resolveAllowedPath(join(tmpReal, "cat.txt"), { allowedRoots: roots }),
    ).not.toThrow();
  });

  it("回归：明显越界的路径仍会被拦截并带上 allowedWriteRoots 提示", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tachu-ws-")));
    const roots = buildAllowedRoots(cwd, []);
    let message = "";
    try {
      resolveAllowedPath("/etc/passwd", { allowedRoots: roots });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("路径越界");
    expect(message).toContain("safety.allowedWriteRoots");
  });
});

describe("buildTaskExecutor — 沙箱/审批上下文装配", () => {
  const captureCtx = (): {
    executor: ToolExecutor;
    captured: ToolExecutionContext[];
  } => {
    const captured: ToolExecutionContext[] = [];
    const executor: ToolExecutor = async (_input, context) => {
      captured.push(context);
      return { ok: true };
    };
    return { executor, captured };
  };

  const execCtx: ExecutionContext = {
    requestId: "req-1",
    sessionId: "sess-1",
    traceId: "tr-1",
    principal: {},
    budget: {},
    scopes: [],
  };

  it("allowedRoots 与 cwd 同步注入 ToolExecutionContext", async () => {
    const { executor, captured } = captureCtx();
    const cwd = "/tmp/tachu-ws";
    const allowed = ["/tmp/tachu-ws", "/opt/extra"] as const;
    const exec = buildTaskExecutor(cwd, { write: executor }, allowed);
    const task: TaskNode = {
      id: "t1",
      type: "tool",
      ref: "write",
      input: {},
    };
    await exec(task, execCtx, new AbortController().signal);
    const ctx = captured[0];
    expect(ctx).toBeDefined();
    expect(ctx!.workspaceRoot).toBe(cwd);
    expect([...(ctx!.allowedRoots ?? [])]).toEqual([...allowed]);
  });

  it("未标记审批时 sandboxWaived 为 false（默认沙箱）", async () => {
    const { executor, captured } = captureCtx();
    const exec = buildTaskExecutor("/tmp/ws", { write: executor }, ["/tmp/ws"]);
    const task: TaskNode = {
      id: "t1",
      type: "tool",
      ref: "write",
      input: {},
    };
    await exec(task, execCtx, new AbortController().signal);
    expect(captured[0]!.sandboxWaived).toBe(false);
  });

  it("metadata.approvalGranted=true 时翻译成 sandboxWaived=true（审批豁免）", async () => {
    const { executor, captured } = captureCtx();
    const exec = buildTaskExecutor("/tmp/ws", { write: executor }, ["/tmp/ws"]);
    const task: TaskNode = {
      id: "t1",
      type: "tool",
      ref: "write",
      input: {},
      metadata: { approvalGranted: true },
    };
    await exec(task, execCtx, new AbortController().signal);
    expect(captured[0]!.sandboxWaived).toBe(true);
  });

  it("metadata.approvalGranted=false / undefined 都不会豁免", async () => {
    const { executor, captured } = captureCtx();
    const exec = buildTaskExecutor("/tmp/ws", { write: executor }, ["/tmp/ws"]);
    const tasks: TaskNode[] = [
      { id: "t1", type: "tool", ref: "write", input: {}, metadata: {} },
      {
        id: "t2",
        type: "tool",
        ref: "write",
        input: {},
        metadata: { approvalGranted: false },
      },
    ];
    for (const t of tasks) {
      await exec(t, execCtx, new AbortController().signal);
    }
    expect(captured.every((c) => c.sandboxWaived === false)).toBe(true);
  });

  it("工具不存在时抛错而非静默传递", async () => {
    const exec = buildTaskExecutor("/tmp/ws", {}, ["/tmp/ws"]);
    await expect(
      exec(
        { id: "t1", type: "tool", ref: "missing", input: {} },
        execCtx,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/工具执行器未找到/);
  });
});
