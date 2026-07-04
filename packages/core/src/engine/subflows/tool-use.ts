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
  GeneratedImage,
  GeneratedMedia,
  HookAction,
  HookPoint,
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
import type { GatingPolicy } from "../../types/gating-policy";
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
import type { HookRegistry } from "../../modules/hooks";
import { DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH, type AgentDispatchFn } from "../agents";
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
 * 相比其它更简单的 Sub-flow 上下文形状：
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
 /**
 * 文生图响应的结构化图片回传(与 {@link OutputMetadata.generatedImages} 对齐)。
 *
 * 由 Engine 注入;当某个 loop step 的 Provider 响应携带 `images` 非空时调用一次
 * (迁自已删除的 `direct-answer.ts`,ADR-0006 C1:塌陷为深单 loop 后 tool-use
 * 是唯一路径,必须原样吸收该能力，否则文生图场景会静默丢失产物回传)。
 */
  onGeneratedImages?: (images: GeneratedImage[]) => void;
 /** 通用多模态产物回传(图片 / 音频 / 视频 / 文件);同上,迁自 direct-answer.ts。 */
  onGeneratedMedia?: (media: GeneratedMedia[]) => void;
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
  loadSkill?: InternalToolContext["loadSkill"];
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
 /**
 * loop 内 LLM 自决派发只读 sub-agent 的执行入口(ADR-0006 D6)。
 *
 * 由 Engine 注入;未注入(undefined)时 `dispatch_agent` 工具不会出现在
 * `resolveToolDefinitions` 结果中(零新增架构面：无该字段即完全等价旧行为)。
 * 复用现有 Agent runtime(`agentRunId` history-scope 隔离、`decideSubAgentBudget`、
 * 同一 `toolUseExecutor`)；Single-Writer Rule(allowedTools 确定性过滤掉写工具)
 * 与 summary-only 契约(只回 output+evidence，不回子 loop 全 transcript)均由
 * 闭包内部（`Engine.runSubAgent`）保证，本文件只负责工具形状与调用编排。
 */
  dispatchAgent?: AgentDispatchFn | undefined;
 /**
 * 当前 loop 相对主 loop 的 sub-agent 派发深度。主 loop 恒为 `0`；某次
 * `dispatch_agent` 派发出的 sub-agent 自身跑 tool-use 时，其 ctx 会带上
 * `派发它时的 currentDepth` 值。`resolveToolDefinitions` 据此与
 * `config.runtime.toolLoop.subagentDispatch.maxDepth`（默认 `1`）比较，
 * 深度已耗尽时直接不暴露该工具（而非暴露后等运行时报错），对齐 Claude Code
 * 「Task 工具不可在子 agent 内再次调用」的默认策略。
 */
  agentDispatchDepth?: number | undefined;
  /** Normalized gating policy for soft tail constraints. */
  gatingPolicy?: GatingPolicy;
  /**
   * loop-lifecycle Hook 注册中心(ADR-0006 D2)。
   *
   * 驱动本子流程内的真实 fire 位:每个 loop step 调 LLM 前后
   * (`preLLM`/`postLLM`)、每次工具调用前后(`preToolUse`/`postToolUse`)、
   * per-step 上下文超阈值即将自动 compact 前(`preCompact`)。未注入时
   * 全部 no-op(向后兼容既有测试与调用方)。
   */
  hooks?: HookRegistry;
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

### Absolutely forbidden (in the final reply)
- **No empty promises**. Never write "I'll fetch …", "let me check …", "please hold on while I look this up", "我将…请稍等", "稍等我去查一下". This turn has no next turn, no \`await\` — saying "hold on" is the same as saying nothing. If you need information, call a tool now; if no tool can get it, say so plainly.
- **No pretending you executed an action**. Do not write "I fetched the page and here is the content …", "based on the file I just opened …" unless a real tool call for that action actually appears earlier in this conversation. Do not turn things you did not do into past-tense facts.
- If the request needs a live fetch / local read / command / realtime data but no matching tool is available (empty tool list, or none fits): tell the user plainly that no matching tool was available this turn, answer from your prior knowledge as best you can, and **explicitly label** the answer as based on general knowledge rather than live/local data.

### Termination
- The system caps the number of loop steps; exceeding it raises an error. Stop calling tools as soon as you are ready to answer.

Respond in the same language as the latest user message; default to English when ambiguous.`;

