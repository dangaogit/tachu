import { EngineError, HostError, ToolLoopError } from "../../errors";
import { resolveSystemPromptBase } from "../../utils/system-prompt-base";
import type {
  ChatFinishReason,
  ChatStreamChunk,
  ChatUsage,
  ProviderAdapter,
} from "../../modules/provider";
import type { ModelRouter } from "../../modules/model-router";
import { memoryEntryToMessage, type MemorySystem, type MemoryEntry } from "../../modules/memory";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { SessionManager } from "../../modules/session";
import type { Registry } from "../../registry";
import type { StickyManager } from "../skill-activation/sticky";
import {
  executeInternalTool,
  isInternalToolName,
  mergeInternalToolDefinitions,
  type InternalToolContext,
} from "./internal-tools";
import type { AssembledPrompt } from "../../prompt/assembler";
import { stripTrailingCurrentTurn } from "../../prompt/turn-tail";
import type {
  EngineConfig,
  ExecutionContext,
  Message,
  StreamChunk,
  TaskNode,
  ToolCallRecord,
  ToolCallRequest,
  ToolDefinition,
  ToolDescriptor,
  ToolUseObservation,
  ToolUseResult,
  ToolUseResultStep,
  ToolUseResultToolCall,
} from "../../types";
import type { TurnPolicy } from "../../types/turn-policy";
import type { AdapterCallContext, ExecutionCorrelation, ExecutionSubject } from "../../types/context";
import type { TaskExecutor } from "../scheduler";
import {
  buildLlmCallAbortSignal,
  createLlmStreamAbortController,
  isBudgetTimeoutAbort,
  resolveLlmTimeouts,
} from "../llm-timeouts";
import {
  createLlmUsageTracker,
  estimateMessagesTokens,
  type EmitLlmUsageTelemetry,
  type LlmUsageTracker,
} from "../llm-usage-telemetry";
import { engineEventFromContext, withStreamEnvelope } from "../turn-outcome";
import {
  chatWithResolvedMessages,
  streamChatWithResolvedMessages,
  resolveProviderDemand,
  emitResourceDegradations,
  type ResourceDemandRouter,
} from "../resolve-provider-messages";

/**
 * `tool-use` 内置 Sub-flow 运行时上下文（
 *
 * 与 `DirectAnswerContext` 的差异：
 * - 需要 `registry` 做 `ToolCallRequest.name → ToolDescriptor` 映射与白名单校验
 * - 需要 `taskExecutor` 真正执行工具（复用主干 TaskExecutor，统一安全闸门与审批）
 * - 需要 `executionContext` 以便在执行工具时把预算/权限/trace 信息透传下去
 * - 新增 `onToolLoopEvent` 回调：把 loop-step / tool-call-start / tool-call-end 事件
 * 实时推给主干 `runStream`；未注入时等价于 no-op
 * - 新增 `onToolCall` 回调：把 `ToolCallRecord` 汇回主干 metadata / orchestrator
 * - `prebuiltPrompt` 在此为**必填**：tools 列表与 messages 都来自它
 */
export interface ToolUseContext {
  config: EngineConfig;
  providers: Map<string, ProviderAdapter>;
  modelRouter: ModelRouter;
  memorySystem: MemorySystem;
  observability: ObservabilityEmitter;
  registry: Registry;
  taskExecutor: TaskExecutor;
  executionContext: ExecutionContext;
  signal: AbortSignal;
  adapterContext: AdapterCallContext;
  multimodalResolver?: import("../../types/multimodal-resolver").MultimodalResolver;
 /** Host 注入的 token 级需求路由；缺省全保真。 */
  resourceDemandRouter?: ResourceDemandRouter | undefined;
  prebuiltPrompt: AssembledPrompt;
  onProviderUsage?: (usage: ChatUsage) => void;
  emitUsageTelemetry?: EmitLlmUsageTelemetry | undefined;
  currentPhaseStepId?: string | undefined;
  nextStreamId?: (() => string) | undefined;
 /**
 * 模型 reasoning_content 透传回调。
 *
 * 非流式 `adapter.chat()` 会在每个 loop step 拿到 `response.reasoningContent`
 * 时一次性调用；流式 `adapter.chatStream()` 会随 `reasoning-delta` 增量调用。
 *
 * 与 `onAssistantDelta` 严格分离：reasoning 不进 `content`、不参与下一轮
 * 上下文回灌。
 */
  onAssistantReasoningDelta?: (text: string) => void;
  onToolLoopEvent?: (chunk: StreamChunk) => void;
  onToolCall?: (record: ToolCallRecord) => void;
  onToolLoopActiveStart?: () => void;
  onToolLoopActiveEnd?: () => void;
  onUserBlockingStart?: () => void;
  onUserBlockingEnd?: () => void;
 /**
 * 工具执行前的审批回调（ Stage 4）。
 *
 * 触发条件（二者满足其一）：
 * 1. 工具描述符 `requiresApproval === true`
 * 2. `config.runtime.toolLoop.requireApprovalGlobal === true`
 *
 * 返回 `"approve"` 继续执行；返回 `"deny"` 时跳过真实调用，合成一条
 * `tool` 角色消息（"用户拒绝"）追加进对话，让 LLM 感知到拒绝结果并据此
 * 给出替代方案。拒绝不计入 ToolLoopError，也不中止整条 loop。
 *
 * 未注入（undefined）时一律视作 `"approve"`，兼容旧宿主。
 */
  onBeforeToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  sessionManager?: SessionManager;
  stickyManager?: StickyManager;
  searchSkills?: InternalToolContext["searchSkills"];
 /**
 * 当前 turn 的 retry 计数（来源于 orchestrator turn-level retry loop）。
 *
 * 此前 `retryCount` 在 step-end / final 事件中硬编码为 0，
 * 阻断了 host adapter 的退避策略。当前 orchestrator 尚未实现 turn-level
 * 重试循环（详见 注），故默认仍为 0；但字段已沿 ctx 贯通，
 * 一旦上层 retry loop 落地，只需在 ctx 注入处递增即可生效，无需再改 tool-use。
 */
  turnRetryCount?: number;
 /**
 * Sub-agent 调度的 history-scope 键。
 *
 * 主 Engine 调用 tool-use 时为 undefined（隐式以 traceId 隔离）；
 * sub-agent runtime 调用 tool-use 时必须填入派发的 agentRunId，
 * observability / 事件出口据此把 step/tool_call/loop 事件与父调度区分开来，
 * 同时确保 sub-agent 的 tool history 不串到父调度的 history 桶。
 */
  agentRunId?: string | undefined;
 /** Normalized turn policy for soft tail constraints. */
  turnPolicy?: TurnPolicy;
}

/**
 * 发给 `onBeforeToolCall` 的审批请求上下文（ Stage 4）。
 */
export interface ToolApprovalRequest {
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
  argumentsPreview: string;
  sideEffect: "readonly" | "write" | "irreversible";
  requiresApproval: boolean;
  triggeredBy: "descriptor" | "global";
  correlation: ExecutionCorrelation;
  subject?: ExecutionSubject | undefined;
}

/**
 * 审批决策。`"deny"` 支持可选 `reason`，会写进合成的 tool 消息。
 */
export type ToolApprovalDecision =
  | { type: "approve" }
  | { type: "deny"; reason?: string };

/**
 * `tool-use` Sub-flow 的调用输入。
 *
 * - `prompt`：必填，来自 Phase 3 Intent summary 或原始输入（兜底）
 * - `hint`：可选的宿主附加指令
 */
