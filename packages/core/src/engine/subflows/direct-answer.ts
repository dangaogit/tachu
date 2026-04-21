import type { EngineConfig, GeneratedImage, Message } from "../../types";
import type { ModelRoute } from "../../types/config";
import type { MemoryEntry, MemorySystem } from "../../modules/memory";
import type { ModelRouter } from "../../modules/model-router";
import { messagesNeedVision } from "../../utils/input-vision";
import type { ChatUsage, ProviderAdapter } from "../../modules/provider";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { AssembledPrompt } from "../../prompt/assembler";

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
  /** TraceId：与 Phase 3 的 traceId 保持一致以便追踪关联。 */
  traceId: string;
  /** SessionId：Memory 读入需要。 */
  sessionId: string;
  /**
   * 预组装好的 Prompt（由 `Engine.runStream` 经 PromptAssembler 真实组装而成）。
   *
   * 当此字段存在时，direct-answer 子流程优先使用其 `messages` 与 `tools` 直接调用
   * Provider.chat，无需再走 `buildDirectAnswerMessages` 的轻量历史拼装路径。
   */
  prebuiltPrompt?: AssembledPrompt;
  /**
   * Provider usage 回流回调（D1-LOW-04）。
   *
   * 由引擎主干注入：每次 Provider.chat 成功返回时调用一次，用于把真实 token 消耗
   * 汇回 `ExecutionOrchestrator`，让预算熔断与输出阶段拿到准确数据。
   */
  onProviderUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => void;
  /**
   * 流式正文分片回调（与 `config.runtime.streamingOutput` 及 Engine 注入配套）。
   */
  onAssistantDelta?: (text: string) => void;
  /**
   * 文生图响应的结构化图片回传（与 {@link OutputMetadata.generatedImages} 对齐）。
   *
   * 由 Engine 注入；当 Provider 返回的 `ChatResponse.images` 非空时调用一次，把
   * 列表累加到主干 `activeRunGeneratedImages` 里，最终由 `output` 阶段写入
   * `EngineOutput.metadata.generatedImages`。
   *
   * 为避免 streaming 的 finish 事件丢失 images，文生图路径（`input.textToImage === true`）
   * 强制走非流式 Provider.chat。
   */
  onGeneratedImages?: (images: GeneratedImage[]) => void;
}

/**
 * `direct-answer` Sub-flow 的调用输入。
 *
 * 由 Phase 5 规划阶段构造：
 *   - `prompt`：必填，来自 `IntentResult.intent` 或原始输入切片
 *   - `warn`：Phase 5 兜底路径置 true（complex 但无匹配工具），回复需坦诚说明
 *   - `hint`：可选追加指令（调整口吻 / 版式），当前为保留字段
 */
