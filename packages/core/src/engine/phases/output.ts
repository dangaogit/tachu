import type { EngineOutput, Message, OutputMetadata } from "../../types";
import type { ValidationPhaseOutput } from "./validation";
import type { PhaseEnvironment } from "./index";

/**
 * `task-direct-answer` 是 Phase 5 为兜底路径分配的固定任务 ID。
 * `task-tool-use` 是 Phase 5 为 Agentic Loop 分配的固定任务 ID（ADR-0002）。
 * Phase 9 据此从 taskResults 中提取最终答复内容。
 */
const DIRECT_ANSWER_TASK_ID = "task-direct-answer";
const TOOL_USE_TASK_ID = "task-tool-use";

/**
 * 主入口任务 ID —— 这些任务的输出会被直接作为 `EngineOutput.content`，不再套
 * 结构化 JSON 壳。
 *
 * 背景：`direct-answer` 与 `tool-use` 两个内置 Sub-flow 都是**完整的自然语言回复**，
 * 已经按系统提示词的约束产出了 Markdown 内容；主干不再重复包装。
 */
const NATURAL_LANGUAGE_TASK_IDS: readonly string[] = [
  DIRECT_ANSWER_TASK_ID,
  TOOL_USE_TASK_ID,
];

/**
 * 兜底答复 LLM 调用的超时（毫秒）。
 *
 * 有意设得紧：Phase 9 已经在失败路径上，再挂一个长调用等于把失败面放大。
 * 5s 足够短模型返回一段 100-200 字的友好答复。
 */
const FALLBACK_LLM_TIMEOUT_MS = 5_000;

/**
 * 兜底答复的最短可接受长度。
 *
 * 低于该值视为 LLM 空/半截输出，立即降级到本地模板。
 */
const FALLBACK_MIN_LENGTH = 30;

/**
 * 兜底答复 LLM 的 System Prompt。
 *
 * 硬约束：
 *   - 禁止提及内部术语（Phase / 子流程 / 路由 / capability / task-tool-N / task-tool-use / Tool / Agent 描述符）
 *   - 禁止编造"已执行 / 已调用 XX API"等假执行信号
 *   - 固定三段结构，80-200 字，中文输出
 *
 * 这些约束与 `sanitizeInternalTerms()` 双重保险：即使 LLM 不完全听话，
 * 后置正则过滤仍能把漏网术语降级掉。
 */
const FALLBACK_SYSTEM_PROMPT = `你是 Tachu 引擎的"兜底答复生成器"。本次引擎未能完整完成用户请求，需要你生成一段面向用户的友好中文答复。

### 硬约束
- **中文输出**，2-4 段共 80-200 字；直接输出正文，不要用 JSON 或代码块包裹。
- **严禁**提及 "Phase / 子流程 / 路由 / capability / task-tool-N / task-tool-use / Tool / Agent 描述符" 等内部术语。
- **严禁**编造"已执行 XX"、"调用了 XX API"、"已读取 XX 文件" 之类的假执行信号。
- 不要过度道歉（不要用"非常抱歉""万分抱歉"等），保持专业克制。

### 结构（三段，依次）
1. 一句简短承认本次未能如愿完成。
2. **基于用户意图，给出一段真正有价值的通用知识型回答或具体替代建议**（这是本段的核心价值，不可省略）。
3. 一句可行的下一步提示（改写请求 / 补充信息 / 使用其他渠道）。`;

/**
 * 内部术语黑名单。
 *
 * 兜底答复 LLM 输出与模板拼接后统一过一次 `sanitizeInternalTerms()`；
 * 命中即替换为用户侧可读词。任何新增的内部概念若可能泄漏到用户渲染路径，
 * 都应在此登记。
 */
const INTERNAL_TERMS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\btask-tool-\d+\b/gi, "某个内部步骤"],
  [/\btask-tool-use\b/gi, "工具循环"],
  [/\btask-direct-answer\b/gi, "兜底回答"],
  [/\bPhase\s*\d+\b/gi, "执行阶段"],
  [/direct-answer\s*子流程/gi, "兜底回答"],
  [/tool-use\s*子流程/gi, "工具循环"],
  [/capability\s*路由/gi, "能力路由"],
  [/Tool\s*\/\s*Agent\s*描述符/gi, "工具描述"],
];

/**
 * 二次脱敏：把残留的内部术语替换为用户侧可读词。
 *
 * LLM system prompt 已经明确禁用这些术语，但为防模型不听话，
 * 本函数作为 Output Phase 的**最后一道**屏蔽防线。
 */