/**
 * 失败恢复护栏注入的默认纠错提示（domain 无关）。
 *
 * 触发时机：本轮「有过工具失败且零成功结果」，模型却给出 terminal（放弃/编造）。
 * 作为 `system` 角色注入（外部 wrapper，对弱模型的自我修复最有效），要点：
 * 1. 不点名任何具体工具（保持 domain 无关）
 * 2. 明确「若因标识符/参数未知失败，先调用发现/列举类工具」
 * 3. 明确「禁止重复刚才失败的同一调用」
 * 4. 明确「有成功结果或穷尽发现工具后才可停」
 */
const FAILURE_RECOVERY_PROMPT = `The previous tool call(s) failed and no tool has returned a usable result yet. Do NOT give up or fabricate an answer. If the failure was caused by an unknown identifier, name, or argument (for example a table/view/field/resource that may not exist), first call a discovery or listing tool to find the correct value, then retry with corrected arguments. Do not repeat the exact same failed call. Only stop and give a final answer once you have at least one successful tool result, or you have genuinely exhausted the available discovery tools.`;

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

const buildGatingPolicyTailNote = (policy: GatingPolicy | undefined): string | null => {
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
  let note = `Turn policy: visualization=${visualization}. Excluded tools must not be called. Pinned skills define output format for the final answer.`;
 // Change 3：pin 了偏好工具时，补一句发现指引，引导「标识符未知即失败」的场景先去列举/发现，
 // 而非盲猜或放弃。仅在 includeTools 非空时追加，避免污染无偏好工具的普通轮次。
  if (policy.includeTools.length > 0) {
    note += ` If a preferred tool fails because an identifier or argument is unknown, first use a discovery or listing tool to confirm the correct value before continuing.`;
  }
  return note;
};