export interface DirectAnswerInput {
  prompt: string;
  warn?: boolean;
  hint?: string;
  /** 文生图：仅发 user 提示词到 `capabilityMapping["text-to-image"]`，不注入 direct-answer 长 system、不用预组装 Prompt。 */
  textToImage?: boolean;
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
const DIRECT_ANSWER_LLM_TIMEOUT_MS = 60_000;

/**
 * direct-answer Sub-flow 默认 System Prompt。
 *
 * 约束要点：
 *   - 强制自然语言 + Markdown，禁止 JSON 壳
 *   - 代码块必须 fenced + language 标签（CLI ANSI 渲染器依赖此）
 *   - `warn=true` 时坦诚说明"当前请求未匹配到工具"，再基于自身知识给出建议
 */
const DIRECT_ANSWER_SYSTEM_PROMPT = `你是 Tachu 引擎的"直接回答"子流程（内置 Sub-flow: direct-answer）。

### 你的职责
- 当意图分析判定本轮可由 LLM 单次回答，或没有匹配到合适的工具 / 多步规划时，
  你负责给出最终的自然语言答复。这是面向用户的正式回复，不是给下游代码的数据。

### 输出格式（必须遵守）
- 输出**自然语言 + Markdown**，不要再包任何 JSON 壳、不要写"已识别请求：xxx"模板、不要重复用户输入。
- 支持使用标题（#, ##）、粗体（**...**）、列表（-, 1.）、链接、表格。
- **所有代码必须使用 fenced 代码块并带 language 标签**（\`\`\`python / \`\`\`ts / \`\`\`bash / \`\`\`sql / \`\`\`json ...）。
- **禁止使用 4 空格缩进式代码块**（会丢失语法高亮）。
- 如果用户问候 / 闲聊，简短一两句即可；如果用户请求长文本产出（写代码、写教案、写文章），请完整写完。

### 绝对禁止（无论 warn 是否为 true）
- **禁止空头承诺**：严禁输出"我将…请稍等"、"让我先获取一下…"、"稍等我去查一下…"、
  "请等我读取文件后再告诉你"、"I'll fetch/check/look up … please wait" 这类**预告式**措辞。
  本轮没有下一轮、没有 await —— 整条响应就是最终答复，说了"稍等"就等于什么也没说。
- **禁止伪装已经执行了动作**：不要写"我已经抓取到该页面的内容如下……"、"根据我刚才打开的文件……"、
  "我已经跑了这条命令，输出是……" 这类**把"没做过的事"写成已完成**的句子。
- 如果用户请求需要你**实际抓取 URL / 读本地文件 / 运行命令 / 查询实时数据**，但本轮没有工具可用：
  1. 明确告诉用户"本轮未匹配到对应工具，无法真正执行该动作"；
  2. 基于自身的先验知识尽力回答（例如用户让你总结某个 URL，你可以凭训练语料里关于该站点 / 主题的知识作答），
     并**明确标注**"以下基于我对该主题的通用了解，不代表该 URL 的实时内容"；
  3. 建议一个下一步：让用户把网页正文 / 文件内容贴进来，或启用能抓取的工具。

### 警告态（warn=true，由宿主注入）
- 当宿主提示 warn=true 时，意味着引擎判定本次请求属于复杂任务但未找到可用的工具 / 多步规划。
- 请用 1–2 句简短说明"当前没有匹配到具体工具，以下是基于通用知识的建议回答"，然后再给出你能给出的最佳回答。
- 不要编造工具名 / 步骤编号 / 不存在的 API，不要假装自己真的执行了某个动作。

### 语言
- 如果用户使用中文，优先中文回复；否则跟随用户语言。`;

/**
 * MemoryEntry → Chat Message；仅保留 user / assistant / system。
 */
const memoryEntryToMessage = (entry: MemoryEntry): Message | null => {
  if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "system") {
    return null;
  }
  const content =
    typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
  return { role: entry.role, content };
};

/**
 * 组合取消信号 + 超时的复合 AbortSignal。
 *
 * 如果外部信号已 abort，直接透传，避免继续挂一个无意义的 setTimeout。
 */
const buildDirectAnswerAbortSignal = (outer: AbortSignal, timeoutMs: number): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`direct-answer LLM call timed out after ${timeoutMs}ms`));
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
 * 基于 PromptAssembler 预组装的 Prompt 生成 direct-answer 最终消息序列。
 *
 * 优先保留 assembler 产出的完整 messages（系统区 + 历史 + 召回 + 当前输入），
 * 再按 direct-answer 的附加约束（warn / hint）拼入补充指令。
 */