export const sanitizeInternalTerms = (text: string): string => {
  let result = text;
  for (const [pattern, replacement] of INTERNAL_TERMS_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/**
 * 把 taskResult 转成可展示的字符串内容。
 *
 * direct-answer Sub-flow 执行成功时，Scheduler 记录的 `taskResult` 直接就是 LLM 返回的字符串。
 * 其它类型任务的 output 形状未定（占位实现是 `{ ref, input, output }`），此时 JSON.stringify 兜底。
 */
const stringifyTaskResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * 把 `state.input.content` 规范化为一段纯文本（供 fallback prompt 使用）。
 */
const extractInputText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
};

/**
 * 观测事件发射的安全包装。
 *
 * Phase 9 身处失败链路末端：任何 observability 异常（例如测试态下 env.observability
 * 被占位成 `{}`，或生产态下 emit 内部抛错）**不得**让 fallback 路径继续失败。
 * 此处统一 try/catch，确保 Phase 9 的降级路径绝对不会因观测而抛。
 */
const safeEmit = (
  env: PhaseEnvironment,
  event: Parameters<PhaseEnvironment["observability"]["emit"]>[0],
): void => {
  try {
    env.observability.emit(event);
  } catch {
    // Observability 不可用时静默忽略 —— fallback 路径的关键不变式是"不继续失败"。
  }
};

/**
 * 构造带超时保护的 AbortSignal；与阶段取消信号合并。
 *
 * 与 `intent.ts` / `direct-answer.ts` 同款实现。
 */
const buildFallbackAbortSignal = (outer: AbortSignal, timeoutMs: number): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`fallback summary LLM call timed out after ${timeoutMs}ms`));
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
 * 尝试用一次 LLM 调用生成友好兜底答复（Best-effort）。
 *
 * 失败语义：
 *   - Provider 未注册 / 能力路由失败 → 返回 null
 *   - LLM 调用抛错 / 超时 / 返回空 → 返回 null（仅 emit warning，不向上抛）
 *   - 调用成功但文本过短（< FALLBACK_MIN_LENGTH）→ 返回 null
 *   - 任何 null 都由 `ensureFallbackText` 回退到本地模板
 *
 * **不可**抛异常。Phase 9 已经在失败路径上，二次抛异常会让整个引擎调用栈 crash。
 */