const appendGatingPolicyTail = (messages: Message[], policy: GatingPolicy | undefined): Message[] => {
  const note = buildGatingPolicyTailNote(policy);
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
    return appendGatingPolicyTail(messages, ctx.gatingPolicy);
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
  return appendGatingPolicyTail(messages, ctx.gatingPolicy);
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
  return appendGatingPolicyTail(messages, ctx.gatingPolicy);
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
 * 单条 `allowed-tools` pattern 是否命中本次调用。
 *
 * 支持两种形态（agentskills.io / Claude Code 风格）：
 * - 裸工具名 `"read-file"`：命中该工具的任意调用（任意参数）。
 * - `"run-shell(<regex>)"`：仅当 `call.name === "run-shell"` 且 `arguments.command`
 * 匹配 `<regex>` 时命中；与 `shellAutoApprovePatterns` 同一套“只匹配纯命令、
 * 带 args 字段一律不豁免”的保守策略，避免 Skill 声明的白名单被参数注入绕过。
 *
 * 目前只对 `run-shell` 支持括号内的参数级模式——其余工具的参数结构各异，
 * 没有一个通用、安全的“参数是否匹配”定义，故只支持工具级豁免。
 */
const isAllowedToolsPatternMatch = (pattern: string, call: ToolCallRequest): boolean => {
  const parenIndex = pattern.indexOf("(");
  if (parenIndex === -1) {
    return pattern === call.name;
  }
  if (!pattern.endsWith(")")) return false;
  const toolName = pattern.slice(0, parenIndex);
  const argPattern = pattern.slice(parenIndex + 1, -1);
  if (toolName !== "run-shell" || call.name !== "run-shell") return false;
  const args = call.arguments as { command?: unknown; args?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command.length === 0) return false;
  if (Array.isArray(args.args) && args.args.length > 0) return false;
  try {
    return new RegExp(argPattern).test(command);
  } catch {
    return false;
  }
};

/**
 * 判断本次工具调用是否被当前 turn 的某个 Active Skill 的 `allowed-tools`
 * 豁免审批（Skill Tool Pre-Approval，见 CONTEXT.md）。
 *
 * 关键约束：只查 `activeSkills`（当前 turn 实际被激活、指令已 pin 进 T0 的技能），
 * 不查 registry 里所有已注册技能——豁免范围严格是“当前 turn 的 Active Skill”，
 * 不是“系统里存在这个技能”。豁免不落盘，不跨 turn，不需要宿主接入任何东西
 * （纯 core 内决策，天然对所有 host 生效）。
 */
const isSkillAllowedToolsMatch = (
  call: ToolCallRequest,
  activeSkills: readonly { allowedTools?: readonly string[] | undefined }[],
): boolean =>
  activeSkills.some((skill) =>
    (skill.allowedTools ?? []).some((pattern) => isAllowedToolsPatternMatch(pattern, call)),
  );

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
 * 校验失败时回给 LLM 的提示文案，说明 `dispatch_agent` 的必填参数。
 */
const AGENT_DISPATCH_INVALID_ARGS_MESSAGE =
  'dispatch_agent 调用参数不合法：需要非空字符串 "agent" 与 "objective"；"input" 若提供须为对象。请修正后重试。';

/**
 * 执行 `dispatch_agent` 内置 Task-style 工具调用(ADR-0006 D6)。
 *
 * 与业务/内置工具分支平级但独立处理，因为它不经过 `registry`/`taskExecutor`，
 * 而是转交 `ctx.dispatchAgent` 闭包(由 Engine 注入，内部复用 Agent runtime、
 * `decideSubAgentBudget`、`agentRunId` history-scope)。返回契约与其它工具
 * 分支保持一致：无论成败都恰好 emit 一次 `tool-call-end` 并回填 `ExecutedToolRecord`。
 */
const executeAgentDispatchCall = async (
  call: ToolCallRequest,
  ctx: ToolUseContext,
  parentStepId: string,
  startedAt: number,
  emitToolCallEnd: (payload: {
    success: boolean;
    durationMs: number;
    output?: unknown;
    error?: { code: string; message: string; retryable: boolean };
  }) => void,
): Promise<ExecutedToolRecord> => {
  const fail = (code: string, message: string, retryable: boolean): ExecutedToolRecord => {
    const durationMs = Date.now() - startedAt;
    emitToolCallEnd({ success: false, durationMs, error: { code, message, retryable } });
    ctx.onToolCall?.({
      callId: call.id,
      tool: call.name,
      parentStepId,
      durationMs,
      success: false,
      source: "tool",
      error: { code, message, retryable },
    });
    return { call, content: message, success: false, durationMs, error: { code, message, retryable } };
  };

  if (!ctx.dispatchAgent) {
    return fail(
      "TOOL_LOOP_INTERNAL_TOOL_MISCONFIG",
      `内置工具 "${AGENT_DISPATCH_TOOL_NAME}" 需要 dispatchAgent，但主干未注入。`,
      false,
    );
  }

  const agentName = typeof call.arguments.agent === "string" ? call.arguments.agent.trim() : "";
  const objective =
    typeof call.arguments.objective === "string" ? call.arguments.objective.trim() : "";
  if (!agentName || !objective) {
    return fail("TOOL_LOOP_TOOL_EXECUTION_FAILED", AGENT_DISPATCH_INVALID_ARGS_MESSAGE, true);
  }
  const rawInput = call.arguments.input;
  const dispatchInput =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;

  const dispatchSignal = buildToolExecutionSignal(ctx.signal, TOOL_USE_TOOL_TIMEOUT_MS);
  try {
    const outcome = await ctx.dispatchAgent(
      { agentName, objective, ...(dispatchInput !== undefined ? { input: dispatchInput } : {}) },
      dispatchSignal,
    );
    const durationMs = Date.now() - startedAt;
    if (outcome.status === "completed") {
      const output = {
        agent: outcome.agent,
        output: outcome.output,
        evidence: outcome.evidence ?? [],
      };
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
    }
    if (outcome.status === "cancelled") {
      return fail("AGENT_CANCELLED", outcome.reason, true);
    }
    return fail(outcome.error.code, outcome.error.message, outcome.error.retryable);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("TOOL_LOOP_TOOL_EXECUTION_FAILED", `sub-agent 派发失败："${message}"`, false);
  }
};

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
const executeSingleToolCallInner = async (
  call: ToolCallRequest,
  ctx: ToolUseContext,
  parentStepId: string,
  approvedByPreToolUse = false,
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

    if (call.name === AGENT_DISPATCH_TOOL_NAME) {
      return executeAgentDispatchCall(call, ctx, parentStepId, startedAt, emitToolCallEnd);
    }

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
          ...(ctx.loadSkill !== undefined ? { loadSkill: ctx.loadSkill } : {}),
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
    const shellAutoApproved = isShellAutoApproved(call, ctx.config);
    const skillAllowedToolsApproved = isSkillAllowedToolsMatch(
      call,
      ctx.prebuiltPrompt.activeSkills,
    );
    const autoApproved = shellAutoApproved || skillAllowedToolsApproved;
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
            reason: shellAutoApproved ? "shell-auto-approve-pattern" : "skill-allowed-tools",
          },
        }),
      );
    }
 // 全局策略 (`requireApprovalGlobal`) 与描述符 `requiresApproval` 任一命中即需要审批；
 // 但若本次调用已被 shell 自动审批白名单覆盖，或被当前 Active Skill 的
 // `allowed-tools` 豁免，则跳过 approval 回调。
    const approvalNeeded = (descriptorApproval || globalApproval) && !autoApproved && !approvedByPreToolUse;
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
    if (approvedByPreToolUse) {
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
 * `executeSingleToolCallInner` 的 loop-lifecycle 包装(ADR-0006 D2)。
 *
 * - `preToolUse`:每次工具调用前无条件 fire(与既有 `onBeforeToolCall` 的
 *   条件审批语义并存,互不替代);返回 `deny`/`abort` 时跳过真实执行,合成
 *   一条拒绝态 `ExecutedToolRecord`,与 `onBeforeToolCall` 拒绝路径同构。
 * - `postToolUse`:工具执行后(无论成败)fire,允许 `modify`/`replace` 改写
 *   `content`/`output`(如脱敏),但不允许 mutation 翻转 `success`——那属于
 *   审批语义,不是 postToolUse 的职责。
 */
const executeSingleToolCall = async (
  call: ToolCallRequest,
  ctx: ToolUseContext,
  parentStepId: string,
): Promise<ExecutedToolRecord> => {
  const preAction = await fireHook(ctx, "preToolUse", {
    tool: call.name,
    callId: call.id,
    arguments: call.arguments,
    parentStepId,
  });
  if (preAction?.type === "deny") {
    const reason = preAction.reason ?? "preToolUse hook 拒绝了该工具调用。";
    return {
      call,
      content: `工具调用已被 preToolUse hook 拒绝："${reason}"。请改用其它工具或直接回答用户。`,
      success: false,
      durationMs: 0,
      error: {
        code: "TOOL_LOOP_PRE_TOOL_USE_DENIED",
        message: reason,
        retryable: false,
      },
    };
  }
  const record = await executeSingleToolCallInner(
    call,
    ctx,
    parentStepId,
    preAction?.type === "approve",
  );
  const postAction = await fireHook(ctx, "postToolUse", {
    tool: call.name,
    callId: call.id,
    parentStepId,
    result: record,
  });
  if (postAction?.type === "mutate") {
    const candidate = postAction.data;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { content?: unknown }).content === "string"
    ) {
      return { ...record, content: (candidate as { content: string }).content };
    }
    ctx.observability.emit(
      engineEventFromContext(ctx.executionContext, {
        timestamp: Date.now(),
        phase: "tool-use",
        type: "warning",
        payload: {
          reason: "hook-mutation-rejected",
          point: "postToolUse",
          message: "postToolUse handler 返回的 mutation 不含合法 content 字段,已忽略。",
        },
      }),
    );
  }
  return record;
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
): { maxSteps: number; parallelism: number; failureRecoveryRetries: number } => {
  const toolLoop = config.runtime.toolLoop ?? {};
  return {
    maxSteps: toolLoop.maxSteps ?? 25,
    parallelism: toolLoop.parallelism ?? 4,
    failureRecoveryRetries: toolLoop.failureRecoveryRetries ?? 1,
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
 /** 本 step 内 Provider 直接返回的文生图 / 图像编辑产物(非流式一次性，流式已逐条累积)。 */
  images?: GeneratedImage[] | undefined;
 /** 本 step 内 Provider 直接返回的通用多模态产物(图片/音频/视频/文件)。 */
  media?: GeneratedMedia[] | undefined;
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
  const media: GeneratedMedia[] = [];

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
    } else if (part.type === "media") {
      media.push(part.media);
    }
  }

  toolCalls.push(...materializeDeltaToolCalls(partialToolCalls, completedToolCallIds));

  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    usage,
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
    ...(media.length > 0 ? { media } : {}),
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