const buildDirectAnswerMessagesFromPrebuilt = (
  input: DirectAnswerInput,
  prebuilt: AssembledPrompt,
): Message[] => {
  const messages: Message[] = prebuilt.messages.map((message) => ({ ...message }));
  if (input.warn === true) {
    messages.push({
      role: "system",
      content:
        "[宿主提示] 本次请求被分类为复杂任务但未匹配到可用工具。请坦诚说明，然后给出基于通用知识的最佳回答。",
    });
  }
  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
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
  const messages: Message[] = [{ role: "system", content: DIRECT_ANSWER_SYSTEM_PROMPT }];

  try {
    const window = await ctx.memorySystem.load(ctx.sessionId);
    const history = window.entries
      .map(memoryEntryToMessage)
      .filter((m): m is Message => m !== null)
      .filter((m) => m.role !== "system")
      .slice(-DIRECT_ANSWER_HISTORY_LIMIT);
    for (const m of history) messages.push(m);
  } catch {
    // Memory 读取失败不阻塞；历史只是锦上添花。
  }

  const userPayload =
    input.warn === true
      ? `[宿主提示] 本次请求被分类为复杂任务，但未找到可用工具。请按 system 中的 warn=true 分支坦诚说明，然后给出基于通用知识的最佳回答。\n\n用户请求：\n${input.prompt}`
      : input.prompt;

  const lastIsCurrent =
    messages.length > 1 &&
    messages[messages.length - 1]?.role === "user" &&
    messages[messages.length - 1]?.content === userPayload;
  if (!lastIsCurrent) {
    messages.push({ role: "user", content: userPayload });
  }

  if (input.hint && input.hint.length > 0) {
    messages.push({ role: "system", content: `补充指令（来自宿主）：${input.hint}` });
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

const resolveTextToImageRoute = (router: ModelRouter): ModelRoute => {
  try {
    return router.resolve("text-to-image");
  } catch {
    try {
      return router.resolve("intent");
    } catch {
      return router.resolve("fast-cheap");
    }
  }
};

/**
 * 执行一次 direct-answer 调用，返回模型回复文本。
 *
 * 语义：
 *   1. 解析 `intent` → `fast-cheap` 能力路由
 *   2. 组合消息 + 合并 AbortSignal + 调 Provider.chat
 *   3. 任一异常透出（由调度器/TaskScheduler 负责映射为 TaskResult.failed）
 *
 * 可观测事件：
 *   - `llm_call_start`：phase=direct-answer
 *   - `llm_call_end`：phase=direct-answer，payload 含 usage / 是否命中 fast-cheap 回退
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

  const signal = buildDirectAnswerAbortSignal(ctx.signal, DIRECT_ANSWER_LLM_TIMEOUT_MS);
  const messages: Message[] =
    input.textToImage === true
      ? [{ role: "user", content: input.prompt.trim() }]
      : ctx.prebuiltPrompt && ctx.prebuiltPrompt.messages.length > 0
        ? buildDirectAnswerMessagesFromPrebuilt(input, ctx.prebuiltPrompt)
        : await buildDirectAnswerMessages(input, ctx);
  const route =
    input.textToImage === true
      ? resolveTextToImageRoute(ctx.modelRouter)
      : resolveDirectAnswerRoute(ctx.modelRouter, messages);
  const adapter = ctx.providers.get(route.provider);
  if (!adapter) {
    throw new Error(`direct-answer 路由到 provider ${route.provider}，但该 provider 未注册`);
  }
  const startedAt = Date.now();
  ctx.observability.emit({
    timestamp: startedAt,
    traceId: ctx.traceId,
    sessionId: ctx.sessionId,
    phase: "direct-answer",
    type: "llm_call_start",
    payload: {
      provider: adapter.id,
      model: route.model,
      messageCount: messages.length,
      warn: input.warn === true,
    },
  });

  try {
    // 文生图强制非流式：ChatStream 的 `finish` 事件不承载 `images`，走 chat() 才能
    // 从 ChatResponse.images 拿到结构化列表并透传给 onGeneratedImages。
    const useStream =
      input.textToImage !== true &&
      ctx.config.runtime.streamingOutput === true &&
      ctx.onAssistantDelta !== undefined;

    if (useStream) {
      let content = "";
      let usage: ChatUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      for await (const part of adapter.chatStream(
        { model: route.model, messages },
        signal,
      )) {
        if (part.type === "text-delta") {
          content += part.delta;
          ctx.onAssistantDelta?.(part.delta);
        } else if (part.type === "finish") {
          if (part.usage !== undefined) {
            usage = part.usage;
          }
        } else if (
          part.type === "tool-call-delta" ||
          part.type === "tool-call-complete"
        ) {
          throw new Error("direct-answer 流式响应不应包含 tool_call");
        }
      }
      ctx.onProviderUsage?.(usage);
      const trimmed = content.trim();
      ctx.observability.emit({
        timestamp: Date.now(),
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        phase: "direct-answer",
        type: "llm_call_end",
        payload: {
          provider: adapter.id,
          model: route.model,
          durationMs: Date.now() - startedAt,
          usage,
          empty: trimmed.length === 0,
        },
      });
      if (trimmed.length === 0) {
        throw new Error("direct-answer Provider 返回空内容");
      }
      return trimmed;
    }

    const response = await adapter.chat({ model: route.model, messages }, signal);
    // D1-LOW-04：真实 usage 回流。
    ctx.onProviderUsage?.(response.usage);
    // P1-1：文生图 / 图像编辑产物结构化透传到主干。
    if (response.images && response.images.length > 0) {
      ctx.onGeneratedImages?.(response.images);
    }
    const content = typeof response.content === "string" ? response.content.trim() : "";
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "direct-answer",
      type: "llm_call_end",
      payload: {
        provider: adapter.id,
        model: route.model,
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        empty: content.length === 0,
      },
    });
    if (content.length === 0) {
      throw new Error("direct-answer Provider 返回空内容");
    }
    return content;
  } catch (error) {
    ctx.observability.emit({
      timestamp: Date.now(),
      traceId: ctx.traceId,
      sessionId: ctx.sessionId,
      phase: "direct-answer",
      type: "warning",
      payload: {
        provider: adapter.id,
        model: route.model,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
};

export const DIRECT_ANSWER_CONSTANTS = {
  HISTORY_LIMIT: DIRECT_ANSWER_HISTORY_LIMIT,
  LLM_TIMEOUT_MS: DIRECT_ANSWER_LLM_TIMEOUT_MS,
  SYSTEM_PROMPT: DIRECT_ANSWER_SYSTEM_PROMPT,
} as const;
