import type { IntentResult, Message } from "../../types";
import type { ModelRoute } from "../../types/config";
import type { InputEnvelope } from "../../types/io";
import type { MemoryEntry } from "../../modules/memory";
import type { ModelRouter } from "../../modules/model-router";
import type { ProviderAdapter } from "../../modules/provider";
import { envelopeNeedsTextToImage, envelopeNeedsVision } from "../../utils/input-vision";
import { applyTextToImageHeuristicToEnvelope } from "../../utils/text-to-image-heuristic";
import type { SafetyPhaseOutput } from "./safety";
import type { PhaseEnvironment } from "./index";

/**
 * Intent LLM 调用的默认超时时间（毫秒）。
 *
 * 该值被故意设得短一些，因为 Phase 3 处于关键路径上 —— 每轮对话都会经过；
 * 如果 LLM 此处卡住，后面所有阶段都无法开始。超时后自动回退到启发式判断。
 */
const INTENT_LLM_TIMEOUT_MS = 30_000;

/**
 * Intent 阶段带入 LLM 的历史消息上限。
 *
 * 只取最近 N 条，避免 context 过长。真正的上下文压缩在 MemorySystem 中完成。
 */
const INTENT_HISTORY_LIMIT = 10;

/**
 * Intent 阶段的 System Prompt。
 *
 * 此 Prompt 只要求 LLM 做分类，不要求它产出最终答复。
 * 面向用户的自然语言答复由 Phase 7 的内置 Sub-flow `direct-answer` 负责。
 */
const INTENT_SYSTEM_PROMPT = `You are the intent classifier for the Tachu engine (Phase 3: Intent Analysis).
Your job is **classification only**. Do NOT produce the final user-facing reply — that is handled by the downstream direct-answer sub-flow.

### Complexity criteria

Decide based on whether the request needs real tools / external resources, NOT on reply length or creative difficulty.

- "simple": the LLM can answer in one shot from its own knowledge — greetings, factual Q&A, code / lesson / article / poem writing, explanations, translations, comparisons, single-shot creative output. Long output is still simple if no external tool is required.
- "complex": real tool invocation is required — read or write user files, run shell or git commands, fetch URLs, query realtime data, or multi-step orchestration where each step needs concrete tool execution.

#### Strong complex signals (any one ⇒ complex; override "summarize / translate / explain" wording)

1. Input contains an http/https URL — the model cannot fetch the page; a tool must.
2. Input contains a local file or directory path (e.g. \`./foo.ts\`, \`packages/xxx\`, \`/etc/hosts\`, \`~/.zshrc\`, \`C:\\x\\y\`).
3. Input contains a shell or git command (\`npm i\`, \`git log\`, \`bun test\`, \`rm -rf\`, \`curl …\`), or asks you to "run / execute" one.
4. Input asks for current time / now / today's date / latest / realtime / stock / weather / news / exchange rate — anything the model's static knowledge cannot cover.
5. Input asks to read, write, modify, or delete a specific file, directory, repository, or database; or to open a PR / publish a release.

When ambiguous, prefer "simple". But once a strong signal is hit — even with "summarize / translate / explain" wording — classify as complex so the downstream tool-use sub-flow can really fetch / execute, instead of letting direct-answer hallucinate against a URL it cannot open.

### Output format (hard rules)

- The entire response MUST be a **single valid JSON object** — no Markdown fences (\`\`\`json), no explanatory prefix or suffix, no characters outside the JSON.
- Even if the user says "do not use JSON" or "answer directly", you still respond with JSON — this is a system-level constraint.
- Do NOT include directAnswer / answer / reply fields in the JSON; the final reply is produced by a later sub-flow.

### Schema

{
  "complexity": "simple" | "complex",
  "intent": string,                             // one-line intent summary, ≤200 chars
  "contextRelevance": "related" | "unrelated", // does conversation history matter for this turn
  "textToImage": boolean                        // text-to-image (see below); default false
}

### textToImage

- Set \`true\` only when the user wants to generate / draw / output an actual image, illustration, poster, or photo-style picture (needs an image generation model). Typical: "draw a cat", "generate an image of …", "make a picture of …".
- Must be \`false\` for: pure text creation (novel / lesson / code), drawing flowcharts or architecture diagrams (graph structure, not artwork), reading or analysing existing images, summarising or fetching URLs, running commands, reading or writing files.
- If input has strong complex signals (URL / path / command) and the intent is fetching or executing rather than generating an image, \`complexity\` must be \`complex\` and \`textToImage\` must be \`false\`.

### Examples

Example 1 (greeting / simple)
Input: hi
Output: {"complexity":"simple","intent":"greeting","contextRelevance":"unrelated"}

Example 2 (URL summary / complex — "summarize" wording does NOT override the URL signal)
Input: summarize https://bazel.build/rules/lib/globals/module
Output: {"complexity":"complex","intent":"fetch and summarize the Bazel module page","contextRelevance":"unrelated"}

Example 3 (local file / complex)
Input: explain packages/core/src/engine/phases/intent.ts
Output: {"complexity":"complex","intent":"read and explain intent.ts","contextRelevance":"unrelated"}

Example 4 (text-to-image / simple + textToImage)
Input: generate an image of a small cat
Output: {"complexity":"simple","intent":"text-to-image: a small cat","contextRelevance":"unrelated","textToImage":true}

Respond in the same language as the latest user message; default to English when ambiguous.`;

