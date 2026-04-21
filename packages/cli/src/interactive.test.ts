/**
 * interactive.ts 单元测试
 *
 * 直接调用 runInteractiveChat 并通过 mock stdin 注入命令，
 * 覆盖所有 slash 命令分支。
 */
import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createDefaultEngineConfig } from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions";
import { createEngine } from "./engine-factory";
import { FsSessionStore, createEmptySession } from "./session-store/fs-session-store";
import { setNoColor, resetColorState } from "./renderer/color";

let tmpDir: string;

async function makeEnv(): Promise<{ store: FsSessionStore; engine: ReturnType<typeof createEngine>; dir: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-interact-"));
  const sessionsDir = join(tmpDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const store = new FsSessionStore(sessionsDir);

  const config = {
    ...createDefaultEngineConfig(),
    models: {
      capabilityMapping: {
        "high-reasoning": { provider: "mock", model: "mock-chat" },
        "fast-cheap": { provider: "mock", model: "mock-chat" },
        "intent": { provider: "mock", model: "mock-chat" },
        "planning": { provider: "mock", model: "mock-chat" },
        "validation": { provider: "mock", model: "mock-chat" },
      },
      providerFallbackOrder: ["mock"],
    },
  };

  const engine = createEngine(config, {
    providers: [new MockProviderAdapter()],
    cwd: tmpDir,
  });

  return { store, engine, dir: tmpDir };
}

/**
 * 通过 mock stdin 运行 runInteractiveChat 并收集 stdout 输出。
 * 每条 inputLine 应以 "\n" 结尾，最后一条需是 "/exit\n" 以终止循环。
 */
async function runWithInput(
  inputLines: string[],
  engine: ReturnType<typeof createEngine>,
  store: FsSessionStore,
  initialSession?: import("./session-store/fs-session-store").PersistedSession,
): Promise<string> {
  const { runInteractiveChat } = await import("./interactive");

  const outputs: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    outputs.push(String(chunk));
    return true;
  };

  const mockStdin = new Readable({
    read() {
      for (const line of inputLines) {
        this.push(line);
      }
      this.push(null);
    },
  });

  const origStdin = process.stdin;
  process.stdin = mockStdin as typeof process.stdin;

  try {
    await runInteractiveChat(engine, store, {
      verbose: false,
      readline: true,
      ...(initialSession !== undefined ? { initialSession } : {}),
    });
  } catch {
    // readline EOF 时会抛出，忽略
  } finally {
    process.stdout.write = origWrite;
    process.stdin = origStdin;
  }

  return outputs.join("");
}

