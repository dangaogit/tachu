import type {
  EngineConfig,
  GeneratedImage,
  GeneratedMedia,
  Message,
} from "../../types";
import type { MultimodalResolver } from "../../types/multimodal-resolver";
import {
  chatWithResolvedMessages,
  streamChatWithResolvedMessages,
  resolveProviderDemand,
  emitResourceDegradations,
  type ResourceDemandRouter,
} from "../resolve-provider-messages";
import type { AdapterCallContext } from "../../types/context";
import type { ModelRoute } from "../../types/config";
import { memoryEntryToMessage, type MemoryEntry, type MemorySystem } from "../../modules/memory";
import type { ModelRouter } from "../../modules/model-router";
import { messagesNeedVision } from "../../utils/input-vision";
import type { ChatUsage, ProviderAdapter } from "../../modules/provider";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { AssembledPrompt } from "../../prompt/assembler";
import { stripTrailingCurrentTurn } from "../../prompt/turn-tail";
import { resolveSystemPromptBase } from "../../utils/system-prompt-base";
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
import { engineEventFromAdapterContext } from "../turn-outcome";

/**
 * `direct-answer` Sub-flow 执行所需的运行时上下文。
 *
 * 保持与引擎其它阶段一致的依赖形状：Provider 索引 + 能力路由 + 记忆读入 + 可观测事件。
 * 不引入对 Registry 的依赖是刻意的：内置 Sub-flow 的存在性由引擎在启动期保证，
 * 无需再次查询注册表。
 */
export interface DirectAnswerContext {
 /** 引擎配置，用于读取 contextTokenLimit / memory 归属等软参数。 */
  config: EngineConfig;
 /** Provider 索引（按 id 匹配）。 */
  providers: Map<string, ProviderAdapter>;
 /** 能力路由器，用于解析 `intent` / `fast-cheap` 标签。 */
  modelRouter: ModelRouter;
 /** 记忆系统，用于拼装近 N 条历史（与 Phase 3 同款）。 */
  memorySystem: MemorySystem;
 /** 可观测事件总线。 */
  observability: ObservabilityEmitter;
 /** Session 取消信号（last-message-wins 传播）。 */
  signal: AbortSignal;
 /** Provider / Memory 调用的租户与链路上下文。 */
  adapterContext: AdapterCallContext;
  multimodalResolver?: MultimodalResolver;
 /** Host 注入的 token 级需求路由；缺省全保真。 */
  resourceDemandRouter?: ResourceDemandRouter | undefined;
 /**
 * 预组装好的 Prompt（由 `Engine.runStream` 经 PromptAssembler 真实组装而成）。
 *
 * 当此字段存在时，direct-answer 子流程优先使用其 `messages` 与 `tools` 直接调用
 * Provider.chat，无需再走 `buildDirectAnswerMessages` 的轻量历史拼装路径。
 */
  prebuiltPrompt?: AssembledPrompt;
 /**
 * Provider usage 回流回调。
 *
 * 由引擎主干注入：每次 Provider.chat 成功返回时调用一次，用于把真实 token 消耗
 * 汇回 `ExecutionOrchestrator`，让预算熔断与输出阶段拿到准确数据。
 */
  onProviderUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => void;
  emitUsageTelemetry?: EmitLlmUsageTelemetry | undefined;
  currentPhaseStepId?: string | undefined;
  nextStreamId?: (() => string) | undefined;
 /**
 * 流式正文分片回调（与 `config.runtime.streamingOutput` 及 Engine 注入配套）。
 */
  onAssistantDelta?: (text: string) => void;
 /**
 * 模型 reasoning_content 流式分片回调。
 *
 * 触发条件：仅当 Provider 下发 `ChatStreamChunk.reasoning-delta`（流式）
 * 或 `ChatResponse.reasoningContent` 非空（非流式）时由本 sub-flow 调用。
 * 由 Engine 注入，回调内部应把片段 enqueue 到顶层 `StreamChunk.reasoning-delta`。
 *
 * 与 `onAssistantDelta` 严格分离：reasoning 仅用于 SSE 展示，不会被回灌
 * 为下一轮 LLM 上下文（DeepSeek 官方明确禁止 reasoning_content 回灌）。
 */
  onAssistantReasoningDelta?: (text: string) => void;
 /**
 * 文生图响应的结构化图片回传（与 {@link OutputMetadata.generatedImages} 对齐）。
 *
 * 由 Engine 注入；当 Provider 返回的 `ChatResponse.images` 非空时调用一次，把
 * 列表累加到主干 `activeRunGeneratedImages` 里，最终由 `output` 阶段写入
 * `EngineOutput.metadata.generatedImages`。
 */
  onGeneratedImages?: (images: GeneratedImage[]) => void;
 /**
 * 通用多模态产物回传（图片 / 音频 / 视频 / 文件）。
 */
  onGeneratedMedia?: (media: GeneratedMedia[]) => void;
}

