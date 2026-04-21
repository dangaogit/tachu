import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DefaultObservabilityEmitter, type EngineEvent } from "@tachu/core";
import { JsonlEmitter } from "@tachu/extensions";
import { resetColorState, setNoColor } from "../renderer/color";
import {
  attachCliDebugPrinter,
  buildCliObservability,
} from "./cli-observability";

const captureStreams = (fn: () => void): { stdout: string; stderr: string } => {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: outChunks.join(""), stderr: errChunks.join("") };
};

const makeEngineConfig = (overrides: {
  observabilityEnabled: boolean;
}): Parameters<typeof buildCliObservability>[0] => ({
  version: "test",
  runtime: { planMode: false, toolLoopMaxSteps: 8 },
  models: { capabilityMapping: {}, providerFallbackOrder: [] },
  providers: {},
  memory: {
    persistence: "memory",
    vectorIndexLimit: 128,
    compressionThreshold: 4000,
    persistDir: ".tachu/memory",
  },
  safety: { allowedWriteRoots: [], defaultGate: false },
  budget: { maxWallTimeMs: 60_000, maxTokens: 100_000, maxToolCalls: 20 },
  observability: {
    enabled: overrides.observabilityEnabled,
    maskSensitiveData: true,
  },
  hooks: { writeHookTimeout: 5_000, failureBehavior: "continue" },
  // biome / TS 可能会要求 mcpServers 存在；留空即可。
  mcpServers: {},
}) as unknown as Parameters<typeof buildCliObservability>[0];

describe("buildCliObservability", () => {
  it("observability.enabled=false 返回 DefaultObservabilityEmitter", () => {
    const emitter = buildCliObservability(
      makeEngineConfig({ observabilityEnabled: false }),
      "/tmp/tachu-cli-obs-test",
    );
    expect(emitter).toBeInstanceOf(DefaultObservabilityEmitter);
  });

  it("observability.enabled=true 返回 JsonlEmitter（写入 .tachu/events.jsonl）", () => {
    const emitter = buildCliObservability(
      makeEngineConfig({ observabilityEnabled: true }),
      "/tmp/tachu-cli-obs-test",
    );
    expect(emitter).toBeInstanceOf(JsonlEmitter);
  });
});

describe("attachCliDebugPrinter", () => {
  beforeEach(() => {
    setNoColor(true);
  });
  afterEach(() => {
    resetColorState();
  });

  /**
   * 关闭默认 masker 以便断言原始 payload。
   *
   * Core 的 `maskSensitiveData` 会把 key 里含 `token` 的字段整体替换成
   * `[MASKED]`；对 `tokenUsage` 这类合法键也会"误伤"，所以单元测试统一
   * 换成恒等 masker，只验证 `attachCliDebugPrinter` 自身的格式化行为。
   */
  const newEmitter = (): DefaultObservabilityEmitter => {
    const emitter = new DefaultObservabilityEmitter();
    emitter.setMasker((p) => p);
    return emitter;
  };

  const fireEvent = (
    emitter: DefaultObservabilityEmitter,
    event: Partial<EngineEvent> & Pick<EngineEvent, "type" | "payload">,
  ): void => {
    emitter.emit({
      timestamp: Date.now(),
      traceId: event.traceId ?? "trace-x",
      sessionId: event.sessionId ?? "sess-x",
      phase: event.phase ?? "test",
      type: event.type,
      payload: event.payload,
    });
  };

  it("订阅 * 事件并把事件摘要写入 stderr，不污染 stdout", () => {
    const emitter = newEmitter();
    const detach = attachCliDebugPrinter(emitter);
    const { stdout, stderr } = captureStreams(() => {
      fireEvent(emitter, {
        type: "llm_call_end",
        phase: "planning",
        payload: {
          provider: "openai",
          model: "gpt-test",
          durationMs: 1234,
          tokenUsage: { input: 10, output: 20, total: 30 },
        },
      });
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("[debug ");
    expect(stderr).toContain("planning.llm_call_end");
    expect(stderr).toContain("provider=openai");
    expect(stderr).toContain("ms=1234");
    expect(stderr).toContain("total=30");
    detach();
  });

  it("tool_call_start 事件打印 tool / callId / argumentsPreview", () => {
    const emitter = newEmitter();
    const detach = attachCliDebugPrinter(emitter);
    const { stderr } = captureStreams(() => {
      fireEvent(emitter, {
        type: "tool_call_start",
        phase: "execution",
        payload: {
          tool: "remoteKb__listDocs",
          callId: "call-42",
          argumentsPreview: '{"q":"release notes"}',
        },
      });
    });
    expect(stderr).toContain("execution.tool_call_start");
    expect(stderr).toContain("tool=remoteKb__listDocs");
    expect(stderr).toContain("callId=call-42");
    expect(stderr).toContain('args={"q":"release notes"}');
    detach();
  });

  it("warning / error 事件带 message 与 code", () => {
    const emitter = newEmitter();
    const detach = attachCliDebugPrinter(emitter);
    const { stderr } = captureStreams(() => {
      fireEvent(emitter, {
        type: "warning",
        phase: "mcp",
        payload: { message: "remoteKb offline", serverId: "remoteKb" },
      });
    });
    expect(stderr).toContain("mcp.warning");
    expect(stderr).toContain("message=remoteKb offline");
    expect(stderr).toContain("serverId=remoteKb");
    detach();
  });

  it("返回的 detach 函数执行后不再收到事件", () => {
    const emitter = newEmitter();
    const detach = attachCliDebugPrinter(emitter);
    detach();
    const { stderr } = captureStreams(() => {
      fireEvent(emitter, {
        type: "llm_call_start",
        phase: "planning",
        payload: { provider: "openai", model: "gpt-test", messageCount: 3 },
      });
    });
    expect(stderr).toBe("");
  });

  it("超长 payload 会被截断到预览长度内", () => {
    const emitter = newEmitter();
    const detach = attachCliDebugPrinter(emitter);
    const huge = "x".repeat(1024);
    const { stderr } = captureStreams(() => {
      fireEvent(emitter, {
        type: "tool_call_start",
        phase: "execution",
        payload: {
          tool: "bigTool",
          callId: "c1",
          argumentsPreview: huge,
        },
      });
    });
    expect(stderr).toContain("tool=bigTool");
    // 截断后的单次事件行长度应远小于原始 payload
    expect(stderr.length).toBeLessThan(huge.length);
    expect(stderr).toMatch(/…/);
    detach();
  });
});
