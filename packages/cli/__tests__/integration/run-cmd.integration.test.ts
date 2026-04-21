/**
 * tachu run 命令集成测试
 *
 * 使用 MockProvider 验证 run 命令的端到端流程、session 持久化和输出格式。
 */

import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultEngineConfig } from "@tachu/core";
import { MockProviderAdapter } from "@tachu/extensions";
import { createEngine } from "../../src/engine-factory";
import { scanDescriptors } from "../../src/config-loader/descriptor-scanner";
import { FsSessionStore } from "../../src/session-store/fs-session-store";
import { StreamRenderer } from "../../src/renderer/stream-renderer";
import { setNoColor, resetColorState } from "../../src/renderer/color";
import { randomUUID } from "node:crypto";
import type { EngineOutput } from "@tachu/core";

let tmpDir: string;

async function makeWorkspace(): Promise<{ dir: string; tachyDir: string; sessionsDir: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "tachu-run-test-"));
  const tachyDir = join(tmpDir, ".tachu");
  const sessionsDir = join(tachyDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(tachyDir, "rules"), { recursive: true });
  await mkdir(join(tachyDir, "skills"), { recursive: true });
  await mkdir(join(tachyDir, "tools"), { recursive: true });
  await mkdir(join(tachyDir, "agents"), { recursive: true });
  return { dir: tmpDir, tachyDir, sessionsDir };
}

async function createMockEngine(tachyDir: string) {
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
  const registry = await scanDescriptors(tachyDir, false);
  return createEngine(config, {
    providers: [new MockProviderAdapter()],
    cwd: tmpDir,
    registry,
  });
}

