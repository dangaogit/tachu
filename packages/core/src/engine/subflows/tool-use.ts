import { ToolLoopError } from "../../errors";
import type {
  ChatFinishReason,
  ChatUsage,
  ProviderAdapter,
} from "../../modules/provider";
import type { ModelRouter } from "../../modules/model-router";
import type { MemorySystem, MemoryEntry } from "../../modules/memory";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { Registry } from "../../registry";
import type { AssembledPrompt } from "../../prompt/assembler";
import type {
  EngineConfig,
  ExecutionContext,
  Message,
  StreamChunk,
  TaskNode,
  ToolCallRecord,
  ToolCallRequest,
  ToolDefinition,
} from "../../types";
import type { TaskExecutor } from "../scheduler";

/**
 * `tool-use` 内置 Sub-flow 运行时上下文（ADR-0002）。
 *
 * 与 `DirectAnswerContext` 的差异：
 *   - 需要 `registry` 做 `ToolCallRequest.name → ToolDescriptor` 映射与白名单校验
 *   - 需要 `taskExecutor` 真正执行工具（复用主干 TaskExecutor，统一安全闸门与审批）
 *   - 需要 `executionContext` 以便在执行工具时把预算/权限/trace 信息透传下去
 *   - 新增 `onToolLoopEvent` 回调：把 loop-step / tool-call-start / tool-call-end 事件
 *     实时推给主干 `runStream`；未注入时等价于 no-op
 *   - 新增 `onToolCall` 回调：把 `ToolCallRecord` 汇回主干 metadata / orchestrator
 *   - `prebuiltPrompt` 在此为**必填**：tools 列表与 messages 都来自它
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
  traceId: string;
  sessionId: string;
  prebuiltPrompt: AssembledPrompt;
  onProviderUsage?: (usage: ChatUsage) => void;
  onToolLoopEvent?: (chunk: StreamChunk) => void;
  onToolCall?: (record: ToolCallRecord) => void;
  /**
   * 工具执行前的审批回调（ADR-0002 Stage 4）。
   *
   * 触发条件（二者满足其一）：
   *   1. 工具描述符 `requiresApproval === true`
   *   2. `config.runtime.toolLoop.requireApprovalGlobal === true`
   *
   * 返回 `"approve"` 继续执行；返回 `"deny"` 时跳过真实调用，合成一条
   * `tool` 角色消息（"用户拒绝"）追加进对话，让 LLM 感知到拒绝结果并据此
   * 给出替代方案。拒绝不计入 ToolLoopError，也不中止整条 loop。
   *
   * 未注入（undefined）时一律视作 `"approve"`，兼容旧宿主。
   */
  onBeforeToolCall?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

/**
 * 发给 `onBeforeToolCall` 的审批请求上下文（ADR-0002 Stage 4）。
 */
export interface ToolApprovalRequest {
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
  argumentsPreview: string;
  sideEffect: "readonly" | "write" | "irreversible";
  requiresApproval: boolean;
  triggeredBy: "descriptor" | "global";
  traceId: string;
  sessionId: string;
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
  hint?: string;
}

/**
 * 单次 Agentic Loop 调用 LLM 的超时（毫秒）。
 *
 * 比 direct-answer 的 60s 略宽：Agentic 任务通常需要模型做更多的"工具规划"
 * 思考。实际生效还受 `ctx.executionContext.budget.maxWallTimeMs` 约束。
 */
const TOOL_USE_LLM_TIMEOUT_MS = 90_000;

/**
 * 单次工具调用本身的最长等待（毫秒）。
 *
 * 该值是 **TaskExecutor 之上的软超时**——TaskScheduler 在主干已经按
 * `runtime.defaultTaskTimeoutMs` 给过一道超时；这里再做一次保险，防止下游
 * executor 未响应 AbortSignal 时把整条 loop 卡住。
 */
const TOOL_USE_TOOL_TIMEOUT_MS = 60_000;

/**
 * `tool-use` 默认 System Prompt。
 *
 * 写入要点：
 *   1. 明确循环语义：先给计划 → 调用工具 → 基于工具输出继续 → 给出最终自然语言回复
 *   2. 强调 **最终回复必须是自然语言 + Markdown**，不能是 JSON 或工具调用壳
 *   3. 强调工具失败时要自行修复或降级，不要反复请求同一失败工具
 */