/**
 * 内置 Task-style 工具名(ADR-0006 D6)。
 *
 * 命名对齐现有内置工具的 snake_case 惯例(`load_skill`/`read_skill_resource`/
 * `search_skills`),避免与业务工具撞名的同时也不引入新的命名风格。
 */
export const AGENT_DISPATCH_TOOL_NAME = "dispatch_agent";

const resolveAgentDispatchMaxDepth = (ctx: ToolUseContext): number => {
  const configured = ctx.config.runtime.toolLoop?.subagentDispatch?.maxDepth;
  return typeof configured === "number" && configured >= 0
    ? configured
    : DEFAULT_SUBAGENT_DISPATCH_MAX_DEPTH;
};

const buildAgentDispatchToolDefinition = (
  agents: ReadonlyArray<{ name: string; description: string }>,
): ToolDefinition => ({
  name: AGENT_DISPATCH_TOOL_NAME,
  description: [
    "Delegate a scoped, read-only, decomposable sub-task to a specialized sub-agent. The sub-agent runs its own tool-use loop with a read-only toolset and reports back only a summary (output + evidence), never its full transcript.",
    "Use this to parallelize research/investigation work that another agent is better scoped for. Do NOT use it for anything that needs to write or modify state — perform writes yourself in this loop (Single-Writer Rule).",
    "Available agents:",
    ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: agents.map((agent) => agent.name),
        description: "Registered agent name to dispatch.",
      },
      objective: {
        type: "string",
        description: "Clear, self-contained objective for the sub-agent to accomplish.",
      },
      input: {
        type: "object",
        description: "Optional structured input payload passed through to the sub-agent.",
        additionalProperties: true,
      },
    },
    required: ["agent", "objective"],
  },
});

