/**
 * tachu init 命令单元测试
 *
 * 重点验证基础 rule（respond-in-user-language）默认无条件落盘，
 * 不依赖 --no-examples 标志。
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setNoColor, resetColorState } from "../renderer/color";

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-init-unit-"));
  return tmpDir;
}

type RunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>;

function defaultArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: "minimal",
    force: false,
    path: "",
    provider: "mock",
    "no-examples": false,
    ...overrides,
  };
}

describe("initCommand 默认 rule 写入", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("runInit 在 .tachu/rules/ 下生成 respond-in-user-language.md", async () => {
    const dir = await makeTmpDir();
    const { initCommand } = await import("./init");

    const origLog = console.log.bind(console);
    console.log = () => {};
    try {
      await (initCommand as unknown as { run: RunFn }).run({
        args: defaultArgs({ path: dir }),
      });
    } finally {
      console.log = origLog;
    }

    const rulePath = join(dir, ".tachu", "rules", "respond-in-user-language.md");
    expect(existsSync(rulePath)).toBe(true);
  });

  it("respond-in-user-language.md 内容包含 language mirror 关键句", async () => {
    const dir = await makeTmpDir();
    const { initCommand } = await import("./init");

    const origLog = console.log.bind(console);
    console.log = () => {};
    try {
      await (initCommand as unknown as { run: RunFn }).run({
        args: defaultArgs({ path: dir }),
      });
    } finally {
      console.log = origLog;
    }

    const rulePath = join(dir, ".tachu", "rules", "respond-in-user-language.md");
    const content = await readFile(rulePath, "utf8");
    expect(content).toContain("Respond in the same language");
    expect(content).toContain("kind: rule");
  });

  it("生成的 tachu.config.ts 默认带 shortTaskRoute 与 shellAutoApprovePatterns 配置", async () => {
    const dir = await makeTmpDir();
    const { initCommand } = await import("./init");

    const origLog = console.log.bind(console);
    console.log = () => {};
    try {
      await (initCommand as unknown as { run: RunFn }).run({
        args: defaultArgs({ path: dir }),
      });
    } finally {
      console.log = origLog;
    }

    const configPath = join(dir, "tachu.config.ts");
    const content = await readFile(configPath, "utf8");
    // shortTaskRoute 默认开启 + 完整四个字段
    expect(content).toContain("shortTaskRoute: {");
    expect(content).toContain("enabled: true");
    expect(content).toContain("capability: 'fast-cheap'");
    expect(content).toContain("maxToolNames: 1");
    expect(content).toContain("maxPromptChars: 120");
    // shellAutoApprovePatterns 默认列出常见 readonly 命令；文件里实际是
    // '^date(\b|$)' 形态（TS 字面量 '\\b'），断言侧把字面量再转义一层即可。
    expect(content).toContain("shellAutoApprovePatterns: [");
    expect(content).toContain("'^date(\\b|$)'");
    expect(content).toContain("'^pwd(\\b|$)'");
    expect(content).toContain("'^whoami(\\b|$)'");
  });

  it("noExamples=true 时仍生成 respond-in-user-language.md", async () => {
    const dir = await makeTmpDir();
    const { initCommand } = await import("./init");

    const origLog = console.log.bind(console);
    console.log = () => {};
    try {
      await (initCommand as unknown as { run: RunFn }).run({
        args: defaultArgs({ path: dir, "no-examples": true }),
      });
    } finally {
      console.log = origLog;
    }

    const rulePath = join(dir, ".tachu", "rules", "respond-in-user-language.md");
    expect(existsSync(rulePath)).toBe(true);
    // 同时验证示例 rule（受 noExamples 控制）确实被跳过，
    // 反向证明 respond-in-user-language 是基础 rule，不是示例 rule。
    const exampleRulePath = join(
      dir,
      ".tachu",
      "rules",
      "no-sensitive-output-example.md",
    );
    expect(existsSync(exampleRulePath)).toBe(false);
  });
});