export interface ToolUseInput {
  prompt: string;
  toolNames?: string[];
  hint?: string;
}

/**
 * 单次 Agentic Loop 调用 LLM 的超时（毫秒）。
 *
 * 宽于 direct-answer 的 60s，并与 OpenAI/Anthropic Provider 默认请求超时（120s）
 * 对齐，避免模型在 tool 规划阶段被 Provider 层先行掐断。实际生效还受
 * `ctx.executionContext.budget.maxWallTimeMs` 约束。
 */
const TOOL_USE_TOOL_TIMEOUT_MS = 60_000;

/**
 * `tool-use` 默认 System Prompt。
 *
 * 写入要点：
 * 1. 明确循环语义：先给计划 → 调用工具 → 基于工具输出继续 → 给出最终自然语言回复
 * 2. 强调 **最终回复必须是自然语言 + Markdown**，不能是 JSON 或工具调用壳
 * 3. 强调工具失败时要自行修复或降级，不要反复请求同一失败工具
 */
const TOOL_USE_SYSTEM_PROMPT_BASE = `You are the agentic tool-loop sub-flow of the Tachu engine (built-in sub-flow: tool-use).

### How to work
- You may call the provided tools across multiple turns via function calling. After each call, the system returns the real tool output to you as a \`tool\` role message.
- When you have enough information, stop calling tools and produce a natural-language Markdown reply. The final reply MUST NOT carry any tool calls — text only.

### Final reply format
- Natural language + Markdown; no JSON envelope, no "Identified request: xxx" template.
- All code MUST use fenced code blocks with a language tag (\`\`\`python / \`\`\`ts / \`\`\`bash / \`\`\`sql / \`\`\`json …).
- Headings (#, ##), bold, lists, links, tables are allowed.

### Tool-call principles
- Prefer the tool that most closely fits the task; arguments must be concrete.
- A single turn may request multiple tools, but avoid pointless repeats (e.g. listing the same directory twice).
- When several tools run in parallel, completion order can differ from start order or from log line order; that is normal. Prefer fewer parallel calls when one result is enough.
- On tool error: fix the arguments and retry once, switch to a different tool, or honestly state the failure based on what you already know. Do not retry indefinitely.

### Termination
- The system caps the number of loop steps; exceeding it raises an error. Stop calling tools as soon as you are ready to answer.

Respond in the same language as the latest user message; default to English when ambiguous.`;

/**
 * 动态构建 tool-use system prompt。
 *
 * 若 config 注入了业务补充指令（`config.toolUse.systemPromptSuffix`），追加在 core prompt 之后。
 * 典型用途：编码 Agent 的 workflow 指南（"改前先读 / 改后 typecheck"），不污染 core。
 */
const buildToolUseSystemPrompt = (config: import("../../types").EngineConfig): string => {
  const base = resolveSystemPromptBase(
    config.toolUse?.systemPromptBase,
    TOOL_USE_SYSTEM_PROMPT_BASE,
  );
  const suffix = config.toolUse?.systemPromptSuffix;
  if (!suffix || suffix.trim().length === 0) return base;
  return `${base}\n\n${suffix.trim()}`;
};

/**
 * `tool-use` Sub-flow 对话历史中最多保留的近 N 条历史。
 *
 * Prebuilt prompt 已经包含本轮必需的消息；这里多保留一层做兜底（仅在
 * `prebuiltPrompt.messages` 为空的异常路径上使用）。
 */
const TOOL_USE_HISTORY_LIMIT = 10;

/**
 * 组合外部 abort 与 LLM 超时的复合 Signal。
 */
const buildToolExecutionSignal = (outer: AbortSignal, timeoutMs: number): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool invocation timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuterAbort);
    },
    { once: true },
  );
  return controller.signal;
};

/**
 * 解析 `tool-use` 使用的能力路由。
 *
 * 默认链路：`high-reasoning` → `intent` → `fast-cheap`（Agentic Loop 里 LLM 需要
 * 推理是否继续调工具、选什么工具、参数怎么写，归类为推理密集型）。
 *
 * 当 `runtime.toolLoop.shortTaskRoute.enabled` 为 true 且本次输入命中"短任务"
 * 阈值（toolNames 数 ≤ maxToolNames 且 prompt 长度 ≤ maxPromptChars）时，
 * 优先尝试配置中指定的 `capability`（典型为 `fast-cheap`），命中失败再回退到
 * 默认链路。这样可以把"单工具调用 + 简短结果总结"的场景从 gpt-4o 降到
 * gpt-4o-mini，wall time 通常能从 5-6s 缩到 1-2s。
 */
const resolveToolUseRoute = (
  input: ToolUseInput,
  ctx: ToolUseContext,
): { provider: string; model: string } => {
  const router = ctx.modelRouter;
  const shortRoute = ctx.config.runtime.toolLoop?.shortTaskRoute;
  if (
    shortRoute?.enabled === true &&
    Array.isArray(input.toolNames) &&
    input.toolNames.length > 0 &&
    input.toolNames.length <= (shortRoute.maxToolNames ?? 1) &&
    input.prompt.length <= (shortRoute.maxPromptChars ?? 120)
  ) {
    try {
      return router.resolve(shortRoute.capability ?? "fast-cheap");
    } catch {
 // 配置的 capability 未在 capabilityMapping 中注册时静默回退到默认链路；
 // observability 不在此处再 emit，是因为下面 default 链路命中后整体不算异常路径。
    }
  }
  try {
    return router.resolve("high-reasoning");
  } catch {
    try {
      return router.resolve("intent");
    } catch {
      return router.resolve("fast-cheap");
    }
  }
};

const buildTurnPolicyTailNote = (policy: TurnPolicy | undefined): string | null => {
  if (!policy) return null;
  const active =
    policy.excludeTools.length > 0 ||
    policy.includeTools.length > 0 ||
    policy.explicitSkills.length > 0 ||
    policy.excludeSkills.length > 0 ||
    policy.pinSkills.length > 0 ||
    policy.visualization.length > 0;
  if (!active) return null;
  const visualization = policy.visualization.length > 0 ? policy.visualization : "none";
  return `Turn policy: visualization=${visualization}. Excluded tools must not be called. Pinned skills define output format for the final answer.`;
};

const appendTurnPolicyTail = (messages: Message[], policy: TurnPolicy | undefined): Message[] => {
  const note = buildTurnPolicyTailNote(policy);
  if (!note) return messages;
  return [...messages, { role: "system", content: note }];
};

/**
 * 从 `prebuiltPrompt.messages` 出发，补齐 `tool-use` 的 System 指令。
 *
 * 如果 prebuilt 已经包含一条 system，则把 tool-use 的指令追加为第二条 system（让
 * 引擎组装的总 system 指令保持在最前，子流程的补充放在后面）；否则直接作为第一条。
 */
