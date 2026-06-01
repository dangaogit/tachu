import { describe, expect, it } from "bun:test";

import { DefaultToolUseExecutor } from "./executor";
import type { ToolUseContext, ToolUseInput } from "../subflows/tool-use";
import type { ToolUseResult } from "../../types";

const stubResult = (overrides: Partial<ToolUseResult> = {}): ToolUseResult =>
  ({
    kind: "tool-use-result",
    status: "ready_for_output",
    steps: [],
    observations: [],
    terminalDraft: "ok",
    ...overrides,
  }) as ToolUseResult;

describe("DefaultToolUseExecutor", () => {
  it("delegates to injected executeToolUse", async () => {
    let captured: { input: ToolUseInput; ctx: ToolUseContext } | undefined;
    const fakeExecute = async (input: ToolUseInput, ctx: ToolUseContext) => {
      captured = { input, ctx };
      return stubResult({ terminalDraft: "delegated" });
    };
    const executor = new DefaultToolUseExecutor({ execute: fakeExecute });
    const input: ToolUseInput = { prompt: "p" };
    const ctx = { foo: "bar" } as unknown as ToolUseContext;
    const result = await executor.execute(input, ctx);
    expect(result.terminalDraft).toBe("delegated");
    expect(captured?.input).toBe(input);
    expect(captured?.ctx).toBe(ctx);
  });

  it("history-scope invariant: ctx.agentRunId is propagated to executeToolUse unchanged", async () => {
    let observedAgentRunId: string | undefined;
    const fakeExecute = async (_input: ToolUseInput, ctx: ToolUseContext) => {
      observedAgentRunId = ctx.agentRunId;
      return stubResult();
    };
    const executor = new DefaultToolUseExecutor({ execute: fakeExecute });
    const ctx = { agentRunId: "sub-agent-42" } as unknown as ToolUseContext;
    await executor.execute({ prompt: "x" }, ctx);
    expect(observedAgentRunId).toBe("sub-agent-42");
  });

  it("parent and sub-agent invocations are isolated by agentRunId", async () => {
    const seen: string[] = [];
    const fakeExecute = async (_input: ToolUseInput, ctx: ToolUseContext) => {
      seen.push(ctx.agentRunId ?? "<root>");
      return stubResult();
    };
    const executor = new DefaultToolUseExecutor({ execute: fakeExecute });
    await executor.execute({ prompt: "a" }, { } as unknown as ToolUseContext);
    await executor.execute(
      { prompt: "b" },
      { agentRunId: "agent-1" } as unknown as ToolUseContext,
    );
    await executor.execute(
      { prompt: "c" },
      { agentRunId: "agent-2" } as unknown as ToolUseContext,
    );
    expect(seen).toEqual(["<root>", "agent-1", "agent-2"]);
  });
});