/**
 * 若已注入 `ctx.dispatchAgent` 且深度未耗尽、registry 存在已注册 agent，
 * 则在给定工具列表末尾追加 `dispatch_agent`(幂等：已存在同名工具则不重复追加，
 * 业务自定义同名工具优先)。
 */
const appendAgentDispatchTool = (
  tools: ToolDefinition[],
  ctx: ToolUseContext,
): ToolDefinition[] => {
  if (!ctx.dispatchAgent) {
    return tools;
  }
  if (ctx.config.runtime.toolLoop?.subagentDispatch?.enabled === false) {
    return tools;
  }
  const depth = ctx.agentDispatchDepth ?? 0;
  if (depth >= resolveAgentDispatchMaxDepth(ctx)) {
    return tools;
  }
  if (tools.some((tool) => tool.name === AGENT_DISPATCH_TOOL_NAME)) {
    return tools;
  }
  const agents = ctx.registry
    .list("agent")
    .map((agent) => ({ name: agent.name, description: agent.description }));
  if (agents.length === 0) {
    return tools;
  }
  return [...tools, buildAgentDispatchToolDefinition(agents)];
};

const resolveToolDefinitions = (input: ToolUseInput, ctx: ToolUseContext): ToolDefinition[] => {
  const prebuilt = filterToolDefinitions(
    appendAgentDispatchTool(mergeInternalToolDefinitions(ctx.prebuiltPrompt.tools), ctx),
    input.toolNames,
  );
  if (prebuilt.length > 0) {
    return prebuilt;
  }
  return filterToolDefinitions(
    appendAgentDispatchTool(mergeInternalToolDefinitions(registryToolDefinitions(ctx)), ctx),
    input.toolNames,
  );
};

/**
 * 触发一个 loop-lifecycle Hook 点(ADR-0006 D2)。
 *
 * `ctx.hooks` 未注入时整体 no-op(向后兼容);注入时把 correlation/subject
 * 从 `ctx.executionContext` 透传给 `HookEvent`,保证下游 handler 能做审计关联。
 */
const fireHook = (
  ctx: ToolUseContext,
  point: HookPoint,
  data: unknown,
): Promise<HookAction | undefined> => {
  if (!ctx.hooks) {
    return Promise.resolve(undefined);
  }
  return ctx.hooks.fire(point, {
    point,
    timestamp: Date.now(),
    correlation: ctx.executionContext.correlation,
    ...(ctx.executionContext.subject !== undefined
      ? { subject: ctx.executionContext.subject }
      : {}),
    data,
  });
};

