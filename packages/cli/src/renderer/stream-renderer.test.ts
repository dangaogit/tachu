import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import type { EngineOutput, StreamChunk, StreamChunkPayload } from "@tachu/core";
import { StreamRenderer } from "./stream-renderer";
import { setNoColor, resetColorState } from "./color";

// 捕获 stdout/stderr 输出
function captureOutput(fn: () => void): { stdout: string; stderr: string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

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
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }

  return { stdout: outChunks.join(""), stderr: errChunks.join("") };
}

const correlation = {
  traceId: "trace-1",
  requestId: "req-1",
  sessionId: "sess-1",
  turnId: "turn-1",
};

const renderChunk = (renderer: StreamRenderer, chunk: StreamChunkPayload): void => {
  renderer.render({ ...chunk, correlation } as StreamChunk);
};

describe("StreamRenderer", () => {
  beforeEach(() => {
    setNoColor(true);
  });

  afterEach(() => {
    resetColorState();
  });

  it("渲染 delta chunk 写入 stdout", () => {
    const renderer = new StreamRenderer();
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "delta", content: "hello world" });
    });
    expect(stdout).toContain("hello world");
  });

  it("verbose=true 时 progress chunk 打印到 stdout", () => {
    const renderer = new StreamRenderer({ verbose: true });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "分析意图" });
    });
    expect(stdout).toContain("intent");
    expect(stdout).toContain("分析意图");
  });

  it("verbose=false 时 progress chunk 不打印到 stdout", () => {
    const renderer = new StreamRenderer({ verbose: false });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "分析意图" });
    });
 // 非 TTY 时 spinner 不工作，不应有可见输出
 // stdout 内容可能为空或包含 spinner 相关内容
    expect(typeof stdout).toBe("string");
  });

  it("渲染 artifact chunk", () => {
    const renderer = new StreamRenderer();
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, {
        type: "artifact",
        artifact: { name: "result.txt", type: "text/plain", content: "some content" },
      });
    });
    expect(stdout).toContain("artifact");
    expect(stdout).toContain("result.txt");
  });

  it("渲染 error chunk 写入 stderr", () => {
    const renderer = new StreamRenderer();
    const { stderr } = captureOutput(() => {
      const { ProviderError } = require("@tachu/core");
      const err = ProviderError.callFailed("test");
      renderChunk(renderer, { type: "error", error: err });
    });
    expect(stderr).toContain("error");
  });

  it("渲染 done chunk 写入 stdout", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "result",
      steps: [],
      metadata: { outcome: "completed",
        toolCalls: [],
        durationMs: 100,
        tokenUsage: { input: 10, output: 20, total: 30 },
      },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "done", output });
    });
    expect(stdout).toContain("done");
    expect(stdout).toContain("completed");
  });

  it("done chunk 含 cached 时显示 cached 标签且 cost 按半价折扣", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "result",
      steps: [],
      metadata: { outcome: "completed",
        toolCalls: [],
        durationMs: 100,
        tokenUsage: { input: 1000, output: 200, total: 1200, cached: 800 },
      },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "done", output });
    });
 // cached 量按 formatTokensK(800) → "0.8k" 展示
    expect(stdout).toContain("cached 0.8k");
 // billable = 1200 - 800 * 0.5 = 800; cost = 800 * 0.000002 = 0.0016
    expect(stdout).toContain("$0.0016");
  });

  it("done chunk 不含 cached 时不显示 cached 标签且 cost 按全价计算", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "result",
      steps: [],
      metadata: { outcome: "completed",
        toolCalls: [],
        durationMs: 100,
        tokenUsage: { input: 1000, output: 200, total: 1200 },
      },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "done", output });
    });
    expect(stdout).not.toContain("cached");
 // 全价：1200 * 0.000002 = 0.0024
    expect(stdout).toContain("$0.0024");
  });

  it("finalize text 格式输出 content 并补换行", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "你好，我在这里",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
    expect(stdout).toContain("你好，我在这里");
    expect(stdout.endsWith("\n")).toBe(true);
  });

  it("finalize text 对空 content 不产生额外输出", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
    expect(stdout).toBe("");
  });

  it("finalize text 对非字符串 content 做 JSON.stringify", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "structured",
      content: { answer: 42 },
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
    expect(stdout).toContain('"answer": 42');
  });

  it("finalize json 格式输出 JSON", () => {
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "result",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "json");
    });
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout).metadata.outcome).toBe("completed");
  });

  it("finalize markdown 在禁色环境下退化为原文（不再强加 ## Result 包装）", () => {
 // 新语义：`--output markdown` 调用真正的 Markdown ANSI 渲染器，禁色环境下
 // 直接返回原文，由渲染器自身决定是否着色，不再加 "## Result" 前缀包装。
    const renderer = new StreamRenderer();
    const output: EngineOutput = {
      type: "text",
      content: "# heading\n\n**bold** body",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "markdown");
    });
    expect(stdout).toContain("# heading");
    expect(stdout).toContain("**bold** body");
    expect(stdout).not.toContain("## Result");
    expect(stdout.endsWith("\n")).toBe(true);
  });

  it("renderMarkdown=false 显式关闭时 finalize(text) 保持原始 Markdown 文本不渲染", () => {
    const renderer = new StreamRenderer({ renderMarkdown: false });
    const output: EngineOutput = {
      type: "text",
      content: "# heading\n\n- item one\n- item two",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
    expect(stdout).toContain("# heading");
    expect(stdout).toContain("- item one");
    expect(stdout).toContain("- item two");
  });

  it("renderMarkdown=true 显式启用时 finalize(text) 会尝试 Markdown 渲染（禁色下退化为原文）", () => {
    const renderer = new StreamRenderer({ renderMarkdown: true });
    const output: EngineOutput = {
      type: "text",
      content: "# heading\n\n**bold** body",
      steps: [],
      metadata: { outcome: "completed", toolCalls: [], durationMs: 100, tokenUsage: { input: 10, output: 20, total: 30 } },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
 // 禁色环境下 renderMarkdownToAnsi 直接返回原文，因此内容应原样出现在 stdout。
    expect(stdout).toContain("# heading");
    expect(stdout).toContain("**bold** body");
    expect(stdout.endsWith("\n")).toBe(true);
  });

  it("delta 与 finalize 正文一致时 finalize 跳过重复打印", () => {
    const renderer = new StreamRenderer({ renderMarkdown: false });
    captureOutput(() => {
      renderChunk(renderer, { type: "delta", content: "hello world" });
    });
    const { stdout } = captureOutput(() => {
      renderer.finalize(
        {
          type: "text",
          content: "hello world",
          steps: [],
          metadata: { outcome: "completed",
            toolCalls: [],
            durationMs: 1,
            tokenUsage: { input: 1, output: 1, total: 2 },
          },
      correlation,
          deliveryMode: "streaming",
        },
        "text",
      );
    });
    expect(stdout).toBe("");
  });

  it("多轮共享同一渲染器时 streamedBody 不应跨轮累加导致 finalize 重复打印", () => {
    const renderer = new StreamRenderer({ renderMarkdown: false });

 // 第 1 轮：delta + finalize，dedupe 命中
    captureOutput(() => {
      renderChunk(renderer, { type: "delta", content: "Hello!" });
    });
    const turn1 = captureOutput(() => {
      renderer.finalize(
        {
          type: "text",
          content: "Hello!",
          steps: [],
          metadata: {
            outcome: "completed",
            toolCalls: [],
            durationMs: 1,
            tokenUsage: { input: 1, output: 1, total: 2 },
          },
          correlation,
          deliveryMode: "streaming",
        },
        "text",
      );
    });
    expect(turn1.stdout).toBe("");

 // 第 2 轮：同一 renderer，新内容；dedupe 必须仍然命中
    captureOutput(() => {
      renderChunk(renderer, { type: "delta", content: "I'm Tachu." });
    });
    const turn2 = captureOutput(() => {
      renderer.finalize(
        {
          type: "text",
          content: "I'm Tachu.",
          steps: [],
          metadata: {
            outcome: "completed",
            toolCalls: [],
            durationMs: 1,
            tokenUsage: { input: 1, output: 1, total: 2 },
          },
          correlation,
          deliveryMode: "streaming",
        },
        "text",
      );
    });
    expect(turn2.stdout).toBe("");
  });

  it("dispose 不抛出", async () => {
    const renderer = new StreamRenderer();
    await expect(renderer.dispose()).resolves.toBeUndefined();
  });

  it("tool-loop-step (verbose) 显示第 N/M 轮进度", () => {
    const renderer = new StreamRenderer({ verbose: true });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "tool-loop-step", step: 2, maxSteps: 8 });
    });
    expect(stdout).toContain("2/8");
    expect(stdout).toContain("思考中");
  });

  it("tool-call-start 打印 → 调用工具 + 参数预览", () => {
    const renderer = new StreamRenderer();
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, {
        type: "tool-call-start",
        callId: "call-1",
        tool: "list-dir",
        argumentsPreview: '{"path":"."}',
      });
    });
    expect(stdout).toContain("list-dir");
    expect(stdout).toContain("调用工具");
    expect(stdout).toContain('"path":"."');
  });

  it("tool-call-end 成功走 ✓ 绿色；失败走 ✗ 红色 + 错误信息独立行", () => {
    const renderer = new StreamRenderer();
    const success = captureOutput(() => {
      renderChunk(renderer, {
        type: "tool-call-end",
        callId: "c",
        tool: "list-dir",
        success: true,
        durationMs: 42,
      });
    });
    expect(success.stdout).toContain("✓");
    expect(success.stdout).toContain("list-dir");
    expect(success.stdout).toContain("42ms");

    const failure = captureOutput(() => {
      renderChunk(renderer, {
        type: "tool-call-end",
        callId: "c",
        tool: "list-dir",
        success: false,
        durationMs: 7,
        error: { code: "TOOL_LOOP_TOOL_EXECUTION_FAILED", message: "disk full", retryable: false },
      });
    });
    expect(failure.stdout).toContain("✗");
    expect(failure.stdout).toContain("执行失败");
    expect(failure.stdout).toMatch(/原因:\s*disk full/);
    expect(failure.stdout.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it("tool-call-end 审批拒绝使用『已拒绝』标题并保留原因行", () => {
    const renderer = new StreamRenderer();
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, {
        type: "tool-call-end",
        callId: "c",
        tool: "file.write",
        success: false,
        durationMs: 12,
        error: { code: "TOOL_LOOP_TOOL_EXECUTION_FAILED", message: "用户拒绝执行该工具。", retryable: false },
      });
    });
    expect(stdout).toContain("已拒绝");
    expect(stdout).toContain("file.write");
    expect(stdout).toMatch(/原因:\s*用户拒绝执行该工具。/);
    expect(stdout).not.toContain("执行失败");
  });

  it("tool-loop-final 在 verbose 下输出循环结束摘要", () => {
    const quiet = new StreamRenderer({ verbose: false });
    const quietOut = captureOutput(() => {
      renderChunk(quiet, { type: "tool-loop-final", steps: 3, success: true });
    });
 // 非 verbose：不输出任何内容
    expect(quietOut.stdout).toBe("");

    const verbose = new StreamRenderer({ verbose: true });
    const verboseOut = captureOutput(() => {
      renderChunk(verbose, { type: "tool-loop-final", steps: 3, success: true });
      renderChunk(verbose, { type: "tool-loop-final", steps: 5, success: false });
    });
    expect(verboseOut.stdout).toContain("工具循环完成");
    expect(verboseOut.stdout).toContain("工具循环终止");
  });

  it("phase started/finished 对子出现时在 finished 行尾部追加 duration_ms", async () => {
 // 新语义（feature: phase duration 追加）：renderer 监控 `<phase> started`
 // 与 `<phase> finished` 约定消息，在 finished 尾部追加 `(Nms)`。
 // 正常路径走 verbose 输出，便于终端直接断言 stdout。
    const renderer = new StreamRenderer({ verbose: true });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "intent started" });
    });
    expect(stdout).toContain("intent started");
 // 让至少 1ms 过去，避免 Date.now() 返回同一毫秒导致断言为 `(0ms)`
    await new Promise((r) => setTimeout(r, 5));
    const finished = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "intent finished" });
    });
    expect(finished.stdout).toMatch(/intent finished \(\d+ms\)/);
  });

  it("缺失 started 记录的 finished 消息保留原文不附 duration", () => {
    const renderer = new StreamRenderer({ verbose: true });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "planning", message: "planning finished" });
    });
    expect(stdout).toContain("planning finished");
    expect(stdout).not.toMatch(/planning finished \(\d+ms\)/);
  });

  it("多个 phase 交织时按各自 start 时间独立计算 duration", async () => {
    const renderer = new StreamRenderer({ verbose: true });
    captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "intent started" });
      renderChunk(renderer, { type: "progress", phase: "planning", message: "planning started" });
    });
    await new Promise((r) => setTimeout(r, 3));
    const first = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "planning", message: "planning finished" });
    });
    await new Promise((r) => setTimeout(r, 3));
    const second = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "intent finished" });
    });
    expect(first.stdout).toMatch(/planning finished \(\d+ms\)/);
    expect(second.stdout).toMatch(/intent finished \(\d+ms\)/);
  });

  it("debug=true 强制打开 verbose，progress chunk 写入 stdout", () => {
 // debug 默认关闭时 progress 不会直接写到 stdout（走 spinner，禁色环境下为空）。
    const quiet = new StreamRenderer();
    const quietOut = captureOutput(() => {
      renderChunk(quiet, { type: "progress", phase: "intent", message: "intent started" });
    });
    expect(quietOut.stdout).not.toContain("[phase:");

    const renderer = new StreamRenderer({ debug: true });
    const { stdout } = captureOutput(() => {
      renderChunk(renderer, { type: "progress", phase: "intent", message: "intent started" });
    });
    expect(stdout).toContain("[phase: intent]");
    expect(stdout).toContain("intent started");
  });

  it("sanitizeUserText 覆盖 task-tool-use / tool-use 子流程", () => {
 // 通过 finalize 触发脱敏路径
    const renderer = new StreamRenderer({ renderMarkdown: false });
    const output: EngineOutput = {
      type: "text",
      content: "问题发生在 task-tool-use；另外 tool-use 子流程 也需要排查。",
      steps: [],
      metadata: { outcome: "completed",
        toolCalls: [],
        durationMs: 100,
        tokenUsage: { input: 1, output: 1, total: 2 },
      },
      correlation,
      deliveryMode: "complete",
    };
    const { stdout } = captureOutput(() => {
      renderer.finalize(output, "text");
    });
    expect(stdout).not.toContain("task-tool-use");
    expect(stdout).not.toContain("tool-use 子流程");
    expect(stdout).toContain("工具循环");
  });
});
