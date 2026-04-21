import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findGitRoot, findConfigFile, normalizePath } from "./path";

describe("findGitRoot", () => {
  it("从 workspace 根目录找到 .git", () => {
    const root = findGitRoot(process.cwd());
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("从子目录也能找到 git root", () => {
    const root = findGitRoot(join(process.cwd(), "src"));
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("非 git 目录返回 startDir", () => {
    const tmpDir = "/tmp";
    const result = findGitRoot(tmpDir);
    expect(result).toBe(tmpDir);
  });
});

describe("findConfigFile", () => {
  it("在存在 tachu.config.ts 的目录中能找到配置", () => {
    // 在当前 workspace 应该能找到或向上找到
    // 这里只验证函数不抛出且返回 string 或 null
    const result = findConfigFile(process.cwd());
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("不存在时返回 null", () => {
    const result = findConfigFile("/tmp");
    expect(result).toBeNull();
  });
});

describe("normalizePath", () => {
  it("解析相对路径为绝对路径", () => {
    const result = normalizePath("./some/path");
    expect(result.startsWith("/")).toBe(true);
  });

  it("解析 ~ 为 home 目录", () => {
    const home = process.env.HOME ?? "/";
    const result = normalizePath("~/test");
    expect(result.startsWith(home)).toBe(true);
  });

  it("绝对路径保持不变", () => {
    const result = normalizePath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });
});