const TOOL_USE_SYSTEM_PROMPT = `你是 Tachu 引擎的"Agentic 工具循环"子流程（内置 Sub-flow: tool-use）。

### 你的工作方式
- 你可以多轮调用系统提供的工具（Function Calling）。每次调用结束后，系统会把工具的真实输出以 \`tool\` 角色消息返回给你。
- 当你拿到足够信息时，请**不要再调用工具**，直接输出**自然语言 + Markdown** 的最终回复。

### 输出格式（最终回复，必须遵守）
- 自然语言 + Markdown；禁止 JSON 壳、禁止"已识别请求：xxx"模板。
- **所有代码使用 fenced 代码块并带 language 标签**（\`\`\`python / \`\`\`ts / \`\`\`bash / \`\`\`sql / \`\`\`json ...）。
- 支持标题（#, ##）、粗体、列表、链接、表格。
- 如果用户用中文，优先中文回复。

### 工具调用原则
- 优先调用最贴合任务的工具；参数要明确、具体。
- 单轮可以请求多个工具，但要避免无意义的重复调用（例如连续列同一目录）。
- 如果工具返回错误，先分析错误原因：
  - 参数非法 → 修正参数重试一次；
  - 工具不适用 → 换一个工具或直接给出基于已有信息的回答；
  - 重复失败 → 坦诚说明失败原因，不要无限重试。

### 终止条件
- 当你准备给最终答复时，**不要**再附带任何工具调用；只输出自然语言正文。
- 系统会限制你最多进行若干轮思考，超过限制会强制终止并报错。`;

/**
 * `tool-use` Sub-flow 对话历史中最多保留的近 N 条历史。
 *
 * Prebuilt prompt 已经包含本轮必需的消息；这里多保留一层做兜底（仅在
 * `prebuiltPrompt.messages` 为空的异常路径上使用）。
 */
const TOOL_USE_HISTORY_LIMIT = 10;

const memoryEntryToMessage = (entry: MemoryEntry): Message | null => {
  if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "system") {
    return null;
  }
  const content =
    typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
  return { role: entry.role, content };
};

/**
 * 组合外部 abort 与 LLM 超时的复合 Signal。
 */