describe("runInteractiveChat slash 命令", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("/exit 终止循环并输出启动信息", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/exit\n"], engine, store);
    expect(out).toContain("Tachu Chat");
    await engine.dispose();
  });

  it("/help 输出帮助信息", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/help\n", "/exit\n"], engine, store);
    expect(out).toContain("/exit");
    expect(out).toContain("/list");
    await engine.dispose();
  });

  it("/list 无 session 时显示提示", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/list\n", "/exit\n"], engine, store);
    expect(out).toContain("暂无");
    await engine.dispose();
  });

  it("/list 有 session 时列出", async () => {
    const { store, engine } = await makeEnv();
    const s = createEmptySession("list-me");
    await store.save(s);
    const out = await runWithInput(["/list\n", "/exit\n"], engine, store);
    expect(out).toContain("list-me");
    await engine.dispose();
  });

  it("/save 保存当前 session", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/save\n", "/exit\n"], engine, store);
    expect(out).toContain("已保存");
    const sessions = await store.list();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    await engine.dispose();
  });

  it("/stats 显示 session 统计信息", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/stats\n", "/exit\n"], engine, store);
    expect(out).toContain("Session:");
    expect(out).toContain("消息数:");
    await engine.dispose();
  });

  it("/history 无消息时提示", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/history\n", "/exit\n"], engine, store);
    expect(out).toContain("无历史记录");
    await engine.dispose();
  });

  it("/history 有消息时显示消息", async () => {
    const { store, engine } = await makeEnv();
    const session = createEmptySession(randomUUID());
    await engine.getMemorySystem().append(session.id, {
      role: "user",
      content: "test message",
      timestamp: Date.now(),
      anchored: false,
    });
    const out = await runWithInput(["/history\n", "/exit\n"], engine, store, session);
    expect(out).toContain("test message");
    await engine.dispose();
  });

  it("/reset 清空消息", async () => {
    const { store, engine } = await makeEnv();
    const session = createEmptySession(randomUUID());
    await engine.getMemorySystem().append(session.id, {
      role: "user",
      content: "msg to clear",
      timestamp: Date.now(),
      anchored: false,
    });
    const out = await runWithInput(["/reset\n", "/exit\n"], engine, store, session);
    expect(out).toContain("已重置");
    const size = await engine.getMemorySystem().getSize(session.id);
    expect(size.entries).toBe(0);
    await engine.dispose();
  });

  it("/new 开启新 session", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/new\n", "/exit\n"], engine, store);
    expect(out).toContain("已开启新 session");
    await engine.dispose();
  });

  it("/load 不带参数时提示用法", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/load\n", "/exit\n"], engine, store);
    expect(out).toContain("/load <session-id>");
    await engine.dispose();
  });

  it("/load 不存在的 session 提示不存在", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/load nonexistent\n", "/exit\n"], engine, store);
    expect(out).toContain("不存在");
    await engine.dispose();
  });

  it("/load 加载已有 session", async () => {
    const { store, engine } = await makeEnv();
    const s = createEmptySession("loadable");
    await store.save(s);
    const out = await runWithInput(["/load loadable\n", "/exit\n"], engine, store);
    expect(out).toContain("loadable");
    await engine.dispose();
  });

  it("/export 不带参数提示用法", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/export\n", "/exit\n"], engine, store);
    expect(out).toContain("/export <path>");
    await engine.dispose();
  });

  it("/export 带路径导出 Markdown", async () => {
    const { store, engine, dir } = await makeEnv();
    const session = createEmptySession(randomUUID());
    await engine.getMemorySystem().append(session.id, {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
      anchored: false,
    });
    const exportPath = join(dir, "out.md");
    await store.save(session);
    const out = await runWithInput(
      [`/export ${exportPath}\n`, "/exit\n"],
      engine,
      store,
      session,
    );
    expect(out).toContain("已导出");
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(exportPath)).toBe(true);
    expect(readFileSync(exportPath, "utf8")).toContain("hello");
    await engine.dispose();
  });

  it("未知命令提示帮助", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["/unknowncmd\n", "/exit\n"], engine, store);
    expect(out).toContain("未知命令");
    await engine.dispose();
  });

  it("空行被跳过", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["\n", "   \n", "/exit\n"], engine, store);
    expect(out).toContain("Tachu Chat");
    await engine.dispose();
  });

  it("/clear 与 /reset 等价，都清空当前 session 记忆", async () => {
    const { store, engine } = await makeEnv();
    const session = createEmptySession(randomUUID());
    await engine.getMemorySystem().append(session.id, {
      role: "user",
      content: "hello",
      timestamp: Date.now(),
      anchored: false,
    });
    session.budget = { tokensUsed: 10, toolCallsUsed: 1, wallTimeMs: 123 };
    await store.save(session);
    const out = await runWithInput(["/clear\n", "/exit\n"], engine, store, session);
    expect(out).toContain("Session 已重置");
    const size = await engine.getMemorySystem().getSize(session.id);
    expect(size.entries).toBe(0);
    await engine.dispose();
  });

  it("normal 对话走 runStream 并累加 session 历史", async () => {
    const { store, engine } = await makeEnv();
    const out = await runWithInput(["hello\n", "/exit\n"], engine, store);
    expect(out).toContain("Tachu Chat");
    expect(out).toContain("mock:hello");
    await engine.dispose();
  });

  it("runStream 抛错时在 stderr 输出错误，不中断循环", async () => {
    const { store, engine } = await makeEnv();
    // 复用真实 engine 的 memorySystem，保证 interactive 启动路径完整
    const fakeEngine = {
      runStream: async function* () {
        throw new Error("injected runStream failure");
      },
      cancel: async () => {},
      dispose: async () => {},
      getMemorySystem: () => engine.getMemorySystem(),
    } as unknown as ReturnType<typeof createEngine>;
    const errorOutputs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      errorOutputs.push(String(chunk));
      return true;
    };
    try {
      await runWithInput(["hello\n", "/exit\n"], fakeEngine, store);
    } finally {
      process.stderr.write = origErr;
    }
    expect(errorOutputs.join("")).toContain("injected runStream failure");
    await engine.dispose();
  });
});