/**
 * `direct-answer` Sub-flow 的调用输入。
 *
 * 由 Phase 5 规划阶段构造：
 * - `prompt`：必填，来自 `IntentResult.intent` 或原始输入切片
 * - `warn`：Phase 5 兜底路径置 true（complex 但无匹配工具），回复需坦诚说明
 * - `hint`：可选追加指令（调整口吻 / 版式），当前为保留字段
 */
export interface DirectAnswerInput {
  prompt: string;
  warn?: boolean;
  hint?: string;
}

/**
 * direct-answer Sub-flow 带入 LLM 的历史消息上限，与 Phase 3 保持一致。
 */
const DIRECT_ANSWER_HISTORY_LIMIT = 10;

/**
 * direct-answer Sub-flow 对单次 LLM 调用的超时保护（毫秒）。
 *
 * 比 Phase 3 的 30s 略长：因为这里真正承担"写完整答复"职责，允许模型输出更长。
 */
/**
 * direct-answer Sub-flow 默认 System Prompt。
 *
 * 约束要点：
 * - 强制自然语言 + Markdown，禁止 JSON 壳
 * - 代码块必须 fenced + language 标签（CLI ANSI 渲染器依赖此）
 * - `warn=true` 时坦诚说明"当前请求未匹配到工具"，再基于自身知识给出建议
 */
const DIRECT_ANSWER_SYSTEM_PROMPT = `You are the direct-answer sub-flow of the Tachu engine (built-in sub-flow: direct-answer).

### Role
- When intent analysis decides the turn can be answered by the LLM alone, or no matching tool / multi-step plan was found, you produce the final user-facing reply. This is the message the user reads, not data for downstream code.

### Output format
- Reply with **natural language + Markdown**. No JSON envelope, no "Identified request: xxx" template, no echoing of the user's input.
- Headings (#, ##), bold (**...**), lists (-, 1.), links, and tables are allowed.
- All code MUST use fenced code blocks with a language tag (\`\`\`python / \`\`\`ts / \`\`\`bash / \`\`\`sql / \`\`\`json …).
- The 4-space-indent code block style is forbidden — it loses syntax highlighting.
- For greetings / small talk, one or two short sentences is enough; for long-form output (code, lessons, articles), write the full thing.

### Absolutely forbidden (regardless of warn)
- **No empty promises**. Never write "I'll fetch …", "let me check …", "please hold on while I look this up", "我将…请稍等", "稍等我去查一下". This turn has no next turn, no \`await\` — saying "hold on" is the same as saying nothing.
- **No pretending you executed an action**. Do not write "I fetched the page and here is the content …", "based on the file I just opened …", "I ran this command and the output is …". Do not turn things you did not do into past-tense facts.
- If the request requires you to actually fetch a URL / read a local file / run a command / query realtime data but no tool is available this turn:
  1. Tell the user plainly that no matching tool was available this turn and the action could not really be executed.
  2. Answer from your prior knowledge as best you can (e.g. for a URL summary, use what your training data already knows about that site / topic), and **explicitly label** the answer as based on general knowledge rather than the live content of the URL.
  3. Suggest a next step — paste the page text or file content, or enable a tool that can fetch it.

### Warning state (warn=true, injected by the host)
- When the host hints \`warn=true\`, the engine has classified this request as complex but found no usable tool or multi-step plan.
- Use 1–2 short sentences to acknowledge that no matching tool was found, then provide the best knowledge-based answer you can give.
- Do not invent tool names, step numbers, or non-existent APIs, and do not pretend to have executed any action.

Respond in the same language as the latest user message; default to English when ambiguous.`;

