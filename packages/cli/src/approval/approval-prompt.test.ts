/**
 * approval-prompt.ts 单元测试。
 *
 * 覆盖：
 * - 共享 prompter 路径（askViaSharedPrompter）：使用外层 rl 的 question，
 * 不创建内部 readline，避免 pause stdin。
 * - 内部 readline 兜底路径（askYesNo）：用于一次性执行。
 * - 非交互 / 自动批准 / options.ask 覆盖等开关。
 * - [a] / [p] / [s] 路径测试（mock store）
 */
import { describe, expect, it, afterEach, mock } from "bun:test";
import { PassThrough } from "node:stream";
import type { ToolApprovalRequest } from "@tachu/core";
import { buildApprovalPrompt } from "./approval-prompt";
import {
  getInteractivePrompter,
  setInteractivePrompter,
  type InteractivePrompter,
} from "./shared-prompter";
import type { ApprovalStore } from "./approval-store";

const baseRequest: ToolApprovalRequest = {
  tool: "write-file",
  callId: "call-1",
  arguments: { path: "./cat.txt", content: "hi" },
  argumentsPreview: `{"path":"./cat.txt"}`,
  sideEffect: "write",
  requiresApproval: true,
  triggeredBy: "descriptor",
  correlation: {
    traceId: "trace-1",
    requestId: "req-1",
    sessionId: "sess-1",
    turnId: "turn-1",
  },
};

/** 空 store：find 始终返回 null，append 为 no-op。用于隔离真实 ~/.tachu/approvals.jsonl */
const emptyStore = {
  find: async () => null,
  append: async (_r: unknown) => {},
  appendUser: async (_r: unknown) => {},
  list: async () => [],
  revoke: async () => false,
  clear: async () => 0,
  promote: async () => false,
} as unknown as ApprovalStore;

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
    const hook = buildApprovalPrompt({ ask, store: emptyStore });
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
    const hook = buildApprovalPrompt({ store: emptyStore });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(asked).toContain("是否执行");
  });

  it("共享 prompter 路径下非 y/yes/a/p/s 一律拒绝", async () => {
    setInteractivePrompter(async () => "");
    const hook = buildApprovalPrompt({ store: emptyStore });
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
    const hook = buildApprovalPrompt({ store: emptyStore });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
    if (decision.type === "deny") {
      expect(decision.reason).toContain("stdin broken");
    }
  });

  it("共享 prompter 路径不会在 process.stdin 上创建新的 readline", async () => {
    const listenersBefore = process.stdin.listenerCount("data");
    setInteractivePrompter(async () => "y");
    const hook = buildApprovalPrompt({ store: emptyStore });
    await hook(baseRequest);
    const listenersAfter = process.stdin.listenerCount("data");
    expect(listenersAfter).toBe(listenersBefore);
  });

  it("未注册共享 prompter + 非 TTY 时默认拒绝", async () => {
    const hook = buildApprovalPrompt({ tty: { stdin: false, stderr: false }, store: emptyStore });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
  });

  it("未注册共享 prompter + 非 TTY + nonInteractiveDecision=approve 时自动通过", async () => {
    const hook = buildApprovalPrompt({
      tty: { stdin: false, stderr: false },
      nonInteractiveDecision: "approve",
      store: emptyStore,
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
    const hook = buildApprovalPrompt({ respectAutoApproveEnv: true, store: emptyStore });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(called).toBe(false);
  });

  it("内部 readline 兜底路径：输入 y 通过，readline 关闭后 stdin 会被 pause（这也是为什么需要共享 prompter）", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const hook = buildApprovalPrompt({
      tty: { stdin: true, stderr: true },
      input: stdin,
      output: stdout,
      timeoutMs: 2_000,
      store: emptyStore,
    });
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
      store: emptyStore,
    });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");
    if (decision.type === "deny") {
      expect(decision.reason).toContain("超时");
    }
  });

  it("[a] 路径：始终允许，写入 store 并返回 approve", async () => {
    const appendedRecords: unknown[] = [];
    const mockStore = {
      find: async () => null,
      append: async (r: unknown) => { appendedRecords.push(r); },
      appendUser: async (_r: unknown) => {},
      list: async () => [],
      revoke: async () => false,
      clear: async () => 0,
      promote: async () => false,
    } as unknown as ApprovalStore;

    setInteractivePrompter(async () => "a");
    const hook = buildApprovalPrompt({ store: mockStore, currentSessionId: "sess-1" });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(appendedRecords.length).toBe(1);
    const record = appendedRecords[0] as { match: { kind: string }; tool: string };
    expect(record.match.kind).toBe("any");
    expect(record.tool).toBe("write-file");
  });

  it("[p] 路径：允许路径模式，写入 argPattern 记录", async () => {
    const appendedRecords: unknown[] = [];
    const mockStore = {
      find: async () => null,
      append: async (r: unknown) => { appendedRecords.push(r); },
      appendUser: async (_r: unknown) => {},
      list: async () => [],
      revoke: async () => false,
      clear: async () => 0,
      promote: async () => false,
    } as unknown as ApprovalStore;

    setInteractivePrompter(async () => "p");
    const hook = buildApprovalPrompt({ store: mockStore, currentSessionId: "sess-1" });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(appendedRecords.length).toBe(1);
    const record = appendedRecords[0] as { match: { kind: string; field?: string; pattern?: string } };
    expect(record.match.kind).toBe("argPattern");
    expect(record.match.field).toBe("path");
  });

  it("[s] 路径：session 级授权，写入含 sessionId 的记录", async () => {
    const appendedRecords: unknown[] = [];
    const mockStore = {
      find: async () => null,
      append: async (r: unknown) => { appendedRecords.push(r); },
      appendUser: async (_r: unknown) => {},
      list: async () => [],
      revoke: async () => false,
      clear: async () => 0,
      promote: async () => false,
    } as unknown as ApprovalStore;

    setInteractivePrompter(async () => "s");
    const hook = buildApprovalPrompt({ store: mockStore, currentSessionId: "sess-1" });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(appendedRecords.length).toBe(1);
    const record = appendedRecords[0] as { match: { kind: string }; sessionId?: string };
    expect(record.match.kind).toBe("any");
    expect(record.sessionId).toBe("sess-1");
  });

  it("store 命中时直接返回 approve 不弹提示", async () => {
    const storedRecord = {
      id: "existing-id",
      scope: "project" as const,
      tool: "write-file",
      match: { kind: "any" as const },
      createdAt: Date.now(),
    };
    const mockStore = {
      find: async () => storedRecord,
      append: async (_r: unknown) => {},
      appendUser: async (_r: unknown) => {},
      list: async () => [],
      revoke: async () => false,
      clear: async () => 0,
      promote: async () => false,
    } as unknown as ApprovalStore;

    let prompterCalled = false;
    setInteractivePrompter(async () => {
      prompterCalled = true;
      return "n";
    });
    const hook = buildApprovalPrompt({ store: mockStore });
    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");
    expect(prompterCalled).toBe(false);
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
