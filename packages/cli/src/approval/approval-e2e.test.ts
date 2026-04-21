/**
 * 审批与主循环的集成回归测试。
 *
 * 模拟 `tachu chat` 的真实交互流：
 *   1. 主 `readline` 处理第一行用户输入；
 *   2. 引擎在执行过程中触发工具审批回调；
 *   3. 用户在审批提示中敲 `y`（或 `n`）；
 *   4. 主 `readline` 继续接收后续用户输入。
 *
 * 这条链路曾经会卡死 —— 因为 `askYesNo` 在内部 `createInterface`/`close()`，
 * Node 的 `Interface.close()` 会 pause `process.stdin`，导致主循环的 `rl.question`
 * 永远读不到后续行。本测试使用 `setInteractivePrompter` + 复用外层 rl 的方案，
 * 直接走 `askViaSharedPrompter` 分支，保证 stdin 全程只有一个读者。
 */
import { describe, expect, it, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import * as rlp from "node:readline/promises";
import { buildApprovalPrompt } from "./approval-prompt";
import { setInteractivePrompter } from "./shared-prompter";
import type { ToolApprovalRequest } from "@tachu/core";

const baseRequest: ToolApprovalRequest = {
  tool: "write-file",
  callId: "call-1",
  arguments: { path: "./cat.txt" },
  argumentsPreview: `{"path":"./cat.txt"}`,
  sideEffect: "write",
  requiresApproval: true,
  triggeredBy: "descriptor",
  traceId: "t",
  sessionId: "s",
};

afterEach(() => {
  setInteractivePrompter(null);
});

describe("approval × 主循环 readline 集成", () => {
  it("主循环先读一行 → 审批 y → 继续读下一行（共享 prompter 路径）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();

    // 模拟主循环 readline
    const rl = rlp.createInterface({
      input: input as unknown as NodeJS.ReadableStream,
      output: output as unknown as NodeJS.WritableStream,
      terminal: false,
    });
    setInteractivePrompter((q) => rl.question(q));

    const hook = buildApprovalPrompt({ output: stderr });

    // 模拟用户输入序列：第 1 行 you>、审批 y、第 2 行 you>
    setTimeout(() => input.write("write cat ascii\n"), 10);
    setTimeout(() => input.write("y\n"), 40);
    setTimeout(() => input.write("thanks\n"), 70);

    const first = await rl.question("you> ");
    expect(first).toBe("write cat ascii");

    const decision = await hook(baseRequest);
    expect(decision.type).toBe("approve");

    const second = await rl.question("you> ");
    expect(second).toBe("thanks");

    rl.close();
  });

  it("审批 n 后主循环仍能继续读取（共享 prompter 不会污染 stdin）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();

    const rl = rlp.createInterface({
      input: input as unknown as NodeJS.ReadableStream,
      output: output as unknown as NodeJS.WritableStream,
      terminal: false,
    });
    setInteractivePrompter((q) => rl.question(q));

    const hook = buildApprovalPrompt({ output: stderr });

    setTimeout(() => input.write("do dangerous thing\n"), 10);
    setTimeout(() => input.write("n\n"), 40);
    setTimeout(() => input.write("ok let's move on\n"), 70);

    const first = await rl.question("you> ");
    expect(first).toBe("do dangerous thing");

    const decision = await hook(baseRequest);
    expect(decision.type).toBe("deny");

    const second = await rl.question("you> ");
    expect(second).toBe("ok let's move on");

    rl.close();
  });

  it("输入流未被暂停：共享 prompter 路径期间 pause 状态保持不变", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();

    const rl = rlp.createInterface({
      input: input as unknown as NodeJS.ReadableStream,
      output: output as unknown as NodeJS.WritableStream,
      terminal: false,
    });
    setInteractivePrompter((q) => rl.question(q));

    const hook = buildApprovalPrompt({ output: stderr });

    setTimeout(() => input.write("hi\n"), 10);
    setTimeout(() => input.write("y\n"), 40);

    await rl.question("you> ");
    await hook(baseRequest);

    // 关键断言：input 并没有因审批过程被 pause。
    expect(input.isPaused()).toBe(false);
    rl.close();
  });
});