const resolveDirectAnswerSystemPrompt = (config: EngineConfig): string =>
  resolveSystemPromptBase(config.directAnswer?.systemPromptBase, DIRECT_ANSWER_SYSTEM_PROMPT);

/**
 * 基于 PromptAssembler 预组装的 Prompt 生成 direct-answer 最终消息序列。
 *
 * 优先保留 assembler 产出的完整 messages（系统区 + 历史 + 召回 + 当前输入），
 * 再按 direct-answer 的附加约束（warn / hint）拼入补充指令。
 */
const buildDirectAnswerMessagesFromPrebuilt = (
  input: DirectAnswerInput,
  prebuilt: AssembledPrompt,
  config: EngineConfig,
): Message[] => {
  const base = prebuilt.messages.map((message) => ({ ...message }));
  const phaseSystem: Message = {
    role: "system",
    content: resolveDirectAnswerSystemPrompt(config),
  };
  const hasSystem = base.some((m) => m.role === "system");
  const messages: Message[] = hasSystem
    ? [
        ...base.filter((m) => m.role === "system"),
        phaseSystem,
        ...base.filter((m) => m.role !== "system"),
      ]
    : [phaseSystem, ...base];
  if (input.warn === true) {
    messages.push({
      role: "system",
      content:
        "[Host hint] This request was classified as complex but no matching tool was found. Acknowledge briefly then give a knowledge-based answer.",
    });
  }
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `[Host hint] Additional instruction: ${input.hint}` });
  }
  return messages;
};

/**
 * 组装消息序列：system + 最近 N 条历史 + 本轮 prompt。
 *
 * 与 Phase 3 共用同一套 history 截断规则，确保"分类到答复"的上下文同构。
 */
const buildDirectAnswerMessages = async (
  input: DirectAnswerInput,
  ctx: DirectAnswerContext,
): Promise<Message[]> => {
  const messages: Message[] = [
    { role: "system", content: resolveDirectAnswerSystemPrompt(ctx.config) },
  ];

  const userPayload =
    input.warn === true
      ? `[Host hint] This request was classified as complex but no matching tool was found. Per system prompt warn=true branch, acknowledge briefly then provide best-effort knowledge-based answer.\n\nUser request:\n${input.prompt}`
      : input.prompt;

  try {
    const window = await ctx.memorySystem.load(
      ctx.adapterContext.correlation.sessionId,
      ctx.adapterContext,
    );
    const history = window.entries
      .map(memoryEntryToMessage)
      .filter((m): m is Message => m !== null)
      .filter((m) => m.role !== "system")
      .slice(-DIRECT_ANSWER_HISTORY_LIMIT);
 // Session 阶段已把本轮 user 写入 memory，剥尾避免双发。
 // 注意：当 warn=true 时 userPayload 与 memory 里那条原始 user 不等，剥不掉是预期 ——
 // 这是把 host hint 注入提示的正常路径，模型应看到原始 user + 带 hint 的 user 各一份。
    const trimmed = stripTrailingCurrentTurn(history, userPayload);
    for (const m of trimmed) messages.push(m);
  } catch {
 // Memory 读取失败不阻塞；历史只是锦上添花。
  }

  messages.push({ role: "user", content: userPayload });

  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `[Host hint] Additional instruction: ${input.hint}` });
  }
  return messages;
};

/**
 * 解析 ModelRoute：若消息含图像等多模态块则优先 `vision`，否则优先 `intent`，再回退 `fast-cheap`。
 *
 * @throws 当 `intent` 与 `fast-cheap` 均未注册时，把错误向上抛出，由调用方决定降级路径。
 */
const resolveDirectAnswerRoute = (
  router: ModelRouter,
  messages: Message[],
): ModelRoute => {
  if (messagesNeedVision(messages)) {
    try {
      return router.resolve("vision");
    } catch {
      /* vision 未配置 */
    }
  }
  try {
    return router.resolve("intent");
  } catch {
    return router.resolve("fast-cheap");
  }
};

