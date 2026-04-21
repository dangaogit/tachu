/**
 * approval-prompt.ts 单元测试。
 *
 * 覆盖：
 *   - 共享 prompter 路径（askViaSharedPrompter）：使用外层 rl 的 question，
 *     不创建内部 readline，避免 pause stdin。
 *   - 内部 readline 兜底路径（askYesNo）：用于一次性执行。
 *   - 非交互 / 自动批准 / options.ask 覆盖等开关。
 */
import { describe, expect, it, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import type { ToolApprovalRequest } from "@tachu/core";
import { buildApprovalPrompt } from "./approval-prompt";
import {
  getInteractivePrompter,
  setInteractivePrompter,
  type InteractivePrompter,
} from "./shared-prompter";

const baseRequest: ToolApprovalRequest = {
  tool: "write-file",
  callId: "call-1",
  arguments: { path: "./cat.txt", content: "hi" },
  argumentsPreview: `{"path":"./cat.txt"}`,
  sideEffect: "write",
  requiresApproval: true,
  triggeredBy: "descriptor",
  traceId: "trace-1",
  sessionId: "sess-1",
};

describe("buildApprovalPrompt", () => {
  afterEach(() => {
    setInteractivePrompter(null);
    delete process.env.TACHU_AUTO_APPROVE;
    delete process.env.NO_TTY;
  });

  it("options.ask 优先于其它路径，y 视为通过", async () => {
    let asked = "";
    const ask: InteractivePrompter = async (query) => {
      asked = query;
      return "y";
    };
    const hook = buildApprovalPrompt({ ask });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(asked).toContain("是否执行");
  });

  it("共享 prompter 会被自动使用（无需显式传 options.ask）", async () => {
    let asked = "";
    setInteractivePrompter(async (query) => {
      asked = query;
      return "yes";
    });
    const hook = buildApprovalPrompt();
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(asked).toContain("是否执行");
  });

  it("共享 prompter 路径下非 y/yes 一律拒绝", async () => {
    setInteractivePrompter(async () => "");
    const hook = buildApprovalPrompt();
    const denied = await hook(baseRequest);
    expect(denied.type).toBe("deny");
    if (denied.type === "deny") {
      expect(denied.reason).toContain("拒绝");
    }
  });

  it("共享 prompter 抛错时返回 deny 并附带原因", async () => {
    setInteractivePrompter(async () => {
      throw new Error("stdin broken");
    });
    const hook = buildApprovalPrompt();
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
    if (decision.type === "deny") {
      expect(decision.reason).toContain("stdin broken");
    }
  });

  it("共享 prompter 路径不会在 process.stdin 上创建新的 readline", async () => {
    // 记录 stdin 初始 listener 数量；共享路径下不应新增任何监听器。
    const listenersBefore = process.stdin.listenerCount("data");
    setInteractivePrompter(async () => "y");
    const hook = buildApprovalPrompt();
    await hook(baseRequest);
    const listenersAfter = process.stdin.listenerCount("data");
    expect(listenersAfter).toBe(listenersBefore);
  });

  it("未注册共享 prompter + 非 TTY 时默认拒绝", async () => {
    const hook = buildApprovalPrompt({ tty: { stdin: false, stderr: false } });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
  });

  it("未注册共享 prompter + 非 TTY + nonInteractiveDecision=approve 时自动通过", async () => {
    const hook = buildApprovalPrompt({
      tty: { stdin: false, stderr: false },
      nonInteractiveDecision: "approve",
    });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
  });

  it("TACHU_AUTO_APPROVE=1 + respectAutoApproveEnv=true 时自动通过（即使注册了 prompter）", async () => {
    process.env.TACHU_AUTO_APPROVE = "1";
    let called = false;
    setInteractivePrompter(async () => {
      called = true;
      return "n";
    });
    const hook = buildApprovalPrompt({ respectAutoApproveEnv: true });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(called).toBe(false);
  });

  it("内部 readline 兜底路径：输入 y 通过，readline 关闭后 stdin 会被 pause（这也是为什么需要共享 prompter）", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // 通过 tty 注入：让 isStdinTTY/isStderrTTY 返回 true，触发交互模式。
    const hook = buildApprovalPrompt({
      tty: { stdin: true, stderr: true },
      input: stdin,
      output: stdout,
      timeoutMs: 2_000,
    });
    // 异步写入模拟用户输入。
    setTimeout(() => {
      stdin.write("y\n");
    }, 30);
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
  });

  it("内部 readline 兜底路径：无输入 timeout 后 deny", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const hook = buildApprovalPrompt({
      tty: { stdin: true, stderr: true },
      input: stdin,
      output: stdout,
      timeoutMs: 60,
    });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
    if (decision.type === "deny") {
      expect(decision.reason).toContain("超时");
    }
  });
});

describe("setInteractivePrompter / getInteractivePrompter", () => {
  afterEach(() => {
    setInteractivePrompter(null);
  });

  it("set/get 一致", () => {
    expect(getInteractivePrompter()).toBeNull();
    const fn: InteractivePrompter = async () => "y";
    setInteractivePrompter(fn);
    expect(getInteractivePrompter()).toBe(fn);
    setInteractivePrompter(null);
    expect(getInteractivePrompter()).toBeNull();
  });
});
