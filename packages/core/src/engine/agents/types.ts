import type { AgentDescriptor, Message, ModelRoute } from "../../types";
import type { EvidenceEntry } from "../../types/evidence";

/**
 * sub-agent 上下文的结构化承载。
 *
 * 替代旧实现把 `task.contextSlice` 整包 `JSON.stringify` 塞进 `previousResults` 的反模式，
 * 让 PromptAssembler / DefaultAgentRuntimeAdapter 可以按字段裁剪、按字段渲染，
 * 同时为后续 PromptAssembler 专用 sub-agent 模板保留可演进的接缝。
 */
export interface AgentStructuredContext {
 /** 父调度发现的额外指令（例如：仅扫描设计文档）。 */
  instructions?: readonly string[] | undefined;
 /** 父调度提取的证据片段（canonical EvidenceEntry[]）。 */
  evidence?: readonly EvidenceEntry[] | undefined;
 /** 父调度希望子 agent 遵守的规则条目（任意结构）。 */
  rules?: readonly unknown[] | undefined;
 /** 父调度认为对子 agent 仍然相关的历史轮次。 */
  priorTurns?: readonly Message[] | undefined;
}

export interface AgentInvocation {
  id: string;
  agent: AgentDescriptor;
  objective: string;
  input: Record<string, unknown>;
  context: AgentContextEnvelope;
  constraints: AgentRunConstraints;
}

export interface AgentContextEnvelope {
  scope: "sub-agent";
  parentTraceId: string;
  inherited: {
    rules?: boolean | undefined;
    skills?: boolean | undefined;
    tools?: string[] | undefined;
    memory?: "none" | "summaries" | "task-relevant" | undefined;
 /**
 * @deprecated 保留作向后兼容。新代码应填充 `structured` 字段，
 * runtime 会优先按结构化字段渲染；当两者并存时 `previousResults` 仅作 fallback。
 */
    previousResults?: string[] | undefined;
 /** 结构化上下文承载，替代字符串大杂烩。 */
    structured?: AgentStructuredContext | undefined;
  };
  budget: {
    maxInputTokens: number;
    maxWorkingTokens: number;
    maxOutputTokens: number;
  };
}

export interface AgentRunConstraints {
  maxDepth: number;
  timeoutMs: number;
  allowedTools: string[];
 /**
 * 当前调用深度。Main Engine 派发首层 sub-agent 时 `currentDepth=1`；
 * sub-agent 若日后支持嵌套派发，需在派发链路上累加。runtime 在 `currentDepth > maxDepth`
 * 时直接 fail-closed，避免出现深度漂移导致的失控嵌套。
 */
  currentDepth?: number | undefined;
}

export interface AgentRunError {
  code: string;
  message: string;
  retryable: boolean;
}

export type AgentRunResult =
  | {
      status: "completed";
      output: unknown;
      evidence?: EvidenceEntry[] | undefined;
      usage?: unknown | undefined;
    }
  | {
      status: "failed";
      error: AgentRunError;
      partialOutput?: unknown | undefined;
    }
  | {
      status: "cancelled";
      reason: string;
      partialOutput?: unknown | undefined;
    };

export interface AgentRuntimeAdapter {
  run(
    invocation: AgentInvocation,
    executionContext: import("../../types").ExecutionContext,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}

/**
 * loop 内 LLM 自决派发 sub-agent 的入参(ADR-0006 D6:内置 Task-style 工具)。
 *
 * 与 {@link AgentInvocation} 的区别:后者是 runtime 内部已装配好 context/budget/
 * constraints 的完整调用信封;本类型是**工具调用参数**这一薄外层，由
 * `Engine.runSubAgent` 负责补全 envelope 后再转交 runtime。
 */
export interface AgentDispatchParams {
  agentName: string;
  objective: string;
  input?: Record<string, unknown> | undefined;
}

/** {@link AgentRunResult} 附加 `agent` 名称，便于工具调用侧序列化时无需闭包捕获。 */
export type AgentDispatchOutcome = AgentRunResult & { agent: string };

/**
 * `dispatch_agent` 内置工具的执行入口签名。
 *
 * 由 Engine 侧注入进 `ToolUseContext`/`InternalSubflowContext`；闭包内部携带
 * registry / router / agent runtime 等 tool-use 子流程本身拿不到的依赖，并按
 * 派发深度(`agentDispatchDepth`)与 `runtime.toolLoop.subagentDispatch.maxDepth`
 * 做 fail-closed 校验。
 */
export type AgentDispatchFn = (
  params: AgentDispatchParams,
  signal: AbortSignal,
) => Promise<AgentDispatchOutcome>;

/**
 * `runtime.toolLoop.subagentDispatch.maxDepth` 未配置时的默认值(ADR-0006 D6)。
 *
 * 唯一权威定义，由 `Engine.resolveAgentDispatchMaxDepth`(深度闸门写入
 * `AgentRunConstraints.maxDepth`)与 `tool-use.ts` 的 `resolveAgentDispatchMaxDepth`
 * (决定是否在工具列表暴露 `dispatch_agent`)共同引用，避免同一语义值在两处漂移。
 */
export const DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH = 1;

export interface AgentRuntimeOptions {
  providers: Map<string, import("../../modules/provider").ProviderAdapter>;
  route: ModelRoute;
  adapterContext: import("../../types/context").AdapterCallContext;
 /**
 * Shared multi-turn tool-use executor。
 *
 * 主 Engine 与 sub-agent runtime 共享同一个 `ToolUseExecutor` 实例，
 * 通过 `ctx.agentRunId` 隔离 history scope。注入后 sub-agent 可以跑多轮
 * tool-use；未注入时 runtime 退化为单轮 LLM call（向后兼容）。
 */
  toolUseExecutor?: import("../tool-use").ToolUseExecutor | undefined;
 /**
 * Sub-agent 调度时构造 `ToolUseContext` 的工厂。
 *
 * 由 Engine 侧注入：闭包内部携带 modelRouter / memorySystem / observability /
 * registry / taskExecutor / prebuiltPrompt 等 runtime 自身拿不到的依赖。
 * 工厂必须把 `agentRunId = invocation.id` 写进返回的 ctx，保证 history scope
 * 与父调度严格隔离。
 *
 * 当且仅当 `toolUseExecutor` 与该工厂同时注入时启用多轮 tool-use；否则退化
 * 到单轮 LLM call。
 */
  toolUseContextFactory?:
    | ((
        invocation: AgentInvocation,
        signal: AbortSignal,
        executionContext: import("../../types").ExecutionContext,
      ) => import("../subflows/tool-use").ToolUseContext)
    | undefined;
}