/**
 * Engine Seatbelt(ADR-0006 D3):校验 `preLLM`/`postLLM` mutation 后的
 * conversation 是否仍是合法的 Message[]。
 *
 * 只做结构化最小校验(非空数组、每条消息 role 合法、content 类型合法),
 * 不做协议级 tool_call/tool 配对深校验(那属于 Provider Adapter 职责)。
 * 校验失败时调用方应丢弃这次 mutation 并继续用 mutation 前的值,绝不能把
 * 畸形数据喂给 Provider。
 */
const isValidConversationMutation = (value: unknown): value is Message[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item): item is Message =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Message).role === "string" &&
      ["system", "user", "assistant", "tool"].includes((item as Message).role) &&
      (typeof (item as Message).content === "string" || Array.isArray((item as Message).content)),
  );

/**
 * 应用 `preLLM`/`postLLM` handler 返回的 `modify`/`replace` action。
 *
 * 未命中合法 mutation 形状时原样返回 `current`,并通过 observability 发一条
 * `warning`,而不是让引擎崩溃或喂给 Provider 畸形数据。
 */
const applyConversationMutation = (
  ctx: ToolUseContext,
  action: HookAction | undefined,
  current: Message[],
  point: HookPoint,
): Message[] => {
  if (!action) {
    return current;
  }
  const candidate = action.type === "mutate" ? action.data : undefined;
  if (candidate === undefined) {
    return current;
  }
  if (isValidConversationMutation(candidate)) {
    return candidate;
  }
  ctx.observability.emit(
    engineEventFromContext(ctx.executionContext, {
      timestamp: Date.now(),
      phase: "tool-use",
      type: "warning",
      payload: {
        reason: "hook-mutation-rejected",
        point,
        message: `${point} handler 返回的 mutation 不是合法的 Message[],已忽略。`,
      },
    }),
  );
  return current;
};

/**
 * Engine Seatbelt:校验 `postLLM` mutation 后的 response 是否仍是合法形状
 * (必须保留 `content: string`;`usage` 字段禁止被 mutation 覆盖,usage 统计
 * 只认 Provider 真值)。
 */
const isValidResponseMutation = (value: unknown): value is ToolUseStepResponse =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ToolUseStepResponse).content === "string";

/**
 * 应用 `postLLM` handler 返回的 `modify`/`replace` action 到 `response`。
 *
 * `usage` 恒以 mutation 前的 Provider 真值为准,防止 host mutation 污染计费/预算。
 */
const applyResponseMutation = (
  ctx: ToolUseContext,
  action: HookAction | undefined,
  current: ToolUseStepResponse,
): ToolUseStepResponse => {
  if (!action) {
    return current;
  }
  const candidate = action.type === "mutate" ? action.data : undefined;
  if (candidate === undefined) {
    return current;
  }
  if (isValidResponseMutation(candidate)) {
    return { ...current, ...candidate, usage: current.usage };
  }
  ctx.observability.emit(
    engineEventFromContext(ctx.executionContext, {
      timestamp: Date.now(),
      phase: "tool-use",
      type: "warning",
      payload: {
        reason: "hook-mutation-rejected",
        point: "postLLM",
        message: "postLLM handler 返回的 mutation 不含合法 content 字段,已忽略。",
      },
    }),
  );
  return current;
};

/**
 * per-step 上下文超阈值时的默认压缩策略(ADR-0006 D5,对齐 Claude Code 的
 * per-iteration `maybe_auto_compact`)。
 *
 * 只在 loop 自身追加的尾部(`seedLength` 之后)寻找**最老的一个完整**
 * assistant(带 toolCalls)+ 对应 tool 消息轮次并整体丢弃,替换为一条摘要
 * `system` 消息;每次最多丢一轮,避免一次性大幅改写对话、也给下一步
 * `preCompact` 复检的机会。找不到可丢的完整轮次时原样返回(不做半截截断,
 * 避免破坏 tool_call/tool 配对)。
 */
