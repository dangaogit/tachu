import {
  executeToolUse as defaultExecuteToolUse,
  type ToolUseContext,
  type ToolUseInput,
} from "../subflows/tool-use";
import type { ToolUseResult } from "../../types";

/**
 * Tool-use 子流程的执行器接口。
 *
 * 抽出该接口的动机：让主 Engine 与 sub-agent runtime 共享同一个多轮 tool-use loop
 * 实现，但通过 `agentRunId` 隔离 history scope，避免父调度的工具历史串到子 agent，
 * 也避免 sub-agent 的工具历史污染父调度（除非 fan-in synthesis 显式包含）。
 *
 * 调用约束：
 * - `ctx.agentRunId` 缺省时执行器视为主调度上下文，沿用 traceId 作为隐式隔离键；
 * - `ctx.agentRunId` 显式提供时，所有 observability/事件出口必须把 agentRunId
 * 当作历史分组键，且不得把记录回写到主调度的 history 桶。
 */
export interface ToolUseExecutor {
  execute(input: ToolUseInput, ctx: ToolUseContext): Promise<ToolUseResult>;
}

export interface DefaultToolUseExecutorOptions {
 /** 注入点：测试用 stub；缺省时使用真正的 `executeToolUse`。 */
  execute?: (input: ToolUseInput, ctx: ToolUseContext) => Promise<ToolUseResult>;
}

/**
 * `ToolUseExecutor` 的默认实现。
 *
 * 当前阶段直接代理到 `executeToolUse`；后续 sub-agent runtime 接入时只需
 * 把同一个实例（或带 agentRunId 工厂）传给两端，即可拿到共享多轮 loop 的能力。
 */
export class DefaultToolUseExecutor implements ToolUseExecutor {
  private readonly executeImpl: (
    input: ToolUseInput,
    ctx: ToolUseContext,
  ) => Promise<ToolUseResult>;

  constructor(options: DefaultToolUseExecutorOptions = {}) {
    this.executeImpl = options.execute ?? defaultExecuteToolUse;
  }

  execute(input: ToolUseInput, ctx: ToolUseContext): Promise<ToolUseResult> {
    return this.executeImpl(input, ctx);
  }
}