describe("tachu run 集成测试", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(async () => {
    resetColorState();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("MockProvider 执行 prompt 并返回输出", async () => {
    const { tachyDir } = await makeWorkspace();
    const engine = await createMockEngine(tachyDir);

    const sessionId = randomUUID();
    const context = {
      requestId: randomUUID(),
      sessionId,
      traceId: randomUUID(),
      principal: {},
      budget: {},
      scopes: ["*"],
      startedAt: Date.now(),
    };

    const chunks: string[] = [];
    let finalOutput: EngineOutput | undefined;

    for await (const chunk of engine.runStream(
      { content: "hello", metadata: { modality: "text" } },
      context,
    )) {
      if (chunk.type === "delta") {
        chunks.push(chunk.content);
      }
      if (chunk.type === "done") {
        finalOutput = chunk.output;
      }
    }

    await engine.dispose();

    expect(finalOutput).toBeDefined();
    expect(finalOutput!.status).toBe("success");
    // MockProvider 返回 "mock:hello"
    const fullContent = typeof finalOutput!.content === "string"
      ? finalOutput!.content
      : chunks.join("");
    expect(fullContent.length).toBeGreaterThan(0);
  });

  it("session 持久化：run 后 session 文件存在", async () => {
    const { tachyDir, sessionsDir } = await makeWorkspace();
    const engine = await createMockEngine(tachyDir);
    const store = new FsSessionStore(sessionsDir);

    const sessionId = randomUUID();
    const context = {
      requestId: randomUUID(),
      sessionId,
      traceId: randomUUID(),
      principal: {},
      budget: {},
      scopes: ["*"],
      startedAt: Date.now(),
    };

    let finalOutput: EngineOutput | undefined;
    for await (const chunk of engine.runStream(
      { content: "test prompt", metadata: { modality: "text" } },
      context,
    )) {
      if (chunk.type === "done") {
        finalOutput = chunk.output;
      }
    }

    await engine.dispose();

    // 持久化 session
    if (finalOutput) {
      const session = {
        version: 2 as const,
        id: sessionId,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        context: null,
        budget: {
          tokensUsed: finalOutput.metadata.tokenUsage.total,
          toolCallsUsed: finalOutput.metadata.toolCalls.length,
          wallTimeMs: finalOutput.metadata.durationMs,
        },
        checkpoint: null,
      };
      await store.save(session);
    }

    const saved = await store.load(sessionId);
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe(sessionId);
    // 历史由 engine.memorySystem 维护，这里验证 session 元数据落盘 OK
    expect(saved!.budget.tokensUsed).toBeGreaterThanOrEqual(0);
  });

  it("StreamRenderer 渲染 done chunk", async () => {
    const { tachyDir } = await makeWorkspace();
    const engine = await createMockEngine(tachyDir);

    const sessionId = randomUUID();
    const context = {
      requestId: randomUUID(),
      sessionId,
      traceId: randomUUID(),
      principal: {},
      budget: {},
      scopes: ["*"],
      startedAt: Date.now(),
    };

    const renderer = new StreamRenderer({ verbose: false });
    const outputs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      outputs.push(String(chunk));
      return true;
    };

    try {
      for await (const chunk of engine.runStream(
        { content: "render test", metadata: { modality: "text" } },
        context,
      )) {
        renderer.render(chunk);
      }
    } finally {
      process.stdout.write = origWrite;
      await engine.dispose();
      await renderer.dispose();
    }

    const output = outputs.join("");
    expect(output).toContain("done");
  });

  it("SIGINT 取消测试（engine.cancel）", async () => {
    const { tachyDir } = await makeWorkspace();
    const engine = await createMockEngine(tachyDir);

    const sessionId = randomUUID();

    // 立即取消
    engine.cancel(sessionId);

    // cancel 不应抛出
    await engine.dispose();
    expect(true).toBe(true);
  });

  it(
    "tachu chat 收到 SIGINT 两次后以 POSIX 130 退出（真实 spawn + kill SIGINT）",
    async () => {
      const { dir } = await makeWorkspace();

      const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
      const cliEntry = join(repoRoot, "packages", "cli", "src", "index.ts");

      const child = Bun.spawn(
        [process.execPath, "run", cliEntry, "chat", "--no-color"],
        {
          cwd: dir,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NO_COLOR: "1",
            // 防御测试机器上本地 tachu.config.ts 对 CLI 行为的污染
            TACHU_DISABLE_TELEMETRY: "1",
          },
        },
      );

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const collectStream = async (
        stream: ReadableStream<Uint8Array> | null,
        bucket: string[],
      ): Promise<void> => {
        if (!stream) return;
        const decoder = new TextDecoder();
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            bucket.push(decoder.decode(value));
          }
        } catch {
          /* stream 被强制关闭属于正常，忽略 */
        }
      };

      const stdoutP = collectStream(child.stdout as ReadableStream<Uint8Array>, stdoutChunks);
      const stderrP = collectStream(child.stderr as ReadableStream<Uint8Array>, stderrChunks);

      // 等待 chat 进入 readline 循环后再发送 SIGINT，避免进程还没注册 handler
      await new Promise((resolve) => setTimeout(resolve, 400));
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 150));
      child.kill("SIGINT");

      // 保险：若 chat 未能按预期在短时间内退出则兜底强杀（与 120 区分，避免伪阳性）
      const forceExitTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 进程可能已退出 */
        }
      }, 5_000);

      const exitCode = await child.exited;
      clearTimeout(forceExitTimer);
      await Promise.all([stdoutP, stderrP]);

      expect(exitCode).toBe(130);
    },
    15_000,
  );

  it("verbose 模式渲染 progress chunk", async () => {
    const { tachyDir } = await makeWorkspace();
    const engine = await createMockEngine(tachyDir);

    const sessionId = randomUUID();
    const context = {
      requestId: randomUUID(),
      sessionId,
      traceId: randomUUID(),
      principal: {},
      budget: {},
      scopes: ["*"],
      startedAt: Date.now(),
    };

    const renderer = new StreamRenderer({ verbose: true });
    const progressChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      progressChunks.push(String(chunk));
      return true;
    };

    try {
      for await (const chunk of engine.runStream(
        { content: "verbose test", metadata: { modality: "text" } },
        context,
      )) {
        renderer.render(chunk);
      }
    } finally {
      process.stdout.write = origWrite;
      await engine.dispose();
      await renderer.dispose();
    }

    const allOutput = progressChunks.join("");
    // verbose 模式应该有 phase 相关输出
    expect(allOutput.length).toBeGreaterThan(0);
  });
});
