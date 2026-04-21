/**
 * tachu chat 命令单元测试
 *
 * 测试 --history / --export 非交互模式以及命令结构。
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsSessionStore, createEmptySession } from "../session-store/fs-session-store";
import { setNoColor, resetColorState } from "../renderer/color";

let tmpDir: string;

async function makeWorkspace(): Promise<{ dir: string; store: FsSessionStore }> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-chat-unit-"));
  const tachyDir = join(tmpDir, ".tachu");
  const sessionsDir = join(tachyDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(tachyDir, "rules"), { recursive: true });
  await mkdir(join(tachyDir, "skills"), { recursive: true });
  await mkdir(join(tachyDir, "tools"), { recursive: true });
  await mkdir(join(tachyDir, "agents"), { recursive: true });

  // 生成 mock config
  const configContent = `
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
  const store = new FsSessionStore(sessionsDir);
  return { dir: tmpDir, store };
}

type RunFn = (ctx: { args: Record<string, unknown> }) => Promise<void>;

describe("chatCommand --history 非交互模式", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("--history 列出 session（空列表）", async () => {
    const { dir } = await makeWorkspace();
    const { chatCommand } = await import("./chat");
    const origCwd = process.cwd();
    process.chdir(dir);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      outputs.push(args.join(" "));
    };

    try {
      await (chatCommand as unknown as { run: RunFn }).run({
        args: {
          session: "",
          resume: false,
          history: true,
          export: "",
          model: "",
          provider: "",
          verbose: false,
          "no-color": true,
          "plan-mode": false,
        },
      });
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
      process.chdir(origCwd);
    }

    const allOutput = outputs.join("");
    expect(allOutput).toContain("暂无");
  });

  it("--history 列出已有 session", async () => {
    const { dir, store } = await makeWorkspace();
    const { chatCommand } = await import("./chat");
    const origCwd = process.cwd();
    process.chdir(dir);

    // 预先创建 session
    const s = createEmptySession("existing-session");
    await store.save(s);

    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };
    const origLog = console.log.bind(console);
    const logOutputs: string[] = [];
    console.log = (...args: unknown[]) => {
      logOutputs.push(args.join(" "));
    };

    try {
      await (chatCommand as unknown as { run: RunFn }).run({
        args: {
          session: "",
          resume: false,
          history: true,
          export: "",
          model: "",
          provider: "",
          verbose: false,
          "no-color": true,
          "plan-mode": false,
        },
      });
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
      process.chdir(origCwd);
    }

    const allOutput = [...outputs, ...logOutputs].join("");
    expect(allOutput).toContain("existing-session");
  });

  it("--export 缺少 --session 报错退出", async () => {
    const { dir } = await makeWorkspace();
    const { chatCommand } = await import("./chat");
    const origCwd = process.cwd();
    process.chdir(dir);

    const errOutputs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      errOutputs.push(String(chunk));
      return true;
    };
    const origLog = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      errOutputs.push(args.join(" "));
    };
    const origExit = process.exit.bind(process);
    let exitCode = -1;
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__exit_${code}__`);
    };

    try {
      await (chatCommand as unknown as { run: RunFn }).run({
        args: {
          session: "",
          resume: false,
          history: false,
          export: "/tmp/tachu-export-invalid.md",
          model: "",
          provider: "",
          verbose: false,
          "no-color": true,
          "plan-mode": false,
        },
      });
    } catch (err) {
      // 预期：process.exit(1) 抛出
      expect((err as Error).message).toMatch(/__exit_1__/);
    } finally {
      process.stderr.write = origErr;
      console.error = origLog;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
      process.chdir(origCwd);
    }

    expect(exitCode).toBe(1);
    expect(errOutputs.join("")).toContain("--export");
  });

  it("--export 指定不存在的 session 报错退出", async () => {
    const { dir } = await makeWorkspace();
    const { chatCommand } = await import("./chat");
    const origCwd = process.cwd();
    process.chdir(dir);

    const errOutputs: string[] = [];
    const origLog = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      errOutputs.push(args.join(" "));
    };
    const origExit = process.exit.bind(process);
    let exitCode = -1;
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`__exit_${code}__`);
    };

    try {
      await (chatCommand as unknown as { run: RunFn }).run({
        args: {
          session: "non-existent-session-id",
          resume: false,
          history: false,
          export: join(tmpDir, "nonexistent-export.md"),
          model: "",
          provider: "",
          verbose: false,
          "no-color": true,
          "plan-mode": false,
        },
      });
    } catch {
      // process.exit 抛出，忽略
    } finally {
      console.error = origLog;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
      process.chdir(origCwd);
    }

    expect(exitCode).toBe(1);
    expect(errOutputs.join("")).toContain("导出失败");
  });

  it("--export 导出 session 到 Markdown", async () => {
    const { dir, store } = await makeWorkspace();
    const { chatCommand } = await import("./chat");
    const origCwd = process.cwd();
    process.chdir(dir);

    const s = createEmptySession("export-chat");
    await store.save(s);
    // 模拟 FsMemorySystem 把历史写到 .tachu/memory/<id>.jsonl
    const memoryDir = join(dir, ".tachu", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "export-chat.jsonl"),
      JSON.stringify({
        role: "user",
        content: "hello",
        timestamp: Date.now(),
        anchored: false,
      }) + "\n",
      "utf8",
    );

    const exportPath = join(tmpDir, "chat-export.md");
    const logOutputs: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      logOutputs.push(args.join(" "));
    };

    try {
      await (chatCommand as unknown as { run: RunFn }).run({
        args: {
          session: "export-chat",
          resume: false,
          history: false,
          export: exportPath,
          model: "",
          provider: "",
          verbose: false,
          "no-color": true,
          "plan-mode": false,
        },
      });
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
    }

    const { existsSync } = await import("node:fs");
    expect(existsSync(exportPath)).toBe(true);
  });
});