/**
 * 强"simple"请求匹配正则。
 *
 * 触发场景：用户直白陈述"我需要/给我/help me/i need X"这类请求。
 * 这类请求**必定**归为 simple —— 即便长度 > 120 字、或包含"然后/并且"之类的弱 complex marker。
 *
 * 引入动机：
 *   LLM 失败降级到 `inferComplexityFallback` 时，仅凭"长度 + 弱关键词"判定，
 *   会把"i need a pig img"这类应当走 direct-answer 的请求错判为 complex，
 *   进而跑到"盲取前 N 个 tool"的 planning 分支、最终全失败走兜底。
 *   本正则作为"显式意图白名单"，优先级高于长度判定。
 */
const STRONG_SIMPLE_MARKERS: readonly RegExp[] = [
  /^\s*(?:我需要|我想要?|我要|给我|帮我|请帮我|请给我|能否|能不能|可以|麻烦)/u,
  /^\s*(?:i\s+need|i\s+want|i'?d\s+like|help\s+me|show\s+me|give\s+me|please\s+(?:give|help|show)|gimme|tell\s+me|can\s+you|could\s+you|would\s+you)\b/i,
  /^\s*(?:写|编写|生成|列出|翻译|解释|介绍|说说|讲讲|讲个|讲解|比较|对比|总结|写个)/u,
  /^\s*(?:write|generate|list|translate|explain|describe|compare|summarize|give)\b/i,
];

/**
 * 弱"complex"标记。
 *
 * 命中这些关键词 + 长度 > 120 字 且 **未命中**强 simple 标记时，才会判为 complex。
 * 弱 complex 关键词本身不足以推翻 STRONG_SIMPLE_MARKERS 的白名单结论。
 */
const WEAK_COMPLEX_MARKERS: readonly string[] = [
  "然后",
  "并且",
  "同时",
  "步骤",
  "拆分",
  "pipeline",
  "plan",
  "workflow",
  "多步",
  "先...再",
];

/**
 * 强"complex"信号：命中任一即 complex，**优先级高于 STRONG_SIMPLE_MARKERS**。
 *
 * 动机（回归根因）：
 *   "总结一下 https://example.com/xxx" 在旧规则下被 STRONG_SIMPLE_MARKERS 的 "总结"
 *   命中而判为 simple，进而走 direct-answer 子流程；LLM 无法真的抓取 URL，只能口头
 *   承诺"我将获取该页面的内容并进行总结，请稍等"，整个 turn 以空承诺收尾。
 *
 *   这里把"输入里含 URL / 本地路径 / 命令行指令"等**需要外部工具才能完成**的信号，
 *   单独提升为强 complex 标记，压倒"总结/翻译/解释/列出…"这类措辞白名单。
 */
const STRONG_COMPLEX_MARKERS: readonly RegExp[] = [
  // 任意 http(s) URL —— 让 tool-use 子流程去 fetch，而非 direct-answer 硬编。
  /\bhttps?:\/\/\S+/i,
  // Unix / POSIX 风格绝对路径或常见子路径（带显式扩展名）。
  /(?:^|[\s"'`(])(?:\.{1,2}\/|\/)[\w.\-/]+\.[a-z0-9]{1,8}\b/i,
  // 家目录前缀的 dotfile / 配置路径（~/.zshrc / ~/.config/xxx）
  /(?:^|[\s"'`(])~\/[\w.\-/]+/i,
  // 项目内目录约定（packages/xxx、src/xxx、app/xxx、lib/xxx、docs/xxx 等）
  /(?:^|[\s"'`(])(?:packages|apps|src|app|lib|docs|tests?|scripts|examples)\/[\w.\-/]+/i,
  // Windows 绝对路径（C:\x\y）
  /\b[a-zA-Z]:\\[\w\s.\-\\]+/,
  // shell/git/pkg 常见命令动词（"运行 / 执行 / 跑 + 命令"）
  /(?:运行|执行|跑一下|请跑|请执行)[\s：:]*[`"']?(?:git|npm|bun|yarn|pnpm|node|curl|wget|ls|cat|rm|cp|mv|mkdir|rg|grep|sed|awk|docker|kubectl|brew|apt|pip|uv|cargo)\b/i,
  // 英文命令触发
  /\b(?:run|exec|execute)\s+`?(?:git|npm|bun|yarn|pnpm|node|curl|wget|ls|cat|rm|cp|mv|mkdir|rg|grep|sed|awk|docker|kubectl|brew|apt|pip|uv|cargo)\b/i,
  // "读 / 打开 / 列出 xxx 文件或目录"动作
  /(?:读取?|打开|查看|列出|遍历|扫描|搜索)\s*(?:一下\s*)?(?:文件|目录|仓库|项目|代码库|日志|配置|数据库)/u,
  /\b(?:read|open|list|scan|search|traverse)\s+(?:the\s+)?(?:file|dir|directory|repo|repository|codebase|project|log|logs|config|db|database)\b/i,
  // 时效性信号：用户要的是"现在"的数据，LLM 静态知识覆盖不了。
  // 当前时间 / 日期是最短路径的 shell 工具任务，不能交给 direct-answer 静态回答。
  /(?:当前|现在|此刻|今天|今日).{0,12}(?:时间|日期|几点|几号)/u,
  /(?:时间|日期|几点|几号).{0,12}(?:当前|现在|此刻|今天|今日)/u,
  /^\s*(?:时间|日期|几点|几号|当前时间|当前日期)\s*$/u,
  /\b(?:current\s+(?:date|time)|date\s+now|time\s+now|what'?s\s+the\s+time|today'?s\s+date)\b/i,
  // 锚点词（今天/现在/最新…）与被查询对象（股价/天气/新闻…）之间允许 ≤20 字间隔（如"现在北京的天气"）。
  /(?:今天|今日|现在|实时|最新|此刻|本周|本月)[\s\S]{0,20}?(?:股价|股指|汇率|天气|气温|新闻|热搜|排名|价格|行情|比分|赛况|收盘|点位|指数)/u,
  /\b(?:today|now|current|realtime|real-?time|latest)\s+(?:\S+\s+){0,3}?(?:price|prices|stock|index|weather|temperature|news|ranking|rate|score|match)\b/i,
];

/**
 * 判断输入是否命中任一强 complex 标记。
 */
const hasStrongComplexMarker = (text: string): boolean =>
  STRONG_COMPLEX_MARKERS.some((pattern) => pattern.test(text));

/**
 * 关键词启发式复杂度判断（仅在 LLM 不可用时作为回退）。
 *
 * 判定顺序（自上而下）：
 *   1. 命中 STRONG_COMPLEX_MARKERS（URL/路径/命令/时效查询）→ 立即判 complex，
 *      压倒所有 simple 白名单措辞。
 *   2. 命中 STRONG_SIMPLE_MARKERS → 判 simple（不看长度、不看弱 complex）。
 *   3. 长度 > 120 字 或 命中弱 complex 关键词 → 判 complex。
 *   4. 其余 → simple（保守归类，避免错走工具链失败路径）。
 */
const inferComplexityFallback = (text: string): "simple" | "complex" => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "simple";

  // 最高优先级：任何"需要外部工具 / 实时数据"的信号一律 complex，
  // 压倒"总结/翻译/解释/列出…"这类白名单措辞。
  if (hasStrongComplexMarker(trimmed)) {
    return "complex";
  }

  // 其次：直白请求白名单（"我需要 X"/"i need X"/"讲个笑话"等），一律 simple。
  if (STRONG_SIMPLE_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return "simple";
  }

  const lower = trimmed.toLowerCase();
  if (
    trimmed.length > 120 ||
    WEAK_COMPLEX_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))
  ) {
    return "complex";
  }
  return "simple";
};

/**
 * MemoryEntry → ChatMessage 映射；仅保留文本内容。
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
 * 从 LLM 的原始响应里抽取 JSON 对象字符串。
 *
 * 宽容策略：
 *  1. 如果整段就是一个 JSON 对象 —— 直接解析。
 *  2. 如果包在 ```json ... ``` 围栏里 —— 剥围栏再解析。
 *  3. 如果 JSON 对象被其他文字包裹 —— 取第一对平衡括号内的内容。
 */
const extractJsonObject = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
};

/**
 * 解析 LLM 返回的内容为 IntentResult。
 *
 * 严格字段校验：
 *   - `complexity ∈ {simple, complex}`
 *   - `intent` 非空字符串（自动截断到 200 字符）
 *   - `contextRelevance ∈ {related, unrelated}`，缺省视为 `related`
 *   - `textToImage` 可选布尔；缺省视为未请求文生图
 *
 * 任一字段非法视为解析失败，返回 null 交由上层兜底。
 *
 * @returns 解析成功返回 IntentResult；解析失败返回 null（由上层回退到启发式）。
 */
/**
 * 多模态输入时优先解析 `vision` 能力路由（未配置则回退 `intent`）。
 */
const resolveIntentPhaseRoute = (router: ModelRouter, input: InputEnvelope): ModelRoute => {
  if (envelopeNeedsVision(input)) {
    try {
      return router.resolve("vision");
    } catch {
      /* `vision` 未在 capabilityMapping 中配置 */
    }
  }
  return router.resolve("intent");
};

const getIntentUserMessageContent = (input: InputEnvelope): Message["content"] => {
  const raw = input.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw as Message["content"];
  }
  return JSON.stringify(raw);
};

const flattenInputForIntentHeuristic = (input: InputEnvelope): string => {
  const raw = input.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    const text = raw
      .map((p) => {
        if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
          return typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
    return JSON.stringify(raw);
  }
  return JSON.stringify(raw);
};

const intentUserContentEquals = (a: Message["content"], b: Message["content"]): boolean => {
  if (a === b) {
    return true;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

const parseIntentJson = (raw: string): IntentResult | null => {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const complexity =
    obj.complexity === "simple" || obj.complexity === "complex" ? obj.complexity : null;
  const contextRelevance =
    obj.contextRelevance === "related" || obj.contextRelevance === "unrelated"
      ? obj.contextRelevance
      : "related";
  const intent = typeof obj.intent === "string" && obj.intent.trim().length > 0
    ? obj.intent.trim().slice(0, 200)
    : null;

  if (!complexity || !intent) return null;

  const textToImage = obj.textToImage === true ? true : undefined;

  return {
    complexity,
    intent,
    contextRelevance,
    ...(textToImage ? { textToImage: true } : {}),
  };
};

/**
 * 在信封上写入 `metadata.textToImage=true`（Intent LLM 或显式 CLI 已判定文生图）。
 */
const withTextToImageMetadata = (input: InputEnvelope): InputEnvelope => ({
  ...input,
  metadata: {
    ...input.metadata,
    modality: input.metadata?.modality ?? "text",
    textToImage: true,
  },
});

/**
 * 构造带超时保护的 AbortSignal；与阶段取消信号合并。
 *
 * 如果宿主已经取消（例如 last-message-wins 抢占），直接透传。
 * 否则叠加一个 timeoutMs 的自动超时。
 */
const buildIntentAbortSignal = (outer: AbortSignal, timeoutMs: number): AbortSignal => {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  outer.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`intent LLM call timed out after ${timeoutMs}ms`));
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
 * 组装要喂给 intent LLM 的 Message 列表：system + 最近 N 轮历史 + 本轮用户输入。
 */
const buildIntentMessages = async (
  state: SafetyPhaseOutput,
  env: PhaseEnvironment,
  userContent: Message["content"],
): Promise<Message[]> => {
  const messages: Message[] = [{ role: "system", content: INTENT_SYSTEM_PROMPT }];

  try {
    const window = await env.memorySystem.load(state.context.sessionId, env.adapterContext);
    const history = window.entries
      .map(memoryEntryToMessage)
      .filter((m): m is Message => m !== null)
      .filter((m) => m.role !== "system")
      .slice(-INTENT_HISTORY_LIMIT);
    for (const m of history) messages.push(m);
  } catch {
    // Memory 读取失败不阻塞 intent；历史只是锦上添花。
  }

  const lastIsCurrent =
    messages.length > 1 &&
    messages[messages.length - 1]?.role === "user" &&
    intentUserContentEquals(messages[messages.length - 1]!.content, userContent);
  if (!lastIsCurrent) {
    messages.push({ role: "user", content: userContent });
  }
  return messages;
};

/**
 * 发起一次 Intent LLM 调用，返回 IntentResult 或 null（交由上层回退）。
 */
const callIntentLLM = async (
  adapter: ProviderAdapter,
  model: string,
  messages: Message[],
  env: PhaseEnvironment,
  sessionId: string,
  traceId: string,
): Promise<IntentResult | null> => {
  const signal = buildIntentAbortSignal(env.activeAbortSignal, INTENT_LLM_TIMEOUT_MS);
  const startedAt = Date.now();
  env.observability.emit({
    timestamp: startedAt,
    traceId,
    sessionId,
    phase: "intent",
    type: "llm_call_start",
    payload: { provider: adapter.id, model, messageCount: messages.length },
  });

  try {
    const response = await adapter.chat({ model, messages }, env.adapterContext, signal);
    // D1-LOW-04：把真实 usage 回流到 orchestrator，以覆盖此前仅用 Prompt 估算 token 的逻辑。
    env.onProviderUsage?.(response.usage);
    const parsed = parseIntentJson(response.content);

    if (parsed) {
      env.observability.emit({
        timestamp: Date.now(),
        traceId,
        sessionId,
        phase: "intent",
        type: "llm_call_end",
        payload: {
          provider: adapter.id,
          model,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          parsed: true,
        },
      });
      return parsed;
    }

    // JSON 解析失败但 LLM 确实返回了文本：
    // 直接把文本摘要作为 intent.intent，并归类为 simple 交给 direct-answer 子流程重新生成答复。
    // 这样既保留了"尊重 LLM 有内容"的信号，又把"答复产出"责任交给语义统一的子流程，
    // 避免了"把分类器的口水当成最终答复"的反 UX 回归。
    const rawText = response.content.trim();
    env.observability.emit({
      timestamp: Date.now(),
      traceId,
      sessionId,
      phase: "intent",
      type: "llm_call_end",
      payload: {
        provider: adapter.id,
        model,
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        parsed: false,
        acceptedRawText: rawText.length > 0,
      },
    });
    if (rawText.length === 0) return null;
    return {
      complexity: "simple",
      intent: rawText.slice(0, 200),
      contextRelevance: "related",
    };
  } catch (error) {
    env.observability.emit({
      timestamp: Date.now(),
      traceId,
      sessionId,
      phase: "intent",
      type: "warning",
      payload: {
        provider: adapter.id,
        model,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        reason: "intent LLM call failed; falling back to heuristic",
      },
    });
    return null;
  }
};

/**
 * 阶段 3：意图分析。
 *
 * 流程：
 *  1. 从 `config.models.capabilityMapping.intent` 解析目标模型与 provider；
 *  2. 组装 system + 历史 + 当前输入 的 Message 列表；
 *  3. 调用 ProviderAdapter.chat 获取 LLM 响应；
 *  4. 解析 JSON 结果为 `IntentResult`；
 *  5. 任何一步失败（provider 未注册 / 调用抛错 / JSON 解析失败 / 被取消）都会
 *     回退到关键词启发式，并在 observability 中留下 warning。
 *
 * 该阶段始终返回 IntentResult —— 即使 LLM 不可用，也只会影响回答质量，不会阻塞主干。
 * Phase 3 只做分类，不产出用户答复；答复交由 Phase 7 的 direct-answer Sub-flow。
 */
export const runIntentPhase = async (
  state: SafetyPhaseOutput,
  env: PhaseEnvironment,
): Promise<SafetyPhaseOutput & { intent: IntentResult }> => {
  let working: SafetyPhaseOutput = { ...state };
  const contentForHeuristic = flattenInputForIntentHeuristic(working.input);

  /** CLI `/draw`、`--text-to-image` 等显式入口：跳过 Intent LLM，直接路由文生图。 */
  if (
    envelopeNeedsTextToImage(working.input) &&
    working.input.metadata?.explicitTextToImage === true
  ) {
    const intentText = contentForHeuristic.slice(0, 200);
    await env.runtimeState.update(working.context.sessionId, { currentPhase: "intent" });
    return {
      ...working,
      intent: {
        complexity: "simple",
        intent: intentText.length > 0 ? intentText : "text-to-image",
        contextRelevance: "related",
        textToImage: true,
      },
    };
  }

  // fast-path: 命中强 complex marker（URL / 路径 / 命令 / 时效查询等）→ 直接判 complex，跳过 intent LLM。
  // 这些信号本身就保证 LLM 不论怎么判都会被事后守护强制升级为 complex；提前短路可省一次 1.6k+ token 调用。
  if (hasStrongComplexMarker(contentForHeuristic)) {
    env.observability.emit({
      timestamp: Date.now(),
      traceId: working.context.traceId,
      sessionId: working.context.sessionId,
      phase: "intent",
      type: "progress",
      payload: { stage: "fast-path", reason: "strong-complex-marker" },
    });
    await env.runtimeState.update(working.context.sessionId, { currentPhase: "intent" });
    return {
      ...working,
      intent: {
        complexity: "complex",
        intent: contentForHeuristic.slice(0, 200),
        contextRelevance: "related",
      },
    };
  }

  // fast-path: 短输入命中强 simple marker 且不含强 complex → 直接 simple。
  // 限制长度 ≤ 40 是为了把短问候 / 单句请求和复杂多句任务区分开；后者即使命中
  // STRONG_SIMPLE_MARKERS 关键词，也可能是"先帮我列出 X 然后再做 Y…"这种多步任务，仍需 LLM 仔细分类。
  const trimmedHeuristic = contentForHeuristic.trim();
  if (
    trimmedHeuristic.length > 0 &&
    trimmedHeuristic.length <= 40 &&
    STRONG_SIMPLE_MARKERS.some((p) => p.test(trimmedHeuristic))
  ) {
    env.observability.emit({
      timestamp: Date.now(),
      traceId: working.context.traceId,
      sessionId: working.context.sessionId,
      phase: "intent",
      type: "progress",
      payload: { stage: "fast-path", reason: "strong-simple-short" },
    });
    await env.runtimeState.update(working.context.sessionId, { currentPhase: "intent" });
    return {
      ...working,
      intent: {
        complexity: "simple",
        intent: trimmedHeuristic.slice(0, 200),
        contextRelevance: "related",
      },
    };
  }

  let intent: IntentResult | null = null;

  try {
    const route = resolveIntentPhaseRoute(env.modelRouter, working.input);
    const adapter = env.providers.get(route.provider);
    if (adapter) {
      const messages = await buildIntentMessages(
        working,
        env,
        getIntentUserMessageContent(working.input),
      );
      intent = await callIntentLLM(
        adapter,
        route.model,
        messages,
        env,
        working.context.sessionId,
        working.context.traceId,
      );
    } else {
      env.observability.emit({
        timestamp: Date.now(),
        traceId: working.context.traceId,
        sessionId: working.context.sessionId,
        phase: "intent",
        type: "warning",
        payload: {
          reason: `provider "${route.provider}" not registered; intent LLM call skipped`,
          capability: envelopeNeedsVision(working.input) ? "vision" : "intent",
        },
      });
    }
  } catch (error) {
    env.observability.emit({
      timestamp: Date.now(),
      traceId: working.context.traceId,
      sessionId: working.context.sessionId,
      phase: "intent",
      type: "warning",
      payload: {
        reason: "intent capability routing failed; falling back to heuristic",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  if (intent) {
    const applyT2I =
      intent.textToImage === true &&
      !envelopeNeedsVision(working.input) &&
      !hasStrongComplexMarker(contentForHeuristic);
    if (applyT2I) {
      working = { ...working, input: withTextToImageMetadata(working.input) };
    } else if (intent.textToImage === true && hasStrongComplexMarker(contentForHeuristic)) {
      intent = { ...intent, textToImage: false };
      env.observability.emit({
        timestamp: Date.now(),
        traceId: working.context.traceId,
        sessionId: working.context.sessionId,
        phase: "intent",
        type: "warning",
        payload: {
          reason: "intent LLM set textToImage but input has strong complex markers; ignoring textToImage",
        },
      });
    }
  }

  if (!intent) {
    const heuristicInput = applyTextToImageHeuristicToEnvelope(working.input);
    const t2i = envelopeNeedsTextToImage(heuristicInput);
    intent = {
      complexity: inferComplexityFallback(contentForHeuristic),
      intent: contentForHeuristic.slice(0, 200),
      contextRelevance: "related",
      ...(t2i ? { textToImage: true as const } : {}),
    };
    if (t2i) {
      working = { ...working, input: heuristicInput };
    }
  } else if (
    intent.complexity === "simple" &&
    hasStrongComplexMarker(contentForHeuristic) &&
    !envelopeNeedsTextToImage(working.input) &&
    intent.textToImage !== true
  ) {
    // 事后守护：即便 LLM 判为 simple，只要输入里含 URL / 路径 / 命令 / 时效查询等
    // 必须外部工具才能解决的强信号，一律强制升级为 complex。防止 LLM 的措辞偏见
    // （如"总结一下 <URL>"被归为 simple）把请求卡在 direct-answer 的死胡同里，
    // 让后续 Phase 5 Planning 能据此路由到 tool-use 子流程。
    env.observability.emit({
      timestamp: Date.now(),
      traceId: working.context.traceId,
      sessionId: working.context.sessionId,
      phase: "intent",
      type: "warning",
      payload: {
        reason:
          "LLM classified as simple but input contains strong complex markers (url/path/command/realtime); upgrading to complex",
        originalComplexity: "simple",
      },
    });
    intent = { ...intent, complexity: "complex" };
  }

  await env.runtimeState.update(working.context.sessionId, { currentPhase: "intent" });
  return { ...working, intent };
};

/**
 * 导出供测试使用：强 complex 信号检测器。
 *
 * 生产路径不会直接调用它 —— 生产代码通过 `runIntentPhase` 内的守护分支使用。
 * 单测借此断言"URL/路径/命令"等边界输入的识别。
 */
export const __testing = {
  hasStrongComplexMarker,
  inferComplexityFallback,
};