const buildInitialMessages = (
  input: ToolUseInput,
  ctx: ToolUseContext,
): Message[] => {
  if (input.toolNames && input.toolNames.length > 0) {
 // 多模态资源经旁路 Resource Pool 承载，挂在 prebuilt 的 user 消息上。
 // 精简分支默认只用 `input.prompt`（意图摘要），会丢掉资源池 → seam 无 token∩pool 可
 // 物化、图片永远到不了模型。故当 prebuilt 携带资源时，改用这些带 token+pool 的消息，
 // 保证 Provider 边界能按需物化；纯文本轮（无资源）维持原精简行为不变。
    const resourceCarryingMessages = ctx.prebuiltPrompt.messages.filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.resources !== undefined &&
        m.resources.length > 0,
    );
    const userMessages: Message[] =
      resourceCarryingMessages.length > 0
        ? resourceCarryingMessages.map((m) => ({ ...m }))
        : [{ role: "user", content: input.prompt }];
    const messages: Message[] = [
      { role: "system", content: buildToolUseSystemPrompt(ctx.config)},
      ...userMessages,
    ];
    if (input.hint && input.hint.length > 0) {
      messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
    }
    return appendTurnPolicyTail(messages, ctx.turnPolicy);
  }
  const base = ctx.prebuiltPrompt.messages.map((m) => ({ ...m }));
  const hasSystem = base.some((m) => m.role === "system");
  const messages: Message[] = hasSystem
    ? [
        ...base.filter((m) => m.role === "system"),
        { role: "system", content: buildToolUseSystemPrompt(ctx.config)},
        ...base.filter((m) => m.role !== "system"),
      ]
    : [{ role: "system", content: buildToolUseSystemPrompt(ctx.config)}, ...base];
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
  }
  return appendTurnPolicyTail(messages, ctx.turnPolicy);
};

/**
 * 当 `prebuiltPrompt.messages` 为空（极端路径：assembler 异常）时的兜底组装。
 */
const buildFallbackMessages = async (
  input: ToolUseInput,
  ctx: ToolUseContext,
): Promise<Message[]> => {
  const messages: Message[] = [{ role: "system", content: buildToolUseSystemPrompt(ctx.config)}];
 // history-scope 隔离：sub-agent 调度（ctx.agentRunId 非空）严禁
 // 加载父 session 的 memory，否则 sub-agent 会"看到"主调度的工具历史，违反隔离不变量。
 // 主 Engine 调用 tool-use 时 agentRunId 为 undefined，保留原 fallback 行为不变。
  if (ctx.agentRunId === undefined) {
    try {
      const window = await ctx.memorySystem.load(
        ctx.executionContext.correlation.sessionId,
        ctx.adapterContext,
      );
      const history = window.entries
        .map(memoryEntryToMessage)
        .filter((m): m is Message => m !== null)
        .filter((m) => m.role !== "system")
        .slice(-TOOL_USE_HISTORY_LIMIT);
 // Session 阶段已把本轮 user 写入 memory，剥尾避免双发。语义见 prompt/turn-tail.ts。
      const trimmed = stripTrailingCurrentTurn(history, input.prompt);
      for (const m of trimmed) messages.push(m);
    } catch {
 // Memory 读取失败不阻塞；历史只是锦上添花。
    }
  }
  messages.push({ role: "user", content: input.prompt });
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
  }
  return appendTurnPolicyTail(messages, ctx.turnPolicy);
};

/**
 * Shell 自动审批正则缓存。
 *
 * 把 `safety.shellAutoApprovePatterns` 里的正则源串编译为 RegExp，按数组身份缓存。
 * 同一份配置在多次 `executeSingleToolCall` 调用之间共享同一组编译后正则，避免每次
 * 重新 compile。`validateEngineConfig` 已经保证源串合法，这里再失败一次直接抛错。
 */
const shellAutoApproveRegexCache = new WeakMap<readonly string[], RegExp[]>();

const compileShellAutoApprovePatterns = (
  patterns: readonly string[] | undefined,
): RegExp[] => {
  if (!patterns || patterns.length === 0) return [];
  const cached = shellAutoApproveRegexCache.get(patterns);
  if (cached) return cached;
  const compiled = patterns.map((source) => new RegExp(source));
  shellAutoApproveRegexCache.set(patterns, compiled);
  return compiled;
};

/**
 * 判断本次 `run-shell` 调用是否命中 `safety.shellAutoApprovePatterns` 自动审批白名单。
 *
 * 命中条件（全部满足）：
 * 1. 工具名为 `run-shell`
 * 2. `arguments.command` 字符串命中任一已编译正则
 * 3. `arguments.args` 字段为空（数组未提供或长度为 0）—— 一旦带 args，潜在风险面扩大，
 * 为安全起见仍走人工审批
 *
 * 未配置 patterns（默认）→ 永远 false，保持向后兼容。
 */
const isShellAutoApproved = (
  call: ToolCallRequest,
  config: EngineConfig,
): boolean => {
  if (call.name !== "run-shell") return false;
  const patterns = config.safety.shellAutoApprovePatterns;
  if (!patterns || patterns.length === 0) return false;
  const args = call.arguments as { command?: unknown; args?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command.length === 0) return false;
  if (Array.isArray(args.args) && args.args.length > 0) return false;
  const regexes = compileShellAutoApprovePatterns(patterns);
 return regexes.some((re) => re.test(command));
};

/**
 * 工具参数预览（截断）——用于事件里把超长 JSON 裁剪成可显示的短摘要。
 */
const previewArguments = (args: Record<string, unknown>): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = "[unserializable arguments]";
  }
  if (serialized.length <= 160) return serialized;
  return `${serialized.slice(0, 157)}...`;
};

/**
 * 单次 tool 输出拼回对话时允许的最大字符数（纵深防御）。
 *
 * 动机：任何工具都可能返回一段超长字符串（原始 HTML、巨大 JSON、二进制被意外 stringify 等），
 * 整段塞进下一轮 `chat` 会把 Provider context 吹爆或触发 400。工具自身也应有裁剪逻辑，但在
 * 对话拼装这一层再加一道兜底，可以保证即使新增工具忘了做限长，也不会把 Agentic Loop 打坏。
 *
 * 16KB 字符 ≈ 4k~5k tokens，对绝大多数工具的"单步输出"都足够；上游真正的长文处理建议
 * 走带摘要/分片能力的专用工具（例如未来的 `fetch-url → summarize-page`）。
 */
const MAX_TOOL_OUTPUT_CHARS = 16 * 1024;

/**
 * 按字符数截断工具输出，并在末尾追加明确的截断提示。
 *
 * 截断提示同时给出"完整长度"，让 LLM 判断是否有必要换个更窄的工具重新请求（例如
 * `fetch-url` 之后再调一个支持 `offset` 的工具）。
 */
const clipToolOutputForLlm = (text: string, toolName?: string): string => {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  const hint = toolName === "read-file"
    ? `\n\n... [输出已截断，完整长度 ${text.length} 字符。使用 read-file 并携带 offset/limit 参数读取后续内容]`
    : `\n\n... [输出已截断，完整长度 ${text.length} 字符。如需完整内容，请缩小请求范围或分段读取]`;
  return head + hint;
};

/**
 * 把工具执行结果序列化为 `tool` role message 的 content 字符串。
 *
 * - string → 直接使用
 * - object / array → JSON.stringify（两空格缩进提升 LLM 可读性）
 * - 其它（Buffer / undefined / 异常）→ String(output)
 *
 * 所有分支统一经过 {@link clipToolOutputForLlm} 的字符上限兜底。
 */
const serializeToolOutput = (output: unknown, toolName?: string): string => {
  let raw: string;
  if (typeof output === "string") {
    raw = output;
  } else if (output === undefined || output === null) {
    raw = "";
  } else {
    try {
      raw = JSON.stringify(output, null, 2);
    } catch {
      raw = String(output);
    }
  }
  return clipToolOutputForLlm(raw, toolName);
};