const tryLLMFallbackSummary = async (
  state: ValidationPhaseOutput,
  env: PhaseEnvironment,
): Promise<string | null> => {
  let provider: string;
  let model: string;
  let adapter;
  try {
    const route = env.modelRouter.resolve("intent");
    adapter = env.providers.get(route.provider);
    provider = route.provider;
    model = route.model;
    if (!adapter) {
      safeEmit(env, {
        timestamp: Date.now(),
        traceId: state.context.traceId,
        sessionId: state.context.sessionId,
        phase: "output",
        type: "warning",
        payload: {
          purpose: "fallback-summary",
          reason: `provider "${provider}" not registered; skipping fallback LLM summary`,
        },
      });
      return null;
    }
  } catch (error) {
    safeEmit(env, {
      timestamp: Date.now(),
      traceId: state.context.traceId,
      sessionId: state.context.sessionId,
      phase: "output",
      type: "warning",
      payload: {
        purpose: "fallback-summary",
        reason: "model route resolve failed; skipping fallback LLM summary",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }

  const userInput = extractInputText(state.input.content).slice(0, 500);
  const intent = state.intent.intent;
  const failedCount = state.validation.diagnosis?.failedTaskIds?.length ?? 0;

  const userPrompt = `用户请求：${userInput}
识别到的意图：${intent}
执行过程中未成功完成的步骤数：${failedCount}

请按 system 中的硬约束生成兜底答复。`;

  const messages: Message[] = [
    { role: "system", content: FALLBACK_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const startedAt = Date.now();
  safeEmit(env, {
    timestamp: startedAt,
    traceId: state.context.traceId,
    sessionId: state.context.sessionId,
    phase: "output",
    type: "llm_call_start",
    payload: {
      provider: adapter.id,
      model,
      purpose: "fallback-summary",
      messageCount: messages.length,
    },
  });

  const signal = buildFallbackAbortSignal(env.activeAbortSignal, FALLBACK_LLM_TIMEOUT_MS);
  try {
    const response = await adapter.chat({ model, messages }, signal);
    env.onProviderUsage?.(response.usage);
    const raw = typeof response.content === "string" ? response.content.trim() : "";
    safeEmit(env, {
      timestamp: Date.now(),
      traceId: state.context.traceId,
      sessionId: state.context.sessionId,
      phase: "output",
      type: "llm_call_end",
      payload: {
        provider: adapter.id,
        model,
        purpose: "fallback-summary",
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        empty: raw.length === 0,
      },
    });
    if (raw.length < FALLBACK_MIN_LENGTH) return null;
    return sanitizeInternalTerms(raw);
  } catch (error) {
    safeEmit(env, {
      timestamp: Date.now(),
      traceId: state.context.traceId,
      sessionId: state.context.sessionId,
      phase: "output",
      type: "warning",
      payload: {
        provider: adapter.id,
        model,
        purpose: "fallback-summary",
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        reason: "fallback summary LLM call failed; falling back to template",
      },
    });
    return null;
  }
};

/**
 * 本地模板兜底 —— 不调任何外部依赖，保证 100% 可用。
 *
 * 文案只用用户侧可读词：
 *   - 不含 `Phase \d+` / `task-tool-*` / `task-tool-use` / `direct-answer 子流程` / `tool-use 子流程` / `capability 路由` / `Tool / Agent 描述符`
 *   - 不使用 code 字段
 *   - 结构：一句承认 + 可能原因 + 下一步建议
 */
const buildFallbackTemplate = (state: ValidationPhaseOutput): string => {
  const intent =
    typeof state.intent.intent === "string" && state.intent.intent.trim().length > 0
      ? state.intent.intent.trim()
      : "未能明确识别";
  const failedCount = state.validation.diagnosis?.failedTaskIds?.length ?? 0;
  const failedLine =
    failedCount > 0
      ? `执行过程中有 ${failedCount} 个步骤未成功完成。`
      : "当前引擎暂时无法直接完成这一请求。";

  return [
    `本次请求未能如愿完成（识别到的意图：${intent}）。${failedLine}`,
    "",
    "这通常是因为：",
    "- 当前引擎尚未接入能完整满足该请求的工具或外部服务；",
    "- 或者相关外部依赖出现了临时不可用。",
    "",
    "可以尝试的下一步：",
    '- 把请求改写得更具体。如只需要一段知识性答复（例如 "用 Python 写一个冒泡排序"），通常可以立即得到完整答案。',
    "- 若需要读取/写入本地文件、运行命令或联网查询，请确认对应的工具或集成已在配置中启用。",
    "- 稍后再试一次，外部服务的临时问题往往可自动恢复。",
  ].join("\n");
};

/**
 * 兜底答复总入口：先尝试 LLM best-effort summary，失败降级到本地模板。
 *
 * 契约（patch-01-fallback）：
 *   - 返回值长度必须 ≥ `FALLBACK_MIN_LENGTH`
 *   - 返回值必须已经过 `sanitizeInternalTerms`
 *   - **不得**向上抛异常
 */
export const ensureFallbackText = async (
  state: ValidationPhaseOutput,
  env: PhaseEnvironment,
): Promise<string> => {
  const llmText = await tryLLMFallbackSummary(state, env);
  if (llmText !== null && llmText.length >= FALLBACK_MIN_LENGTH) {
    return llmText;
  }
  return sanitizeInternalTerms(buildFallbackTemplate(state));
};

/**
 * 阶段 9：输出装配。
 *
 * `content` 选取策略（按优先级）：
 *   1. `taskResults` 中存在 `task-direct-answer` 或 `task-tool-use`（ADR-0002）
 *      的非空内容 → 直接使用（simple / Agentic Loop / complex-fallback 路径的常态）
 *   2. `validation.passed === true` → 结构化 JSON 输出（保留给无内置自然语言子流程的路径）
 *   3. `validation.passed === false` → `ensureFallbackText()` 产出的用户友好兜底文案
 *      （先 LLM best-effort，失败降级到本地模板；保证 ≥ 30 字 ∧ 无内部术语）
 */
export const runOutputPhase = async (
  state: ValidationPhaseOutput,
  env: PhaseEnvironment,
  metadata: OutputMetadata,
): Promise<EngineOutput> => {
  const naturalAnswer = ((): string => {
    for (const taskId of NATURAL_LANGUAGE_TASK_IDS) {
      const raw = state.taskResults[taskId];
      if (raw === undefined) continue;
      const text = stringifyTaskResult(raw).trim();
      if (text.length > 0) return text;
    }
    return "";
  })();

  let content: string;
  if (naturalAnswer.length > 0) {
    content = naturalAnswer;
  } else if (state.validation.passed) {
    content = JSON.stringify(
      {
        intent: state.intent.intent,
        taskResults: state.taskResults,
      },
      null,
      2,
    );
  } else {
    content = await ensureFallbackText(state, env);
  }

  const output: EngineOutput = {
    type: "text",
    content,
    status: state.validation.passed ? "success" : "partial",
    steps: state.steps,
    metadata,
    traceId: state.context.traceId,
    deliveryMode: "streaming",
  };
  await env.runtimeState.update(state.context.sessionId, { currentPhase: "output" });
  return output;
};
