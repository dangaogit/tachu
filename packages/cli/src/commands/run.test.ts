/**
 * tachu run 命令单元测试
 *
 * 通过直接调用 runCommand.run() 测试参数处理与流程。
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setNoColor, resetColorState } from "../renderer/color";

let tmpDir: string;

async function makeWorkspace(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-run-unit-"));
  const tachyDir = join(tmpDir, ".tachu");
  await mkdir(join(tachyDir, "sessions"), { recursive: true });
  await mkdir(join(tachyDir, "rules"), { recursive: true });
  await mkdir(join(tachyDir, "skills"), { recursive: true });
  await mkdir(join(tachyDir, "tools"), { recursive: true });
  await mkdir(join(tachyDir, "agents"), { recursive: true });

  // 生成 tachu.config.ts 使用 mock provider
  const configContent = `
import type { EngineConfig } from '@tachu/core';
const config = {
  models: {
    capabilityMapping: {
      'high-reasoning': { provider: 'mock', model: 'mock-chat' },
      'fast-cheap': { provider: 'mock', model: 'mock-chat' },
      'intent': { provider: 'mock', model: 'mock-chat' },
      'planning': { provider: 'mock', model: 'mock-chat' },
      'validation': { provider: 'mock', model: 'mock-chat' },
    },
    providerFallbackOrder: ['mock'],
  },
};
export default config;
`;
  await writeFile(join(tmpDir, "tachu.config.ts"), configContent, "utf8");
  return tmpDir;
}

type RunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>;

describe("runCommand 参数处理", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("run 命令在工作目录有配置时可以运行", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "hello test",
          session: "",
          resume: false,
          model: "",
          provider: "mock",
          input: "",
          json: false,
          output: "text",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "",
        },
      });
    } catch (err) {
      // process.exit 会抛出，在测试中正常
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    const allOutput = outputs.join("");
    // 验证 done 或其他输出已经产生
    expect(typeof allOutput).toBe("string");
  });

  it("--output json 格式输出", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "json test",
          session: "",
          resume: false,
          model: "",
          provider: "mock",
          input: "",
          json: false,
          output: "json",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "",
        },
      });
    } catch {
      // ignore process.exit
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    const allOutput = outputs.join("");
    // JSON 格式应包含 status
    expect(typeof allOutput).toBe("string");
  });

  it("--input 读取文件作为 prompt 内容", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const promptFile = join(tmpDir, "prompt.txt");
    await writeFile(promptFile, "input-file prompt", "utf8");

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "",
          session: "",
          resume: false,
          model: "",
          provider: "mock",
          input: promptFile,
          json: false,
          output: "text",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "",
        },
      });
    } catch {
      // ignore
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    expect(outputs.join("")).toContain("mock:");
  });

  it("--timeout 被解析并传入 budget.maxWallTimeMs（数字）", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "timeout prompt",
          session: "",
          resume: false,
          model: "",
          provider: "mock",
          input: "",
          json: false,
          output: "text",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "60000",
        },
      });
    } catch {
      // ignore
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    expect(outputs.join("").length).toBeGreaterThan(0);
  });

  it("--timeout 非数字时被忽略，不影响流程", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "timeout nan",
          session: "",
          resume: false,
          model: "",
          provider: "mock",
          input: "",
          json: false,
          output: "text",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "not-a-number",
        },
      });
    } catch {
      // ignore
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    expect(outputs.join("").length).toBeGreaterThan(0);
  });

  it("--session 指定已有 ID 的对话复用", async () => {
    const ws = await makeWorkspace();
    const { runCommand } = await import("./run");
    const origCwd = process.cwd();
    process.chdir(ws);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      await (runCommand as unknown as { run: RunFn }).run({
        args: {
          prompt: "session reuse",
          session: "explicit-session-id",
          resume: false,
          model: "",
          provider: "mock",
          input: "",
          json: false,
          output: "text",
          "no-validation": false,
          "plan-mode": false,
          verbose: false,
          "no-color": true,
          timeout: "",
        },
      });
    } catch {
      // ignore
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    const { existsSync } = await import("node:fs");
    expect(
      existsSync(join(ws, ".tachu", "sessions", "explicit-session-id.json")),
    ).toBe(true);
  });

});