interface ExecutedToolRecord {
  call: ToolCallRequest;
  content: string;
  output?: unknown;
  success: boolean;
  durationMs: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

const previewToolOutput = (content: string): string | undefined => {
  const text = content.trim();
  if (text.length === 0) return undefined;
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
};

const errorToToolUseResultError = (
  error: unknown,
  fallbackCode: string,
): NonNullable<ToolUseResult["error"]> => {
  if (error instanceof EngineError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? error as Record<string, unknown>
      : undefined;
  return {
    code: typeof record?.code === "string" ? record.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: typeof record?.retryable === "boolean" ? record.retryable : false,
  };
};

const toResultToolCall = (item: ExecutedToolRecord): ToolUseResultToolCall => ({
  callId: item.call.id,
  tool: item.call.name,
  arguments: item.call.arguments,
  ok: item.success,
  durationMs: item.durationMs,
  ...(item.output !== undefined ? { output: item.output } : {}),
  ...(previewToolOutput(item.content) !== undefined
    ? { outputPreview: previewToolOutput(item.content) }
    : {}),
  ...(item.success === false
    ? {
        error: item.error ?? {
          code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
          message: item.content,
          retryable: false,
        },
      }
    : {}),
});

const toObservation = (item: ExecutedToolRecord): ToolUseObservation => ({
  source: "tool",
  tool: item.call.name,
  callId: item.call.id,
  text: item.content,
});

/**
 * 执行单个工具调用。
 *
 * 语义：
 * 1. 在 `registry` 中查 `call.name`，缺失 → 返回合成的 error content（让 LLM 自行修复）
 * 2. 构造 `TaskNode` 交给 `taskExecutor` 执行；签名与主干 TaskScheduler 使用相同
 * 3. 记录耗时与成功/失败；无论成功失败都会 emit tool-call-end 事件与 ToolCallRecord
 *
 * 不在本函数内做重试：重试策略由 LLM 自身掌握（它可以基于 error content 重新发起请求）。
 *
 * 协议：一旦成功发出 `tool-call-start`，本函数保证在返回前至多发出一次对偶的
 * `tool-call-end`（含宿主回调抛错、或 await 链异常中断等路径）。
 */
const executeSingleToolCall = async (
  call: ToolCallRequest,
  ctx: ToolUseContext,
  parentStepId: string,
): Promise<ExecutedToolRecord> => {
  let toolCallStartDelivered = false;
  let toolCallEndDelivered = false;
  const emitToolCallEnd = (payload: {
    success: boolean;
    durationMs: number;
    output?: unknown;
    error?: {
      code: string;
      message: string;
      retryable: boolean;
    };
  }): void => {
    if (toolCallEndDelivered) {
      return;
    }
    ctx.onToolLoopEvent?.(
      withStreamEnvelope(
        {
          type: "tool-call-end",
          callId: call.id,
          tool: call.name,
          parentStepId,
          success: payload.success,
          durationMs: payload.durationMs,
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          ...(!payload.success
            ? {
                error: payload.error ?? {
                  code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
                  message: "Tool call failed",
                  retryable: false,
                },
              }
            : {}),
        },
        ctx.executionContext,
      ),
    );
    toolCallEndDelivered = true;
  };

  const mark = Date.now();
  try {
    const descriptor = ctx.registry.get("tool", call.name);
    try {
      ctx.onToolLoopEvent?.(
        withStreamEnvelope(
          {
            type: "tool-call-start",
            callId: call.id,
            tool: call.name,
            parentStepId,
            argumentsPreview: previewArguments(call.arguments),
          },
          ctx.executionContext,
        ),
      );
    } catch (err) {
      emitToolCallEnd({
        success: false,
        durationMs: Math.max(0, Date.now() - mark),
        error: {
          code: "TOOL_LOOP_ABANDONED",
          message: "工具调用在 tool-call-start 事件投递时因宿主回调异常中断。",
          retryable: false,
        },
      });
      throw err;
    }
    toolCallStartDelivered = true;

    const startedAt = Date.now();

    const isInternalCall =
      isInternalToolName(call.name) || call.name === "search_skills";

    if (isInternalCall) {
      if (!ctx.sessionManager || !ctx.stickyManager) {
        const message = `内置工具 "${call.name}" 需要 sessionManager 与 stickyManager，但主干未注入。`;
        const durationMs = Date.now() - startedAt;
        emitToolCallEnd({
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_INTERNAL_TOOL_MISCONFIG",
            message,
            retryable: false,
          },
        });
        return {
          call,
          content: message,
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_INTERNAL_TOOL_MISCONFIG",
            message,
            retryable: false,
          },
        };
      }
      try {
        const output = await executeInternalTool(
          call.name as "load_skill" | "read_skill_resource" | "search_skills",
          call.arguments,
          {
          registry: ctx.registry,
          sessionManager: ctx.sessionManager,
          stickyManager: ctx.stickyManager,
          observability: ctx.observability,
          adapterContext: ctx.adapterContext,
          ...(ctx.searchSkills !== undefined ? { searchSkills: ctx.searchSkills } : {}),
        });
        const durationMs = Date.now() - startedAt;
        const content = serializeToolOutput(output, call.name);
        emitToolCallEnd({ success: true, durationMs, output });
        ctx.onToolCall?.({
          callId: call.id,
          tool: call.name,
          parentStepId,
          durationMs,
          success: true,
          source: "tool",
        });
        return { call, content, output, success: true, durationMs };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        emitToolCallEnd({
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
            message,
            retryable: false,
          },
        });
        return {
          call,
          content: `内置工具执行失败："${message}"`,
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
            message,
            retryable: false,
          },
        };
      }
    }

    if (!descriptor) {
      const message = `工具 "${call.name}" 未在 registry 中注册，无法执行。请换一个已注册的工具或直接回答。`;
      const durationMs = Date.now() - startedAt;
      emitToolCallEnd({
        success: false,
        durationMs,
        error: {
          code: "TOOL_LOOP_UNKNOWN_TOOL",
          message,
          retryable: false,
        },
      });
      ctx.onToolCall?.({
        callId: call.id,
        tool: call.name,
        parentStepId,
        durationMs,
        success: false,
        source: "tool",
        error: {
          code: "TOOL_LOOP_UNKNOWN_TOOL",
          message,
          retryable: false,
        },
      });
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "warning",
          payload: {
            reason: "unknown-tool",
            tool: call.name,
            callId: call.id,
          },
        }),
      );
      return {
        call,
        content: message,
        success: false,
        durationMs,
        error: {
          code: "TOOL_LOOP_UNKNOWN_TOOL",
          message,
          retryable: false,
        },
      };
    }

    const toolTask: TaskNode = {
      id: `tool-use:${call.id}`,
      type: "tool",
      ref: call.name,
      input: call.arguments,
    };

    const toolSignal = buildToolExecutionSignal(ctx.signal, TOOL_USE_TOOL_TIMEOUT_MS);
    const toolCtx: ExecutionContext = {
      ...ctx.executionContext,
      abortSignal: toolSignal,
    };

    const globalApproval = ctx.config.runtime.toolLoop?.requireApprovalGlobal === true;
    const descriptorApproval = descriptor.requiresApproval === true;
    const autoApproved = isShellAutoApproved(call, ctx.config);
    if (autoApproved) {
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "progress",
          payload: {
            stage: "approval-auto",
            tool: call.name,
            callId: call.id,
            reason: "shell-auto-approve-pattern",
          },
        }),
      );
    }
 // 全局策略 (`requireApprovalGlobal`) 与描述符 `requiresApproval` 任一命中即需要审批；
 // 但若本次调用已被 shell 自动审批白名单覆盖，则跳过 approval 回调（用户在
 // `safety.shellAutoApprovePatterns` 里显式声明的命令视为预批准）。
    const approvalNeeded = (descriptorApproval || globalApproval) && !autoApproved;
    if (approvalNeeded && ctx.onBeforeToolCall) {
      const triggeredBy: ToolApprovalRequest["triggeredBy"] = descriptorApproval
        ? "descriptor"
        : "global";
      const approvalRequest: ToolApprovalRequest = {
        tool: call.name,
        callId: call.id,
        arguments: call.arguments,
        argumentsPreview: previewArguments(call.arguments),
        sideEffect: descriptor.sideEffect,
        requiresApproval: descriptorApproval,
        triggeredBy,
        correlation: ctx.executionContext.correlation,
        ...(ctx.executionContext.subject !== undefined
          ? { subject: ctx.executionContext.subject }
          : {}),
      };
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "progress",
          payload: {
            stage: "approval-pending",
            tool: call.name,
            callId: call.id,
            triggeredBy,
            sideEffect: descriptor.sideEffect,
          },
        }),
      );
      let decision: ToolApprovalDecision;
      try {
        ctx.onUserBlockingStart?.();
        decision = await ctx.onBeforeToolCall(approvalRequest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = { type: "deny", reason: `审批回调抛出异常：${message}` };
      } finally {
        ctx.onUserBlockingEnd?.();
      }
      if (decision.type === "deny") {
        const reason = decision.reason?.trim().length
          ? decision.reason.trim()
          : "用户拒绝执行该工具。";
        const durationMs = Date.now() - startedAt;
        const content = `工具调用已被用户拒绝："${reason}"。请改用其它工具或直接回答用户，不要重复请求同一工具。`;
        emitToolCallEnd({
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_APPROVAL_DENIED",
            message: reason,
            retryable: false,
          },
        });
        ctx.onToolCall?.({
          callId: call.id,
          tool: call.name,
          parentStepId,
          durationMs,
          success: false,
          source: "tool",
          error: {
            code: "TOOL_LOOP_APPROVAL_DENIED",
            message: reason,
            retryable: false,
          },
        });
        ctx.observability.emit(
          engineEventFromContext(ctx.executionContext, {
            timestamp: Date.now(),
            phase: "tool-use",
            type: "warning",
            payload: {
              reason: "approval-denied",
              tool: call.name,
              callId: call.id,
              triggeredBy,
            },
          }),
        );
        return {
          call,
          content,
          success: false,
          durationMs,
          error: {
            code: "TOOL_LOOP_APPROVAL_DENIED",
            message: reason,
            retryable: false,
          },
        };
      }
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "progress",
          payload: {
            stage: "approval-granted",
            tool: call.name,
            callId: call.id,
            triggeredBy,
          },
        }),
      );
 // 把"用户已明确授权本次调用"这个事实沿 TaskNode 往下带，宿主的
 // TaskExecutor 可据此豁免工作区沙箱等静态策略（用户已通过 argumentsPreview
 // 审阅过参数，包括任何路径字段）。
      toolTask.metadata = { ...(toolTask.metadata ?? {}), approvalGranted: true };
    }

    ctx.observability.emit(
      engineEventFromContext(ctx.executionContext, {
        timestamp: startedAt,
        phase: "tool-use",
        type: "tool_call_start",
        payload: {
          tool: call.name,
          callId: call.id,
          parentStepId,
          argumentsPreview: previewArguments(call.arguments),
        },
      }),
    );

    try {
      const taskResult = await ctx.taskExecutor(toolTask, toolCtx, toolSignal);
      const durationMs = Date.now() - startedAt;
      if (!taskResult.ok) {
        const content = `工具执行失败："${taskResult.error.message}"。你可以调整参数后重试一次，或放弃该工具直接给出回答。`;
        emitToolCallEnd({
          success: false,
          durationMs,
          error: {
            code: taskResult.error.code,
            message: taskResult.error.message,
            retryable: taskResult.error.retryable,
          },
        });
        ctx.onToolCall?.({
          callId: call.id,
          tool: call.name,
          parentStepId,
          durationMs,
          success: false,
          source: "tool",
          error: {
            code: taskResult.error.code,
            message: taskResult.error.message,
            retryable: taskResult.error.retryable,
          },
        });
        ctx.observability.emit(
          engineEventFromContext(ctx.executionContext, {
            timestamp: Date.now(),
            phase: "tool-use",
            type: "tool_call_end",
            payload: {
              reason: "tool-execution-failed",
              tool: call.name,
              callId: call.id,
              parentStepId,
              success: false,
              durationMs,
              error: taskResult.error,
            },
          }),
        );
        return {
          call,
          content,
          success: false,
          durationMs,
          error: {
            code: taskResult.error.code,
            message: taskResult.error.message,
            retryable: taskResult.error.retryable,
          },
        };
      }
      const output = taskResult.output;
      const content = serializeToolOutput(output, call.name);
      emitToolCallEnd({
        success: true,
        durationMs,
        output,
      });
      ctx.onToolCall?.({
        callId: call.id,
        tool: call.name,
        parentStepId,
        durationMs,
        success: true,
        source: "tool",
      });
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "tool_call_end",
          payload: {
            tool: call.name,
            callId: call.id,
            parentStepId,
            success: true,
            durationMs,
            outputLength: content.length,
          },
        }),
      );
      return { call, content, output, success: true, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message =
        error instanceof Error ? error.message : String(error);
      const content = `工具执行失败："${message}"。你可以调整参数后重试一次，或放弃该工具直接给出回答。`;
      emitToolCallEnd({
        success: false,
        durationMs,
        error: {
          code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
          message,
          retryable: false,
        },
      });
      ctx.onToolCall?.({
        callId: call.id,
        tool: call.name,
        parentStepId,
        durationMs,
        success: false,
        source: "tool",
        error: {
          code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
          message,
          retryable: false,
        },
      });
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "tool_call_end",
          payload: {
            reason: "tool-execution-failed",
            tool: call.name,
            callId: call.id,
            parentStepId,
            success: false,
            durationMs,
            error: {
              code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
              message,
              retryable: false,
            },
          },
        }),
      );
      return {
        call,
        content,
        success: false,
        durationMs,
        error: {
          code: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
          message,
          retryable: false,
        },
      };
    }
  } finally {
    if (toolCallStartDelivered && !toolCallEndDelivered) {
      emitToolCallEnd({
        success: false,
        durationMs: Math.max(0, Date.now() - mark),
        error: {
          code: "TOOL_LOOP_ABANDONED",
          message: "工具调用在产出正常 tool-call-end 之前被异常中断。",
          retryable: false,
        },
      });
    }
  }
};