const compactConversationDefault = (conversation: Message[], seedLength: number): Message[] => {
  const tail = conversation.slice(seedLength);
  let dropStart = -1;
  let dropEnd = -1;
  for (let i = 0; i < tail.length; i += 1) {
    const msg = tail[i];
    if (msg && msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0) {
      let end = i + 1;
      while (end < tail.length && tail[end]?.role === "tool") {
        end += 1;
      }
      dropStart = i;
      dropEnd = end;
      break;
    }
  }
  if (dropStart === -1) {
    return conversation;
  }
  const droppedCount = dropEnd - dropStart;
  const summary: Message = {
    role: "system",
    content: `[context compacted]:已省略 ${droppedCount} 条较早的工具调用往返记录以控制上下文长度,结论已体现在后续消息中。`,
  };
  const head = conversation.slice(0, seedLength);
  const newTail = [...tail.slice(0, dropStart), summary, ...tail.slice(dropEnd)];
  return [...head, ...newTail];
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

  const { maxSteps, parallelism, failureRecoveryRetries } = resolveToolLoopLimits(ctx.config);
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
  let conversation: Message[] =
    ctx.prebuiltPrompt.messages.length > 0
      ? buildInitialMessages(input, ctx)
      : await buildFallbackMessages(input, ctx);
  const seedLength = conversation.length;
  const maxContextTokensForCompact =
    ctx.config.memory.maxContextTokens !== undefined && ctx.config.memory.maxContextTokens > 0
      ? ctx.config.memory.maxContextTokens
      : 128_000;

  ctx.observability.emit(
    engineEventFromContext(ctx.executionContext, {
      timestamp: Date.now(),
      phase: "tool-use",
      type: "loop_step_enter",
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
 // 失败恢复护栏累积状态：本轮是否出现过（非 approval-denied 的）工具失败、
 // 是否有过任何成功工具结果、以及已注入的强制恢复次数。
  let hadToolFailure = false;
  let hadToolSuccess = false;
  let recoveryInjections = 0;
  const failedToolNames: string[] = [];
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

// preCompact(ADR-0006 D5):per-step 复检上下文体量,超阈值时先给 host 一次
// `replace` mutation 的机会,host 未处理或 mutation 不合法时套用保守默认
// 压缩(丢最老一轮完整 assistant+tool 往返)。每 step 至多压一轮,压完仍超
// 阈值会在下一 step 再次触发,直到收敛或自然终止。
      const preCompactEstimatedTokens = await estimateMessagesTokens(
        adapter,
        conversation,
        route.model,
      );
      const preCompactThreshold = Math.floor(maxContextTokensForCompact * 0.85);
      if (preCompactEstimatedTokens > preCompactThreshold) {
        const compactAction = await fireHook(ctx, "preCompact", {
          conversation,
          step,
          stepId,
          estimatedTokens: preCompactEstimatedTokens,
          maxContextTokens: maxContextTokensForCompact,
          threshold: preCompactThreshold,
        });
        const beforeMutation = conversation;
        conversation = applyConversationMutation(ctx, compactAction, conversation, "preCompact");
        if (conversation === beforeMutation) {
          conversation = compactConversationDefault(conversation, seedLength);
        }
        ctx.observability.emit(
          engineEventFromContext(ctx.executionContext, {
            timestamp: Date.now(),
            phase: "tool-use",
            type: "warning",
            payload: {
              reason: "context-auto-compact",
              step,
              stepId,
              estimatedTokensBefore: preCompactEstimatedTokens,
              messageCountBefore: beforeMutation.length,
              messageCountAfter: conversation.length,
            },
          }),
        );
      }

// preLLM(ADR-0006 D2):free-mutation,受 Engine Seatbelt(D3)约束——mutation
// 后跑结构化 normalize,拒绝畸形数据流入 Provider。
      const preLlmAction = await fireHook(ctx, "preLLM", {
        conversation,
        step,
        stepId,
      });
      if (preLlmAction?.type === "deny") {
        const reason = preLlmAction.reason;
        emitStepEnd({
          step,
          stepId,
          success: false,
          reason: "preLLM-denied",
          failureReason: reason ?? "preLLM hook 拒绝了本次 LLM 调用",
        });
        emitFinal({ steps: step, stepId, success: false });
        const resultError = {
          code: "TOOL_LOOP_PRE_LLM_DENIED",
          message: reason ?? "preLLM hook 拒绝了本次 LLM 调用",
          retryable: false,
        };
        if (observations.length > 0) {
          return buildPartialResult(resultError);
        }
        throw EngineError.fromUnknown(new Error(resultError.message), "HOOK_EXECUTION_FAILED");
      }
      conversation = applyConversationMutation(ctx, preLlmAction, conversation, "preLLM");

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
// postLLM(ADR-0006 D2):free-mutation,受 Engine Seatbelt 约束——`usage` 恒以
// Provider 真值为准,不可被 mutation 篡改(计费/预算不能被 host 绕过)。
// 流式路径的正文已在 collectStreamedToolUseStep 内实时透传给用户,mutation
// 在此时机已无法“撤回”已展示内容,只影响回灌进 conversation 的历史与后续
// step 的上下文(仍有真实价值,例如脱敏)。
      const postLlmAction = await fireHook(ctx, "postLLM", { response, step, stepId });
      response = applyResponseMutation(ctx, postLlmAction, response);

      if (response.usage.totalTokens > 0) {
        usageTracker.final(response.usage);
      }
      ctx.onProviderUsage?.(response.usage);
// 文生图 / 通用多模态产物结构化透传(迁自已删除的 direct-answer.ts，ADR-0006
// C1)。流式路径的 media chunk 已在 collectStreamedToolUseStep 内累积进
// response.media(不逐条实时 fire，统一在 postLLM hook mutation 之后、本 step
// 收尾时一次性透传，确保 host mutation 有机会先行处理再交付)；非流式路径的
// images/media 则由 ChatResponse 直接携带。
      if (response.images && response.images.length > 0) {
        ctx.onGeneratedImages?.(response.images);
      }
      if (response.media && response.media.length > 0) {
        ctx.onGeneratedMedia?.(response.media);
      }

      if (!useStream) {
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
 // 失败恢复护栏：模型在「有过工具失败且零成功结果」时给出 terminal（放弃/编造），
 // 注入一条 system 纠错提示并强制再走一步，而非直接收下这份放弃稿。
 // 计入 maxSteps（自然被外层 for 上限约束），且至多注入 failureRecoveryRetries 次。
 // 覆盖非空 / 空 terminal 两种情况；对 sub-agent 同样生效（loop 共享）。
        if (
          hadToolFailure &&
          !hadToolSuccess &&
          recoveryInjections < failureRecoveryRetries
        ) {
          recoveryInjections += 1;
          const configuredPrompt = ctx.config.toolUse?.failureRecoveryPrompt;
          const recoveryPrompt =
            typeof configuredPrompt === "string" && configuredPrompt.trim().length > 0
              ? configuredPrompt
              : FAILURE_RECOVERY_PROMPT;
 // premature draft 记入 steps 保留 telemetry，再注入纠错提示驱动下一步。
          steps.push({ step, modelNotes: content, toolCalls: [] });
          conversation.push({ role: "system", content: recoveryPrompt });
          ctx.observability.emit(
            engineEventFromContext(ctx.executionContext, {
              timestamp: Date.now(),
              phase: "tool-use",
              type: "tool_loop_failure_recovery_injected",
              payload: {
                step,
                stepId,
                injection: recoveryInjections,
                failedTools: [...failedToolNames],
                ...(ctx.agentRunId !== undefined ? { agentRunId: ctx.agentRunId } : {}),
              },
            }),
          );
          emitStepEnd({
            step,
            stepId,
            success: false,
            reason: "failure-recovery-injected",
            stopReason: finishReason,
          });
          continue;
        }
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
// 失败恢复统计：approval-denied / preToolUse-denied 都是用户或宿主主动决定，
// 不算「标识符未知」类失败，不应触发「去调发现工具」的强制恢复。
        if (item.success) {
          hadToolSuccess = true;
        } else if (
          item.error?.code !== "TOOL_LOOP_APPROVAL_DENIED" &&
          item.error?.code !== "TOOL_LOOP_PRE_TOOL_USE_DENIED"
        ) {
          hadToolFailure = true;
          failedToolNames.push(item.call.name);
        }
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
  FAILURE_RECOVERY_PROMPT,
} as const;

export const __testing = {
  buildToolUseSystemPrompt,
  resolveToolDefinitions,
};
