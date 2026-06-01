import { describe, it, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllowedPath, resolveWorkspacePath } from "../../src/common/path";

describe("resolveAllowedPath", () => {
  it("相对路径以第一个 root 为基准展开", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-"));
    const out = resolveAllowedPath("./foo.txt", { allowedRoots: [workspace] });
    expect(out).toBe(join(workspace, "foo.txt"));
  });

  it("绝对路径落在允许根下时放行", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    const out = resolveAllowedPath(join(workspace, "nested/x.txt"), {
      allowedRoots: [workspace],
    });
    expect(out).toBe(join(workspace, "nested/x.txt"));
  });

  it("绝对路径跑出所有根时抛 VALIDATION_PATH_ESCAPE", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    const outsider = await mkdtemp(join(tmpdir(), "tachu-path-outside-"));
    expect(() =>
      resolveAllowedPath(join(outsider, "evil.txt"), { allowedRoots: [workspace] }),
    ).toThrow(/VALIDATION_PATH_ESCAPE|路径越界/);
  });

  it("多个根只要命中一个就放行（tmpdir 白名单语义）", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    const extra = await mkdtemp(join(tmpdir(), "tachu-path-extra-"));
    const target = join(extra, "deeper/dir/file.log");
    const out = resolveAllowedPath(target, { allowedRoots: [workspace, extra] });
    expect(out).toBe(target);
  });

  it("sandboxWaived=true 时完全跳过根校验（审批豁免）", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    const out = resolveAllowedPath("/completely/outside/workspace.txt", {
      allowedRoots: [workspace],
      sandboxWaived: true,
    });
    expect(out).toBe("/completely/outside/workspace.txt");
  });

  it("sandboxWaived=false（默认）仍然拦截越界路径", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    expect(() =>
      resolveAllowedPath("/etc/passwd", {
        allowedRoots: [workspace],
        sandboxWaived: false,
      }),
    ).toThrow(/VALIDATION_PATH_ESCAPE|路径越界/);
  });

  it("空 allowedRoots 直接报错（防止配置错误静默放行）", () => {
    expect(() => resolveAllowedPath("foo.txt", { allowedRoots: [] })).toThrow(
      /未配置任何允许的根目录/,
    );
  });

  it("跨父级目录的相对路径（..）被拒绝", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    expect(() =>
      resolveAllowedPath("../../etc/hosts", { allowedRoots: [workspace] }),
    ).toThrow(/VALIDATION_PATH_ESCAPE|路径越界/);
  });

  it("错误文案包含 allowedWriteRoots 配置指引（面向用户的可执行建议）", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    let message = "";
    try {
      resolveAllowedPath("/etc/hosts", { allowedRoots: [workspace] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("路径越界");
    expect(message).toContain("safety.allowedWriteRoots");
    expect(message).toContain("相对路径");
  });
});

describe("resolveWorkspacePath（兼容层）", () => {
  it("等价于 allowedRoots=[workspaceRoot] 的 resolveAllowedPath", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    const out = resolveWorkspacePath(workspace, "child.txt");
    expect(out).toBe(join(workspace, "child.txt"));
  });

  it("越界时仍抛出 VALIDATION_PATH_ESCAPE", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tachu-path-ws-"));
    expect(() => resolveWorkspacePath(workspace, "/etc/hosts")).toThrow(
      /VALIDATION_PATH_ESCAPE|路径越界/,
    );
  });
});