/**
 * 执行一次 direct-answer 调用，返回模型回复文本。
 *
 * 语义：
 * 1. 解析 `intent` → `fast-cheap` 能力路由
 * 2. 组合消息 + 合并 AbortSignal + 调 Provider.chat
 * 3. 任一异常透出（由调度器/TaskScheduler 负责映射为 TaskResult.failed）
 *
 * 可观测事件：
 * - `llm_call_start`：phase=direct-answer
 * - `llm_call_end`：phase=direct-answer，payload 含 usage / 是否命中 fast-cheap 回退
 *
 * @returns 模型回复（已 trim）；若模型返回空串，由调用方处理
 */
export const executeDirectAnswer = async (
  input: DirectAnswerInput,
  ctx: DirectAnswerContext,
): Promise<string> => {
  if (!input || typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new Error("direct-answer 缺少必填字段 input.prompt");
  }

  const llmTimeouts = resolveLlmTimeouts(ctx.config, "direct-answer");
  const messages: Message[] =
    ctx.prebuiltPrompt && ctx.prebuiltPrompt.messages.length > 0
      ? buildDirectAnswerMessagesFromPrebuilt(input, ctx.prebuiltPrompt, ctx.config)
      : await buildDirectAnswerMessages(input, ctx);
  const route = resolveDirectAnswerRoute(ctx.modelRouter, messages);
  const adapter = ctx.providers.get(route.provider);
  if (!adapter) {
    throw new Error(`direct-answer 路由到 provider ${route.provider}，但该 provider 未注册`);
  }
  const startedAt = Date.now();
  ctx.observability.emit(engineEventFromAdapterContext(ctx.adapterContext, {
    timestamp: startedAt,
    phase: "direct-answer",
    type: "llm_call_start",
    payload: {
      provider: adapter.id,
      model: route.model,
      messageCount: messages.length,
      warn: input.warn === true,
    },
  }));

  let activeBudgetSignal: AbortSignal | undefined;
  let usageTracker: LlmUsageTracker | undefined;
  try {
    const usageAttributionId =
      ctx.nextStreamId?.() ?? `${ctx.adapterContext.correlation.traceId}:direct-answer:${startedAt}`;
    usageTracker = createLlmUsageTracker({
      attribution: {
        id: usageAttributionId,
        kind: "llm_call",
        ...(ctx.currentPhaseStepId !== undefined
          ? { parentId: ctx.currentPhaseStepId }
          : {}),
        label: "direct-answer",
        meta: {
          phase: "execution",
          subflow: "direct-answer",
          provider: adapter.id,
          model: route.model,
        },
      },
      estimatedInputTokens: await estimateMessagesTokens(adapter, messages, route.model),
      emit: ctx.emitUsageTelemetry,
    });
    usageTracker.start();

    const useStream =
      ctx.config.runtime.streamingOutput === true &&
      ctx.onAssistantDelta !== undefined;

    const demand = await resolveProviderDemand(ctx.resourceDemandRouter, {
      adapter,
      model: route.model,
      unit: "direct-answer",
      phase: "direct-answer",
      messages,
    });

    if (useStream) {
      const streamAbort = createLlmStreamAbortController(ctx.signal, llmTimeouts);
      activeBudgetSignal = streamAbort.signal;
      let content = "";
      let usage: ChatUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      try {
        for await (const part of streamChatWithResolvedMessages(
          adapter,
          { model: route.model, messages },
          ctx.adapterContext,
          ctx.multimodalResolver,
          streamAbort.signal,
          demand,
          (degradations) =>
            emitResourceDegradations(
              ctx.observability,
              ctx.adapterContext,
              "direct-answer",
              "direct-answer",
              degradations,
            ),
        )) {
          if (part.type === "text-delta") {
            if (part.delta.length > 0) {
              streamAbort.markFirstOutput();
            }
            content += part.delta;
            usageTracker?.addOutputDelta(part.delta);
            ctx.onAssistantDelta?.(part.delta);
          } else if (part.type === "reasoning-delta") {
 // reasoning 不进 `content`，不参与下一轮上下文回灌；仅透传给 SSE 通道。
            if (part.delta.length > 0) {
              usageTracker?.addOutputDelta(part.delta);
              ctx.onAssistantReasoningDelta?.(part.delta);
            }
          } else if (part.type === "finish") {
            if (part.usage !== undefined) {
              usage = part.usage;
            }
          } else if (part.type === "media") {
            ctx.onGeneratedMedia?.([part.media]);
          } else if (
            part.type === "tool-call-delta" ||
            part.type === "tool-call-complete"
          ) {
            throw new Error("direct-answer 流式响应不应包含 tool_call");
          }
        }
      } finally {
        streamAbort.dispose();
      }
      if (usage.totalTokens > 0) {
        usageTracker?.final(usage);
      }
      ctx.onProviderUsage?.(usage);
      const trimmed = content.trim();
      ctx.observability.emit(engineEventFromAdapterContext(ctx.adapterContext, {
        timestamp: Date.now(),
        phase: "direct-answer",
        type: "llm_call_end",
        payload: {
          provider: adapter.id,
          model: route.model,
          durationMs: Date.now() - startedAt,
          usage,
          empty: trimmed.length === 0,
        },
      }));
      if (trimmed.length === 0) {
        throw new Error("direct-answer Provider 返回空内容");
      }
      return trimmed;
    }

    const signal = buildLlmCallAbortSignal(
      ctx.signal,
      llmTimeouts.llmStreamingMs,
      "streaming",
    );
    activeBudgetSignal = signal;
    const chatResult = await chatWithResolvedMessages(
      adapter,
      { model: route.model, messages },
      ctx.adapterContext,
      ctx.multimodalResolver,
      signal,
      demand,
    );
    if (!chatResult.ok) {
      return chatResult.userVisibleReason;
    }
    emitResourceDegradations(
      ctx.observability,
      ctx.adapterContext,
      "direct-answer",
      "direct-answer",
      chatResult.degradations,
    );
    const response = chatResult.response;
    usageTracker.final(response.usage);
 // 真实 usage 回流。
    ctx.onProviderUsage?.(response.usage);
 // 文生图 / 图像编辑产物结构化透传到主干。
    if (response.images && response.images.length > 0) {
      ctx.onGeneratedImages?.(response.images);
    }
    if (response.media && response.media.length > 0) {
      ctx.onGeneratedMedia?.(response.media);
    }
 // 非流式路径下，模型 reasoning_content（若有）一次性透传给 SSE 通道；
 // 与流式路径在 `onAssistantReasoningDelta` 回调上对齐。
    if (
      typeof response.reasoningContent === "string" &&
      response.reasoningContent.length > 0
    ) {
      usageTracker.addOutputDelta(response.reasoningContent);
      ctx.onAssistantReasoningDelta?.(response.reasoningContent);
    }
    const content = typeof response.content === "string" ? response.content.trim() : "";
    ctx.observability.emit(engineEventFromAdapterContext(ctx.adapterContext, {
      timestamp: Date.now(),
      phase: "direct-answer",
      type: "llm_call_end",
      payload: {
        provider: adapter.id,
        model: route.model,
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        empty: content.length === 0,
      },
    }));
    if (content.length === 0) {
      throw new Error("direct-answer Provider 返回空内容");
    }
    return content;
  } catch (error) {
    const budgetTimeout = activeBudgetSignal
      ? isBudgetTimeoutAbort(activeBudgetSignal)
      : null;
    if (budgetTimeout) {
      usageTracker?.terminal("failed");
      throw budgetTimeout;
    }
    usageTracker?.terminal(ctx.signal.aborted ? "cancelled" : "failed");
    ctx.observability.emit(engineEventFromAdapterContext(ctx.adapterContext, {
      timestamp: Date.now(),
      phase: "direct-answer",
      type: "warning",
      payload: {
        provider: adapter.id,
        model: route.model,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    throw error;
  }
};

export const DIRECT_ANSWER_CONSTANTS = {
  HISTORY_LIMIT: DIRECT_ANSWER_HISTORY_LIMIT,
  SYSTEM_PROMPT: DIRECT_ANSWER_SYSTEM_PROMPT,
} as const;

export const __testing = {
  resolveDirectAnswerSystemPrompt,
  buildDirectAnswerMessagesFromPrebuilt,
};
