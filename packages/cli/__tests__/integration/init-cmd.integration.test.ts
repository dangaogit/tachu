/**
 * tachu init 命令集成测试
 *
 * 验证在临时目录运行 init 后生成正确的文件结构和配置内容。
 */

import { describe, expect, it, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

/**
 * 调用 tachu init 命令（通过 import 方式直接运行，绕开子进程）。
 */
async function runInit(args: Record<string, unknown>, targetDir: string): Promise<void> {
  const { initCommand } = await import("../../src/commands/init");
  // 临时改变 CWD
  const originalCwd = process.cwd();
  process.chdir(targetDir);
  try {
    await (initCommand as unknown as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({ args });
  } finally {
    process.chdir(originalCwd);
  }
}

describe("tachu init 集成测试", () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("minimal 模板生成正确的目录结构", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-test-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    // 验证目录结构
    expect(existsSync(join(tmpDir, ".tachu"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "rules"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "skills"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "tools"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "agents"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "sessions"))).toBe(true);
    expect(existsSync(join(tmpDir, "tachu.config.ts"))).toBe(true);
  });

  it("生成的 tachu.config.ts 包含正确的 provider 配置", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-config-"));

    await runInit({
      template: "minimal",
      provider: "openai",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    const configContent = await readFile(join(tmpDir, "tachu.config.ts"), "utf8");
    expect(configContent).toContain("openai");
    expect(configContent).toContain("gpt-4o");
    expect(configContent).toContain("EngineConfig");
  });

  it("mock provider 生成 mock-chat 模型配置", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-mock-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    const configContent = await readFile(join(tmpDir, "tachu.config.ts"), "utf8");
    expect(configContent).toContain("mock");
    expect(configContent).toContain("mock-chat");
  });

  it("生成 README.md 文件到各子目录", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-readme-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    expect(existsSync(join(tmpDir, ".tachu", "rules", "README.md"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "skills", "README.md"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "tools", "README.md"))).toBe(true);
    expect(existsSync(join(tmpDir, ".tachu", "agents", "README.md"))).toBe(true);
  });

  it("minimal 模板生成示例 rule（未指定 --no-examples）", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-examples-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    expect(
      existsSync(join(tmpDir, ".tachu", "rules", "no-sensitive-output-example.md")),
    ).toBe(true);
    // 内置 rule `no-sensitive-output` 已在 extensions 层提供，init 不应再写入同名文件
    expect(existsSync(join(tmpDir, ".tachu", "rules", "no-sensitive-output.md"))).toBe(
      false,
    );
  });

  it("--no-examples 跳过示例描述符", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-noex-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": true,
    }, tmpDir);

    expect(
      existsSync(join(tmpDir, ".tachu", "rules", "no-sensitive-output-example.md")),
    ).toBe(false);
  });

  it("追加 .gitignore 条目", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-gitignore-"));

    await runInit({
      template: "minimal",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    const gitignoreContent = await readFile(join(tmpDir, ".gitignore"), "utf8");
    expect(gitignoreContent).toContain(".tachu/sessions/");
    expect(gitignoreContent).toContain(".tachu/archive.jsonl");
    expect(gitignoreContent).toContain(".tachu/events.jsonl");
    expect(gitignoreContent).toContain(".tachu/vectors.json");
  });

  it("full 模板包含额外示例文件", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-full-"));

    await runInit({
      template: "full",
      provider: "mock",
      force: true,
      path: "",
      "no-examples": false,
    }, tmpDir);

    expect(existsSync(join(tmpDir, ".tachu", "tools", "example-custom-tool.md"))).toBe(true);
  });
});