/**
 * 按并发度 `parallelism` 执行一批工具调用。
 *
 * 保序：返回的 `ExecutedToolRecord[]` 与输入 `calls` 一一对应（即便内部分批并发）。
 *
 * 实现说明：工作线程在 `await executeSingleToolCall` 之前同步完成 `cursor` 抢占，
 * 因此在 JS 单线程事件模型下索引不会重复；不要在抢占与 await 之间插入 await，
 * 否则会破坏该不变量。
 */
const executeToolCallsBatch = async (
  calls: ToolCallRequest[],
  ctx: ToolUseContext,
  parallelism: number,
  parentStepId: string,
): Promise<ExecutedToolRecord[]> => {
  const results: ExecutedToolRecord[] = new Array(calls.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(parallelism, calls.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async (): Promise<void> => {
        while (cursor < calls.length) {
          const myIndex = cursor;
          cursor += 1;
          const call = calls[myIndex];
          if (!call) continue;
          results[myIndex] = await executeSingleToolCall(call, ctx, parentStepId);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
};

const resolveToolLoopLimits = (
  config: EngineConfig,
): { maxSteps: number; parallelism: number } => {
  const toolLoop = config.runtime.toolLoop ?? {};
  return {
    maxSteps: toolLoop.maxSteps ?? 25,
    parallelism: toolLoop.parallelism ?? 4,
  };
};

/**
 * Provider 返回的 finishReason 缺省规则：
 * - 若有 toolCalls 且 finishReason 为空 → 视作 `tool_calls`
 * - 若无 toolCalls 且 finishReason 为空 → 视作 `stop`
 *
 * 该兜底是为了兼容一些 provider 的 stream 不吐 finishReason 的情况。
 */
const normalizeFinishReason = (
  finishReason: ChatFinishReason | undefined,
  hasToolCalls: boolean,
): ChatFinishReason => {
  if (finishReason !== undefined) return finishReason;
  return hasToolCalls ? "tool_calls" : "stop";
};

interface ToolUseStepResponse {
  content: string;
  toolCalls?: ToolCallRequest[] | undefined;
  finishReason?: ChatFinishReason | undefined;
  usage: ChatUsage;
  reasoningContent?: string | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}

interface PartialStreamToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
  providerMetadata?: Record<string, unknown> | undefined;
}

const EMPTY_USAGE: ChatUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

const appendToolCallDelta = (
  calls: Map<number, PartialStreamToolCall>,
  part: Extract<ChatStreamChunk, { type: "tool-call-delta" }>,
): void => {
  const current = calls.get(part.index) ?? { argumentsText: "" };
  if (part.id !== undefined) {
    current.id = part.id;
  }
  if (part.name !== undefined) {
    current.name = part.name;
  }
  if (part.argumentsDelta !== undefined) {
    current.argumentsText += part.argumentsDelta;
  }
  if ("providerMetadata" in part && part.providerMetadata !== undefined) {
    current.providerMetadata = part.providerMetadata;
  }
  calls.set(part.index, current);
};

const parseToolCallArguments = (
  raw: string,
  toolName: string,
): Record<string, unknown> => {
  const text = raw.trim();
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
 // fall through to the explicit protocol error below
  }
  throw new Error(`Provider streamed invalid tool arguments for ${toolName}`);
};

const materializeDeltaToolCalls = (
  partials: Map<number, PartialStreamToolCall>,
  completedIds: Set<string>,
): ToolCallRequest[] => {
  const calls: ToolCallRequest[] = [];
  const ordered = [...partials.entries()].sort(([a], [b]) => a - b);
  for (const [, partial] of ordered) {
    if (!partial.id || !partial.name || completedIds.has(partial.id)) {
      continue;
    }
    calls.push({
      id: partial.id,
      name: partial.name,
      arguments: parseToolCallArguments(partial.argumentsText, partial.name),
      ...(partial.providerMetadata !== undefined
        ? { providerMetadata: partial.providerMetadata }
        : {}),
    });
  }
  return calls;
};

const collectStreamedToolUseStep = async (args: {
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  ctx: ToolUseContext;
  step: number;
  stepId: string;
  signal: AbortSignal;
  markFirstOutput: () => void;
  usageTracker?: LlmUsageTracker | undefined;
  demand?: import("../../types/resource").ResourceDemand | undefined;
}): Promise<ToolUseStepResponse> => {
  const {
    adapter,
    model,
    messages,
    tools,
    ctx,
    step,
    stepId,
    signal,
    markFirstOutput,
    usageTracker,
    demand,
  } = args;
  const toolCalls: ToolCallRequest[] = [];
  const completedToolCallIds = new Set<string>();
  const partialToolCalls = new Map<number, PartialStreamToolCall>();
  let content = "";
  let finishReason: ChatFinishReason | undefined;
  let usage: ChatUsage = EMPTY_USAGE;
  let providerMetadata: Record<string, unknown> | undefined;

  for await (const part of streamChatWithResolvedMessages(
    adapter,
    {
      model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    },
    ctx.adapterContext,
    ctx.multimodalResolver,
    signal,
    demand,
    (degradations) =>
      emitResourceDegradations(
        ctx.observability,
        ctx.adapterContext,
        "tool-use",
        "tool-use",
        degradations,
      ),
  )) {
    if (part.type === "text-delta") {
      if (part.delta.length > 0) {
        markFirstOutput();
      }
      content += part.delta;
      usageTracker?.addOutputDelta(part.delta);
      ctx.onToolLoopEvent?.(
        withStreamEnvelope(
          {
            type: "tool-loop-delta",
            step,
            stepId,
            content: part.delta,
          },
          ctx.executionContext,
        ),
      );
    } else if (part.type === "reasoning-delta") {
      if (part.delta.length > 0) {
        markFirstOutput();
        usageTracker?.addOutputDelta(part.delta);
        ctx.onAssistantReasoningDelta?.(part.delta);
      }
    } else if (part.type === "tool-call-delta") {
      markFirstOutput();
      if (part.argumentsDelta !== undefined && part.argumentsDelta.length > 0) {
        usageTracker?.addOutputDelta(part.argumentsDelta);
      }
      appendToolCallDelta(partialToolCalls, part);
    } else if (part.type === "tool-call-complete") {
      markFirstOutput();
      toolCalls.push(part.call);
      completedToolCallIds.add(part.call.id);
    } else if (part.type === "finish") {
      finishReason = part.finishReason;
      if (part.usage !== undefined) {
        usage = part.usage;
      }
      providerMetadata = part.providerMetadata;
    }
  }

  toolCalls.push(...materializeDeltaToolCalls(partialToolCalls, completedToolCallIds));

  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    usage,
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
  };
};

/**
 * 把 `tools` 列表映射为 Provider.chat 可接受的 ToolDefinition。
 *
 * 优先使用 `prebuiltPrompt.tools`（已由 PromptAssembler 做过 maxContextTokens 裁剪与
 * scope 过滤）；若为空则回退到 registry 直查。
 */
const registryToolDefinitions = (ctx: ToolUseContext): ToolDefinition[] =>
  ctx.registry.list("tool").map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

const filterToolDefinitions = (
  tools: ToolDefinition[],
  toolNames: readonly string[] | undefined,
): ToolDefinition[] => {
  if (!toolNames || toolNames.length === 0) {
    return tools;
  }
  const allowed = new Set(toolNames);
  return tools.filter((tool) => allowed.has(tool.name));
};

const resolveToolDefinitions = (input: ToolUseInput, ctx: ToolUseContext): ToolDefinition[] => {
  const prebuilt = filterToolDefinitions(
    mergeInternalToolDefinitions(ctx.prebuiltPrompt.tools),
    input.toolNames,
  );
  if (prebuilt.length > 0) {
    return prebuilt;
  }
  return filterToolDefinitions(
    mergeInternalToolDefinitions(registryToolDefinitions(ctx)),
    input.toolNames,
  );
};

/**
 * 执行 Agentic Loop：LLM 思考 → 工具调用 → 观察结果 → ... → 最终文本回复。
 *
 * 约束：
 * - 最多 `config.runtime.toolLoop.maxSteps` 轮（默认 25）
 * - 单轮多工具并发上限 `config.runtime.toolLoop.parallelism`（默认 4）
 * - 工具不存在时不直接失败，而是把错误作为 tool message 回给 LLM，让它自己修复
 * - 工具执行失败同理——不中止整条 loop；让 LLM 决定下一步
 *
 * 成功返回：最终 LLM 给出的自然语言回复（已 trim）
 *
 * 失败抛错：
 * - `TOOL_LOOP_STEPS_EXHAUSTED`：循环超过 maxSteps 仍未终止
 * - `TOOL_LOOP_EMPTY_TERMINAL_RESPONSE`：finishReason=stop 但 content 空
 * - `TOOL_LOOP_PROVIDER_NO_RESPONSE`：finishReason=stop 且 content 空 且没有任何 toolCalls
 */
export const executeToolUse = async (
  input: ToolUseInput,
  ctx: ToolUseContext,
): Promise<ToolUseResult> => {
  if (!input || typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new Error("tool-use 缺少必填字段 input.prompt");
  }

  const { maxSteps, parallelism } = resolveToolLoopLimits(ctx.config);
  const route = resolveToolUseRoute(input, ctx);
  const adapter = ctx.providers.get(route.provider);
  if (!adapter) {
    throw new Error(`tool-use 路由到 provider ${route.provider}，但该 provider 未注册`);
  }

  const tools = resolveToolDefinitions(input, ctx);
  const toolNameSet = new Set(tools.map((t) => t.name));
  const candidateToolDescriptors = ctx.registry
    .list("tool")
    .filter((d): d is ToolDescriptor => d.kind === "tool" && toolNameSet.has(d.name));
  const conversation: Message[] =
    ctx.prebuiltPrompt.messages.length > 0
      ? buildInitialMessages(input, ctx)
      : await buildFallbackMessages(input, ctx);

  ctx.observability.emit(
    engineEventFromContext(ctx.executionContext, {
      timestamp: Date.now(),
      phase: "tool-use",
      type: "phase_enter",
      payload: {
        provider: adapter.id,
        model: route.model,
        toolCount: tools.length,
        maxSteps,
        parallelism,
        ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
      },
    }),
  );

  const steps: ToolUseResultStep[] = [];
  const observations: ToolUseObservation[] = [];
  const emitStepEnd = (payload: {
    step: number;
    stepId: string;
    success: boolean;
    reason: string;
    error?: { code: string; message: string; retryable: boolean } | undefined;
    stopReason?: string | undefined;
    failureReason?: string | undefined;
    selectedTools?: string[] | undefined;
    argumentsPreview?: string | undefined;
  }): void => {
    const chunk = withStreamEnvelope(
      {
        type: "tool-loop-step-end" as const,
        step: payload.step,
        stepId: payload.stepId,
        ...(ctx.currentPhaseStepId !== undefined
          ? { parentStepId: ctx.currentPhaseStepId }
          : {}),
        success: payload.success,
        reason: payload.reason,
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
        ...(payload.failureReason !== undefined
          ? { failureReason: payload.failureReason }
          : {}),
        ...(payload.selectedTools !== undefined ? { selectedTools: payload.selectedTools } : {}),
        ...(payload.argumentsPreview !== undefined
          ? { argumentsPreview: payload.argumentsPreview }
          : {}),
        retryCount: ctx.turnRetryCount ?? 0,
        ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {}),
      },
      ctx.executionContext,
    );
    ctx.onToolLoopEvent?.(chunk);
    ctx.observability.emit(
      engineEventFromContext(ctx.executionContext, {
        timestamp: Date.now(),
        phase: "tool-use",
        type: "tool_loop_step_end",
        payload: {
          step: payload.step,
          stepId: payload.stepId,
          parentStepId: ctx.currentPhaseStepId,
          success: payload.success,
          reason: payload.reason,
          stopReason: payload.stopReason,
          failureReason: payload.failureReason,
          selectedTools: payload.selectedTools ?? [],
          argumentsPreview: payload.argumentsPreview ?? "[]",
          retryCount: ctx.turnRetryCount ?? 0,
          ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
          ...(payload.error !== undefined ? { error: payload.error } : {}),
        },
      }),
    );
  };
  const emitFinal = (payload: {
    steps: number;
    success: boolean;
    stepId?: string | undefined;
  }): void => {
    ctx.onToolLoopEvent?.(
      withStreamEnvelope(
        {
          type: "tool-loop-final",
          steps: payload.steps,
          success: payload.success,
          ...(payload.stepId !== undefined ? { stepId: payload.stepId } : {}),
        },
        ctx.executionContext,
      ),
    );
  };
  const buildPartialResult = (
    error: NonNullable<ToolUseResult["error"]>,
  ): ToolUseResult => ({
    kind: "tool-use-result",
    status: "partial",
    steps,
    observations,
    error,
  });
  const buildPartialResultFromUnknown = (
    error: unknown,
    fallbackCode: string,
  ): ToolUseResult => buildPartialResult(errorToToolUseResultError(error, fallbackCode));

  ctx.onToolLoopActiveStart?.();
  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      if (ctx.signal.aborted) {
        const error =
          ctx.signal.reason instanceof Error
            ? ctx.signal.reason
            : new Error("tool-use 循环被外部取消");
        if (observations.length > 0) {
          return buildPartialResultFromUnknown(error, "TOOL_LOOP_ABORTED");
        }
        throw error;
      }
      const stepId =
        ctx.nextStreamId?.() ?? `${ctx.executionContext.correlation.traceId}:tool-use-step:${step}`;
      ctx.onToolLoopEvent?.(
        withStreamEnvelope(
          {
            type: "tool-loop-step",
            step,
            maxSteps,
            stepId,
            ...(ctx.currentPhaseStepId !== undefined
              ? { parentStepId: ctx.currentPhaseStepId }
              : {}),
            selectedTools: [],
            argumentsPreview: "[]",
            retryCount: ctx.turnRetryCount ?? 0,
          },
          ctx.executionContext,
        ),
      );
      ctx.observability.emit(
        engineEventFromContext(ctx.executionContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "tool_loop_step_start",
          payload: {
            step,
            maxSteps,
            stepId,
            parentStepId: ctx.currentPhaseStepId,
            selectedTools: [],
            argumentsPreview: "[]",
            retryCount: ctx.turnRetryCount ?? 0,
          },
        }),
      );

      const llmTimeouts = resolveLlmTimeouts(ctx.config, "tool-use");
      const llmStartedAt = Date.now();
      const useStream =
        ctx.config.runtime.streamingOutput === true &&
        ctx.onToolLoopEvent !== undefined;
      let response: ToolUseStepResponse;
      let llmSignal: AbortSignal | undefined;
      const usageTracker = createLlmUsageTracker({
        attribution: {
          id: ctx.nextStreamId?.() ?? `${ctx.executionContext.correlation.traceId}:tool-use-llm:${step}`,
          kind: "llm_call",
          parentId: stepId,
          label: `tool-use step ${step}`,
          meta: {
            phase: "execution",
            subflow: "tool-use",
            step,
            provider: adapter.id,
            model: route.model,
          },
        },
        estimatedInputTokens: await estimateMessagesTokens(
          adapter,
          conversation,
          route.model,
        ),
        emit: ctx.emitUsageTelemetry,
      });
      usageTracker.start();
      const demand = await resolveProviderDemand(ctx.resourceDemandRouter, {
        adapter,
        model: route.model,
        unit: "tool-use",
        phase: "tool-use",
        messages: conversation,
        candidateTools: candidateToolDescriptors,
      });
      try {
        if (useStream) {
          const streamAbort = createLlmStreamAbortController(ctx.signal, llmTimeouts);
          llmSignal = streamAbort.signal;
          try {
            response = await collectStreamedToolUseStep({
              adapter,
              model: route.model,
              messages: conversation,
              tools,
              ctx,
              step,
              stepId,
              signal: streamAbort.signal,
              markFirstOutput: streamAbort.markFirstOutput,
              usageTracker,
              demand,
            });
          } finally {
            streamAbort.dispose();
          }
        } else {
          llmSignal = buildLlmCallAbortSignal(
            ctx.signal,
            llmTimeouts.llmStreamingMs,
            "streaming",
          );
          const chatResult = await chatWithResolvedMessages(
            adapter,
            {
              model: route.model,
              messages: conversation,
              ...(tools.length > 0 ? { tools } : {}),
            },
            ctx.adapterContext,
            ctx.multimodalResolver,
            llmSignal,
            demand,
          );
          if (!chatResult.ok) {
            throw new HostError(
              "INTEGRATION_IMAGE_RESOLUTION_FAILED",
              chatResult.reason,
              {
                userMessage: chatResult.userVisibleReason,
                context: { userVisibleReason: chatResult.userVisibleReason },
              },
            );
          }
          response = chatResult.response;
          emitResourceDegradations(
            ctx.observability,
            ctx.adapterContext,
            "tool-use",
            "tool-use",
            chatResult.degradations,
          );
          if (typeof response.content === "string" && response.content.length > 0) {
            usageTracker.addOutputDelta(response.content);
            ctx.onToolLoopEvent?.(
              withStreamEnvelope(
                {
                  type: "tool-loop-delta",
                  step,
                  stepId,
                  content: response.content,
                },
                ctx.executionContext,
              ),
            );
          }
          if (
            typeof response.reasoningContent === "string" &&
            response.reasoningContent.length > 0
          ) {
            usageTracker.addOutputDelta(response.reasoningContent);
          }
        }
      } catch (error) {
        usageTracker.terminal(ctx.signal.aborted ? "cancelled" : "failed");
        const timeoutAbort = llmSignal ? isBudgetTimeoutAbort(llmSignal) : null;
        const effectiveError = timeoutAbort ?? error;
        const resultError = errorToToolUseResultError(
          effectiveError,
          "TOOL_LOOP_PROVIDER_CALL_FAILED",
        );
        const message =
          effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
        const errorName =
          effectiveError instanceof Error ? effectiveError.name : "UnknownError";
        ctx.observability.emit(
          engineEventFromContext(ctx.executionContext, {
            timestamp: Date.now(),
            phase: "tool-use",
            type: "warning",
            payload: {
              provider: adapter.id,
              model: route.model,
              step,
              durationMs: Date.now() - llmStartedAt,
              errorName,
              message,
              reason: "tool-use LLM call failed; aborting loop",
            },
          }),
        );
        emitStepEnd({
          step,
          stepId,
          success: false,
          reason: "provider-error",
          failureReason: message,
          error: resultError,
        });
        emitFinal({ steps: step, stepId, success: false });
        if (observations.length > 0) {
          return buildPartialResult(resultError);
        }
        throw effectiveError;
      }
      if (response.usage.totalTokens > 0) {
        usageTracker.final(response.usage);
      }
      ctx.onProviderUsage?.(response.usage);

 // 非流式模型 reasoning_content（若有）一次性透传到顶层 SSE 通道；流式路径
 // 已在 collectStreamedToolUseStep 中按 reasoning-delta 增量透传。
      if (
        typeof response.reasoningContent === "string" &&
        response.reasoningContent.length > 0
      ) {
        ctx.onAssistantReasoningDelta?.(response.reasoningContent);
      }

      const toolCalls = response.toolCalls ?? [];
      const finishReason = normalizeFinishReason(
        response.finishReason,
        toolCalls.length > 0,
      );
      const content = typeof response.content === "string" ? response.content.trim() : "";

 // 把 assistant 回复追加进对话（包括可能的 toolCalls，供后续 tool role 消息绑定）。
      conversation.push({
        role: "assistant",
        content: content.length > 0 ? content : "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(response.providerMetadata !== undefined
          ? { providerMetadata: response.providerMetadata }
          : {}),
      });

      if (finishReason !== "tool_calls" || toolCalls.length === 0) {
        const terminalStep: ToolUseResultStep = {
          step,
          modelNotes: content,
          toolCalls: [],
        };
        steps.push(terminalStep);
        if (content.length > 0) {
          ctx.observability.emit(
            engineEventFromContext(ctx.executionContext, {
              timestamp: Date.now(),
              phase: "tool-use",
              type: "llm_call_end",
              payload: {
                step,
                terminal: true,
                finishReason,
                usage: response.usage,
              },
            }),
          );
          emitStepEnd({
            step,
            stepId,
            success: true,
            reason: "terminal",
            stopReason: finishReason,
          });
          emitFinal({ steps: step, stepId, success: true });
          return {
            kind: "tool-use-result",
            status: "ready_for_output",
            steps,
            observations,
            terminalDraft: content,
          };
        }
        const error =
          step === 1
            ? ToolLoopError.providerNoResponse()
            : ToolLoopError.emptyTerminalResponse();
        const resultError = errorToToolUseResultError(
          error,
          "TOOL_LOOP_EMPTY_TERMINAL_RESPONSE",
        );
        emitStepEnd({
          step,
          stepId,
          success: false,
          reason: "empty-terminal",
          failureReason: resultError.message,
          error: resultError,
        });
        emitFinal({ steps: step, stepId, success: false });
        if (observations.length > 0) {
          return buildPartialResult(resultError);
        }
        throw error;
      }

 // 执行本轮 toolCalls，然后把 tool message 拼回对话继续下一轮。
      const batch = await executeToolCallsBatch(toolCalls, ctx, parallelism, stepId);
      const stepToolCalls = batch.map(toResultToolCall);
      steps.push({
        step,
        modelNotes: content,
        toolCalls: stepToolCalls,
      });
      for (const item of batch) {
        observations.push(toObservation(item));
        conversation.push({
          role: "tool",
          content: item.content,
          toolCallId: item.call.id,
          name: item.call.name,
        });
      }
      const failedToolCalls = stepToolCalls.filter((item) => !item.ok);
      emitStepEnd({
        step,
        stepId,
        success: failedToolCalls.length === 0,
        reason:
          failedToolCalls.length === 0
            ? "tool-calls-completed"
            : "tool-calls-finished-with-errors",
        failureReason: failedToolCalls[0]?.error?.message,
        error: failedToolCalls[0]?.error,
        selectedTools: toolCalls.map((call) => call.name),
        argumentsPreview: previewArguments({ toolCalls: toolCalls.map((call) => call.arguments) }),
      });
    }

    const exhausted = ToolLoopError.stepsExhausted(maxSteps);
    const resultError = errorToToolUseResultError(
      exhausted,
      "TOOL_LOOP_STEPS_EXHAUSTED",
    );
    emitFinal({ steps: maxSteps, success: false });
    if (observations.length > 0) {
      return {
        kind: "tool-use-result",
        status: "exhausted",
        steps,
        observations,
        error: resultError,
      };
    }
    throw exhausted;
  } finally {
    ctx.onToolLoopActiveEnd?.();
    ctx.onUserBlockingEnd?.();
  }
};

export const TOOL_USE_CONSTANTS = {
  TOOL_TIMEOUT_MS: TOOL_USE_TOOL_TIMEOUT_MS,
  SYSTEM_PROMPT_BASE: TOOL_USE_SYSTEM_PROMPT_BASE,
  HISTORY_LIMIT: TOOL_USE_HISTORY_LIMIT,
  MAX_TOOL_OUTPUT_CHARS,
} as const;

export const __testing = {
  buildToolUseSystemPrompt,
};