const buildToolUseLlmSignal = (outer: AbortSignal, timeoutMs: number): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool-use LLM call timed out after ${timeoutMs}ms`));
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
 * 解析 `tool-use` 使用的能力路由：优先 `high-reasoning`，回退 `intent` → `fast-cheap`。
 *
 * 选择 `high-reasoning` 为首选是因为 Agentic Loop 里 LLM 需要决定"是否还要调工具"、
 * "选哪个工具"、"用什么参数"，这是典型的推理密集型任务，应当走更强的模型。
 */
const resolveToolUseRoute = (router: ModelRouter): { provider: string; model: string } => {
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
  const base = ctx.prebuiltPrompt.messages.map((m) => ({ ...m }));
  const hasSystem = base.some((m) => m.role === "system");
  const messages: Message[] = hasSystem
    ? [
        ...base.filter((m) => m.role === "system"),
        { role: "system", content: TOOL_USE_SYSTEM_PROMPT },
        ...base.filter((m) => m.role !== "system"),
      ]
    : [{ role: "system", content: TOOL_USE_SYSTEM_PROMPT }, ...base];
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
  }
  return messages;
};

/**
 * 当 `prebuiltPrompt.messages` 为空（极端路径：assembler 异常）时的兜底组装。
 */
const buildFallbackMessages = async (
  input: ToolUseInput,
  ctx: ToolUseContext,
): Promise<Message[]> => {
  const messages: Message[] = [{ role: "system", content: TOOL_USE_SYSTEM_PROMPT }];
  try {
    const window = await ctx.memorySystem.load(ctx.sessionId);
    const history = window.entries
      .map(memoryEntryToMessage)
      .filter((m): m is Message => m !== null)
      .filter((m) => m.role !== "system")
      .slice(-TOOL_USE_HISTORY_LIMIT);
    for (const m of history) messages.push(m);
  } catch {
    // Memory 读取失败不阻塞；历史只是锦上添花。
  }
  messages.push({ role: "user", content: input.prompt });
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
  }
  return messages;
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
const clipToolOutputForLlm = (text: string): string => {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  return `${head}\n\n... [工具输出已截断，完整长度 ${text.length} 字符]`;
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
const serializeToolOutput = (output: unknown): string => {
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
  return clipToolOutputForLlm(raw);
};

interface ExecutedToolRecord {
  call: ToolCallRequest;
  content: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

/**
 * 执行单个工具调用。
 *
 * 语义：
 *   1. 在 `registry` 中查 `call.name`，缺失 → 返回合成的 error content（让 LLM 自行修复）
 *   2. 构造 `TaskNode` 交给 `taskExecutor` 执行；签名与主干 TaskScheduler 使用相同
 *   3. 记录耗时与成功/失败；无论成功失败都会 emit tool-call-end 事件与 ToolCallRecord
 *
 * 不在本函数内做重试：重试策略由 LLM 自身掌握（它可以基于 error content 重新发起请求）。
 */
const executeSingleToolCall = async (
  call: ToolCallRequest,
  ctx: ToolUseContext,
): Promise<ExecutedToolRecord> => {
  const descriptor = ctx.registry.get("tool", call.name);
  ctx.onToolLoopEvent?.({
    type: "tool-call-start",
    callId: call.id,
    tool: call.name,
    argumentsPreview: previewArguments(call.arguments),
  });

  const startedAt = Date.now();
  if (!descriptor) {
    const message = `工具 "${call.name}" 未在 registry 中注册，无法执行。请换一个已注册的工具或直接回答。`;
    const durationMs = Date.now() - startedAt;
    ctx.onToolLoopEvent?.({
      type: "tool-call-end",
      callId: call.id,
      tool: call.name,
      success: false,
      durationMs,
      errorMessage: message,
      errorCode: "TOOL_LOOP_UNKNOWN_TOOL",
    });
    ctx.onToolCall?.({
      name: call.name,
      durationMs,
      success: false,
      errorCode: "TOOL_LOOP_UNKNOWN_TOOL",
    });
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "warning",
      payload: {
        reason: "unknown-tool",
        tool: call.name,
        callId: call.id,
      },
    });
    return {
      call,
      content: message,
      success: false,
      durationMs,
      errorMessage: message,
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
  const approvalNeeded = descriptorApproval || globalApproval;
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
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
    };
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "progress",
      payload: {
        stage: "approval-pending",
        tool: call.name,
        callId: call.id,
        triggeredBy,
        sideEffect: descriptor.sideEffect,
      },
    });
    let decision: ToolApprovalDecision;
    try {
      decision = await ctx.onBeforeToolCall(approvalRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      decision = { type: "deny", reason: `审批回调抛出异常：${message}` };
    }
    if (decision.type === "deny") {
      const reason = decision.reason?.trim().length
        ? decision.reason.trim()
        : "用户拒绝执行该工具。";
      const durationMs = Date.now() - startedAt;
      const content = `工具调用已被用户拒绝："${reason}"。请改用其它工具或直接回答用户，不要重复请求同一工具。`;
      ctx.onToolLoopEvent?.({
        type: "tool-call-end",
        callId: call.id,
        tool: call.name,
        success: false,
        durationMs,
        errorMessage: reason,
        errorCode: "TOOL_LOOP_APPROVAL_DENIED",
      });
      ctx.onToolCall?.({
        name: call.name,
        durationMs,
        success: false,
        errorCode: "TOOL_LOOP_APPROVAL_DENIED",
      });
      ctx.observability.emit({
        timestamp: Date.now(),
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        phase: "tool-use",
        type: "warning",
        payload: {
          reason: "approval-denied",
          tool: call.name,
          callId: call.id,
          triggeredBy,
        },
      });
      return { call, content, success: false, durationMs, errorMessage: reason };
    }
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "progress",
      payload: {
        stage: "approval-granted",
        tool: call.name,
        callId: call.id,
        triggeredBy,
      },
    });
    // 把"用户已明确授权本次调用"这个事实沿 TaskNode 往下带，宿主的
    // TaskExecutor 可据此豁免工作区沙箱等静态策略（用户已通过 argumentsPreview
    // 审阅过参数，包括任何路径字段）。
    toolTask.metadata = { ...(toolTask.metadata ?? {}), approvalGranted: true };
  }

  ctx.observability.emit({
    timestamp: startedAt,
    traceId: ctx.traceId,
    sessionId: ctx.sessionId,
    phase: "tool-use",
    type: "tool_call_start",
    payload: {
      tool: call.name,
      callId: call.id,
      argumentsPreview: previewArguments(call.arguments),
    },
  });

  try {
    const output = await ctx.taskExecutor(toolTask, toolCtx, toolSignal);
    const durationMs = Date.now() - startedAt;
    const content = serializeToolOutput(output);
    ctx.onToolLoopEvent?.({
      type: "tool-call-end",
      callId: call.id,
      tool: call.name,
      success: true,
      durationMs,
    });
    ctx.onToolCall?.({
      name: call.name,
      durationMs,
      success: true,
    });
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "tool_call_end",
      payload: {
        tool: call.name,
        callId: call.id,
        durationMs,
        outputLength: content.length,
      },
    });
    return { call, content, success: true, durationMs };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const content = `工具执行失败："${errorMessage}"。你可以调整参数后重试一次，或放弃该工具直接给出回答。`;
    ctx.onToolLoopEvent?.({
      type: "tool-call-end",
      callId: call.id,
      tool: call.name,
      success: false,
      durationMs,
      errorMessage,
      errorCode: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
    });
    ctx.onToolCall?.({
      name: call.name,
      durationMs,
      success: false,
      errorCode: "TOOL_LOOP_TOOL_EXECUTION_FAILED",
    });
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "warning",
      payload: {
        reason: "tool-execution-failed",
        tool: call.name,
        callId: call.id,
        durationMs,
        message: errorMessage,
      },
    });
    return { call, content, success: false, durationMs, errorMessage };
  }
};

/**
 * 按并发度 `parallelism` 执行一批工具调用。
 *
 * 保序：返回的 `ExecutedToolRecord[]` 与输入 `calls` 一一对应（即便内部分批并发）。
 */
const executeToolCallsBatch = async (
  calls: ToolCallRequest[],
  ctx: ToolUseContext,
  parallelism: number,
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
          results[myIndex] = await executeSingleToolCall(call, ctx);
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
    maxSteps: toolLoop.maxSteps ?? 8,
    parallelism: toolLoop.parallelism ?? 4,
  };
};

/**
 * Provider 返回的 finishReason 缺省规则：
 *   - 若有 toolCalls 且 finishReason 为空 → 视作 `tool_calls`
 *   - 若无 toolCalls 且 finishReason 为空 → 视作 `stop`
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

/**
 * 把 `tools` 列表映射为 Provider.chat 可接受的 ToolDefinition。
 *
 * 优先使用 `prebuiltPrompt.tools`（已由 PromptAssembler 做过 maxContextTokens 裁剪与
 * scope 过滤）；若为空则回退到 registry 直查。
 */
const resolveToolDefinitions = (ctx: ToolUseContext): ToolDefinition[] => {
  if (ctx.prebuiltPrompt.tools.length > 0) {
    return ctx.prebuiltPrompt.tools;
  }
  return ctx.registry.list("tool").map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
};

/**
 * 执行 Agentic Loop：LLM 思考 → 工具调用 → 观察结果 → ... → 最终文本回复。
 *
 * 约束：
 *   - 最多 `config.runtime.toolLoop.maxSteps` 轮（默认 8）
 *   - 单轮多工具并发上限 `config.runtime.toolLoop.parallelism`（默认 4）
 *   - 工具不存在时不直接失败，而是把错误作为 tool message 回给 LLM，让它自己修复
 *   - 工具执行失败同理——不中止整条 loop；让 LLM 决定下一步
 *
 * 成功返回：最终 LLM 给出的自然语言回复（已 trim）
 *
 * 失败抛错：
 *   - `TOOL_LOOP_STEPS_EXHAUSTED`：循环超过 maxSteps 仍未终止
 *   - `TOOL_LOOP_EMPTY_TERMINAL_RESPONSE`：finishReason=stop 但 content 空
 *   - `TOOL_LOOP_PROVIDER_NO_RESPONSE`：finishReason=stop 且 content 空 且没有任何 toolCalls
 */
export const executeToolUse = async (
  input: ToolUseInput,
  ctx: ToolUseContext,
): Promise<string> => {
  if (!input || typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new Error("tool-use 缺少必填字段 input.prompt");
  }

  const { maxSteps, parallelism } = resolveToolLoopLimits(ctx.config);
  const route = resolveToolUseRoute(ctx.modelRouter);
  const adapter = ctx.providers.get(route.provider);
  if (!adapter) {
    throw new Error(`tool-use 路由到 provider ${route.provider}，但该 provider 未注册`);
  }

  const tools = resolveToolDefinitions(ctx);
  const conversation: Message[] =
    ctx.prebuiltPrompt.messages.length > 0
      ? buildInitialMessages(input, ctx)
      : await buildFallbackMessages(input, ctx);

  ctx.observability.emit({
    timestamp: Date.now(),
    traceId: ctx.traceId,
    sessionId: ctx.sessionId,
    phase: "tool-use",
    type: "phase_enter",
    payload: {
      provider: adapter.id,
      model: route.model,
      toolCount: tools.length,
      maxSteps,
      parallelism,
    },
  });

  let finalContent: string | null = null;

  for (let step = 1; step <= maxSteps; step += 1) {
    if (ctx.signal.aborted) {
      throw new Error("tool-use 循环被外部取消");
    }
    ctx.onToolLoopEvent?.({ type: "tool-loop-step", step, maxSteps });
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "tool-use",
      type: "progress",
      payload: { step, maxSteps },
    });

    const llmSignal = buildToolUseLlmSignal(ctx.signal, TOOL_USE_LLM_TIMEOUT_MS);
    const llmStartedAt = Date.now();
    let response: Awaited<ReturnType<typeof adapter.chat>>;
    try {
      response = await adapter.chat(
        {
          model: route.model,
          messages: conversation,
          ...(tools.length > 0 ? { tools } : {}),
        },
        llmSignal,
      );
    } catch (error) {
      // Provider 抛错（典型：402 付费问题、401 key 失效、429 限流、超时等）
      // 必须先把原因 emit 到 observability，再把错误向上抛。否则 tool-use phase
      // 的 exit 事件不会落地，用户只能看到 output 阶段的通用 fallback 文案，
      // 很难从 `.tachu/events.jsonl` 或终端里定位到真正的根因。
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "UnknownError";
      ctx.observability.emit({
        timestamp: Date.now(),
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        phase: "tool-use",
        type: "warning",
        payload: {
          provider: adapter.id,
          model: route.model,
          step,
          durationMs: Date.now() - llmStartedAt,
          errorName,
          message: errorMessage,
          reason: "tool-use LLM call failed; aborting loop",
        },
      });
      ctx.onToolLoopEvent?.({
        type: "tool-loop-final",
        steps: step,
        success: false,
      });
      throw error;
    }
    ctx.onProviderUsage?.(response.usage);

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
    });

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      // 没有工具调用 → 视为最终回复。
      if (content.length > 0) {
        finalContent = content;
        ctx.observability.emit({
          timestamp: Date.now(),
          traceId: ctx.traceId,
          sessionId: ctx.sessionId,
          phase: "tool-use",
          type: "llm_call_end",
          payload: {
            step,
            terminal: true,
            finishReason,
            usage: response.usage,
          },
        });
        ctx.onToolLoopEvent?.({
          type: "tool-loop-final",
          steps: step,
          success: true,
        });
        break;
      }
      // content 为空：
      //   - 第一轮就空 → providerNoResponse（通常是接入问题）
      //   - 非首轮空 → emptyTerminalResponse（可重试）
      ctx.onToolLoopEvent?.({ type: "tool-loop-final", steps: step, success: false });
      if (step === 1) {
        throw ToolLoopError.providerNoResponse();
      }
      throw ToolLoopError.emptyTerminalResponse();
    }

    // 执行本轮 toolCalls，然后把 tool message 拼回对话继续下一轮。
    const batch = await executeToolCallsBatch(toolCalls, ctx, parallelism);
    for (const item of batch) {
      conversation.push({
        role: "tool",
        content: item.content,
        toolCallId: item.call.id,
        name: item.call.name,
      });
    }
  }

  if (finalContent === null) {
    ctx.onToolLoopEvent?.({
      type: "tool-loop-final",
      steps: maxSteps,
      success: false,
    });
    throw ToolLoopError.stepsExhausted(maxSteps);
  }
  return finalContent;
};

export const TOOL_USE_CONSTANTS = {
  LLM_TIMEOUT_MS: TOOL_USE_LLM_TIMEOUT_MS,
  TOOL_TIMEOUT_MS: TOOL_USE_TOOL_TIMEOUT_MS,
  SYSTEM_PROMPT: TOOL_USE_SYSTEM_PROMPT,
  HISTORY_LIMIT: TOOL_USE_HISTORY_LIMIT,
  MAX_TOOL_OUTPUT_CHARS,
} as const;
