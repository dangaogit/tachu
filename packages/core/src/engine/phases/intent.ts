import type { IntentResult, IntentTurnPolicyLlmOutput, Message, ToolDescriptor } from "../../types";
import type { ModelRoute } from "../../types/config";
import type { InputEnvelope } from "../../types/io";
import type { ResourceReference } from "../../types/resource";
import type { SessionScope } from "../../types/scope";
import { memoryEntryToMessage } from "../../modules/memory";
import type { ModelRouter } from "../../modules/model-router";
import type { ProviderAdapter } from "../../modules/provider";
import { BudgetExhaustedError } from "../../errors";
import { redactResourcesForIntent } from "../../utils/intent-resource-redaction";
import { resolveSystemPromptBase } from "../../utils/system-prompt-base";
import type { SafetyPhaseOutput } from "./safety";
import type { PhaseEnvironment } from "./index";
import {
  normalizeTurnPolicy,
  readTurnPolicy,
  withTurnPolicyMetadata,
} from "../turn-policy";
import {
  buildLlmCallAbortSignal,
  isBudgetTimeoutAbort,
  resolveLlmTimeouts,
} from "../llm-timeouts";
import {
  createLlmUsageTracker,
  estimateMessagesTokens,
} from "../llm-usage-telemetry";
import { engineEventFromAdapterContext, engineEventFromContext } from "../turn-outcome";
import { stripTrailingCurrentTurn } from "../../prompt/turn-tail";
import { NameMatchToolCandidateStrategy } from "../tool-activation";

/**
 * Intent LLM 调用的默认超时时间（毫秒）。
 *
 * 该值被故意设得短一些，因为 Phase 3 处于关键路径上 —— 每轮对话都会经过；
 * 如果 LLM 此处卡住，后面所有阶段都无法开始。超时后自动回退到启发式判断。
 */
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
const INTENT_AGENT_CONTEXT_SKILL_LIMIT = 40;
const INTENT_AGENT_CONTEXT_DESCRIPTION_LIMIT = 200;

const INTENT_SYSTEM_PROMPT_BASE = `You are the intent classifier for the Tachu engine (Phase 3: Intent Analysis).
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
6. Input asks to add, update, configure, or remove something **in the project** — scripts, dependencies, config files, CI/CD workflows, dev-server setup — even without an explicit file path; because this requires the tool-use sub-flow to actually read and write project files. Distinguish from pure code generation: "写一个脚本" (write a script → text output) is simple; "在项目里增加一个启动脚本" (add a script to the project → modify package.json) is complex.

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
  "turnPolicy": {                               // optional operational manifest (see below)
    "excludeTools": string[],
    "includeTools": string[],
    "excludeSkills": string[],
    "pinSkills": string[],
    "visualization": string                     // opaque host-defined label; default ""
  }
}

### turnPolicy

- Emit tool/skill names from Agent Context when the user's request implies including or excluding them this turn.
- \`includeTools\`: tools that must be available for function-calling this turn (host enforces).
- \`excludeTools\`: tools that must NOT appear in function-calling this turn.
- \`pinSkills\`: skills whose full instructions should be pinned (T0) this turn.
- \`excludeSkills\`: skills that must NOT be active or available this turn.
- Do NOT list skills/tools from User explicit selections in exclude lists.
- When turnPolicy is omitted, downstream uses empty lists (no change from default routing).

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

Example 4 (tool include / simple)
Input: generate an image of a small cat
Output: {"complexity":"simple","intent":"generate an image of a cat","contextRelevance":"unrelated","turnPolicy":{"excludeTools":[],"includeTools":["image.qwen"],"excludeSkills":[],"pinSkills":[],"visualization":"generated-image"}}

Respond in the same language as the latest user message; default to English when ambiguous.`;

/**
 * 动态构建 intent system prompt。
 *
 * 若 config 注入了业务 few-shot 示例，追加在内置示例之后；core prompt 本体不变。
 * 若传入了 agentContext，追加 ### Agent Context 段，让 intent LLM 知晓当前 agent
 * 的能力范围，从而无需硬编码业务 regex 即可正确判断 tool-query 类问题为 complex。
 */
const buildIntentSystemPrompt = (
  config: import("../../types").EngineConfig,
  scope?: SessionScope,
): string => {
  const agentContext = scope?.intentAgentContext;
  const fewShots = config.intent?.fewShotExamples;
  let prompt = resolveSystemPromptBase(
    config.intent?.systemPromptBase,
    INTENT_SYSTEM_PROMPT_BASE,
  );
  if (fewShots && fewShots.length > 0) {
    const injected = fewShots
      .map(
        (ex) =>
          `Example (${ex.complexity})\nInput: ${ex.input}\nOutput: ${JSON.stringify({
            complexity: ex.complexity,
            intent: ex.intent,
            contextRelevance: "unrelated",
          })}`,
      )
      .join("\n\n");
    prompt = `${prompt}\n\n${injected}`;
  }
  if (
    agentContext &&
    (agentContext.systemInstruction ||
      (agentContext.tools && agentContext.tools.length > 0) ||
      (agentContext.skills && agentContext.skills.length > 0))
  ) {
    const lines: string[] = ["", "### Agent Context"];
    if (agentContext.systemInstruction) {
      const truncated = agentContext.systemInstruction.slice(0, 300);
      lines.push(`This agent has the following system instruction (truncated):\n${truncated}`);
    }
    if (agentContext.tools && agentContext.tools.length > 0) {
      lines.push("Available tools for this agent:");
      for (const t of agentContext.tools) {
        const desc = t.description.slice(0, INTENT_AGENT_CONTEXT_DESCRIPTION_LIMIT);
        lines.push(`- ${t.name}: ${desc}`);
      }
    }
    if (agentContext.skills && agentContext.skills.length > 0) {
      lines.push("Available skills for this agent:");
      for (const skill of agentContext.skills.slice(0, INTENT_AGENT_CONTEXT_SKILL_LIMIT)) {
        const desc = skill.description.slice(0, INTENT_AGENT_CONTEXT_DESCRIPTION_LIMIT);
        const tags =
          skill.tags && skill.tags.length > 0 ? ` [tags: ${skill.tags.join(", ")}]` : "";
        lines.push(`- ${skill.name}: ${desc}${tags}`);
      }
    }
    lines.push(
      'Classification hint: If the user\'s request can ONLY be answered by calling one of the above tools (i.e., the LLM alone cannot answer it), classify as "complex".',
    );
    prompt = `${prompt}\n${lines.join("\n")}`;
  }

  const explicitSkills = scope?.explicitSkillNames ?? [];
  const explicitTools = scope?.explicitToolNames ?? [];
  if (explicitSkills.length > 0 || explicitTools.length > 0) {
    const lines: string[] = [
      "",
      "### User explicit selections (already enforced; do not exclude these skills/tools)",
    ];
    lines.push(`skills: ${explicitSkills.length > 0 ? explicitSkills.join(", ") : "(none)"}`);
    lines.push(`tools: ${explicitTools.length > 0 ? explicitTools.join(", ") : "(none)"}`);
    prompt = `${prompt}\n${lines.join("\n")}`;
  }

  return prompt;
};

/**
 * 强"simple"请求匹配正则。
 *
 * 触发场景：用户直白陈述"我需要/给我/help me/i need X"这类请求。
 * 这类请求**必定**归为 simple —— 即便长度 > 120 字、或包含"然后/并且"之类的弱 complex marker。
 *
 * 引入动机：
 * LLM 失败降级到 `inferComplexityFallback` 时，仅凭"长度 + 弱关键词"判定，
 * 会把"i need a pig img"这类应当走 direct-answer 的请求错判为 complex，
 * 进而跑到"盲取前 N 个 tool"的 planning 分支、最终全失败走兜底。
 * 本正则作为"显式意图白名单"，优先级高于长度判定。
 */
const STRONG_SIMPLE_MARKERS: readonly RegExp[] = [
  /^\s*(?:我需要|我想要?|我要|给我|帮我|请帮我|请给我|能否|能不能|可以|麻烦)/u,
  /^\s*(?:i\s+need|i\s+want|i'?d\s+like|help\s+me|show\s+me|give\s+me|please\s+(?:give|help|show)|gimme|tell\s+me|can\s+you|could\s+you|would\s+you)\b/i,
  /^\s*(?:写|编写|生成|列出|翻译|解释|介绍|说说|讲讲|讲个|讲解|比较|对比|总结|写个)/u,
  /^\s*(?:write|generate|list|translate|explain|describe|compare|summarize|give)\b/i,
];

const explicitToolNameMatchStrategy = new NameMatchToolCandidateStrategy();

const toNameMatchToolDescriptor = (tool: {
  name: string;
  description?: string | undefined;
}): ToolDescriptor => ({
  kind: "tool",
  name: tool.name,
  description: tool.description ?? tool.name,
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 0,
  inputSchema: {},
  execute: "<name-match-only>",
});

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
 * 只含**真正普遍**的信号——任何领域的 Agent 遇到这类输入都需要工具：
 * - URL → 需要 web-fetch
 * - 文件/目录路径 → 需要 file 工具
 * - 反引号命令语法 → 需要 shell 工具
 * - 文件/目录读写动词 → 需要 file 工具
 * - 实时数据（时间/天气/股价）→ 需要实时查询工具
 *
 * ⚠️ 领域相关信号（特定命令名如 npm/bun/git、项目配置文件如 package.json）
 * **不应**硬编码在此处。应通过 `EngineConfig.intent.additionalComplexPatterns`
 * 由业务层（如 @tachu/cli 的 tachu.config.ts）注入。
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
 // 反引号包裹的命令（`cmd arg` 语法本身是"执行命令"的普遍信号，不依赖具体命令名）
  /(?:运行|执行|跑一下|请跑|请执行)[\s\uff1a:]*`[^`]+`/u,
  /\b(?:run|exec|execute|invoke)\s+`[^`]+`/i,
 // "读 / 打开 / 列出 xxx 文件或目录"动作
  /(?:读取?|打开|查看|列出|遍历|扫描|搜索)\s*(?:一下\s*)?(?:文件|目录|仓库|项目|代码库|日志|配置|数据库)/u,
  /\b(?:read|open|list|scan|search|traverse)\s+(?:the\s+)?(?:file|dir|directory|repo|repository|codebase|project|log|logs|config|db|database)\b/i,
 // 时效性信号：用户要的是"现在"的数据，LLM 静态知识覆盖不了。
  /(?:当前|现在|此刻|今天|今日).{0,12}(?:时间|日期|几点|几号)/u,
  /(?:时间|日期|几点|几号).{0,12}(?:当前|现在|此刻|今天|今日)/u,
  /^\s*(?:时间|日期|几点|几号|当前时间|当前日期)\s*$/u,
  /\b(?:current\s+(?:date|time)|date\s+now|time\s+now|what'?s\s+the\s+time|today'?s\s+date)\b/i,
  /(?:今天|今日|现在|实时|最新|此刻|本周|本月)[\s\S]{0,20}?(?:股价|股指|汇率|天气|气温|新闻|热搜|排名|价格|行情|比分|赛况|收盘|点位|指数)/u,
  /\b(?:today|now|current|realtime|real-?time|latest)\s+(?:\S+\s+){0,3}?(?:price|prices|stock|index|weather|temperature|news|ranking|rate|score|match)\b/i,
];

/**
 * 编译 `config.intent.additionalComplexPatterns` 为 RegExp 数组，带 WeakMap 缓存。
 *
 * `validateEngineConfig` 已保证每条源串合法，这里只缓存编译结果避免重复 compile。
 */
const additionalPatternCache = new WeakMap<readonly string[], RegExp[]>();

const compileAdditionalPatterns = (patterns: readonly string[] | undefined): readonly RegExp[] => {
  if (!patterns || patterns.length === 0) return [];
  const cached = additionalPatternCache.get(patterns);
  if (cached) return cached;
  const compiled = patterns.map((source) => new RegExp(source, "ui"));
  additionalPatternCache.set(patterns, compiled);
  return compiled;
};

/**
 * 判断输入是否命中强 complex 标记（内置 + 业务注入）。
 *
 * @param text 用户输入（已 trim）
 * @param additionalPatterns 业务层编译后的额外 patterns（来自 config.intent.additionalComplexPatterns）
 */
const hasStrongComplexMarker = (text: string, additionalPatterns?: readonly RegExp[]): boolean => {
 if (STRONG_COMPLEX_MARKERS.some((p) => p.test(text))) return true;
 if (additionalPatterns && additionalPatterns.some((p) => p.test(text))) return true;
  return false;
};

/**
 * 关键词启发式复杂度判断（仅在 LLM 不可用时作为回退）。
 *
 * 判定顺序（自上而下）：
 * 1. 命中 STRONG_COMPLEX_MARKERS 或业务注入 patterns → 立即判 complex
 * 2. 命中 STRONG_SIMPLE_MARKERS → 判 simple
 * 3. 长度 > 120 字 或 命中弱 complex 关键词 → 判 complex
 * 4. 其余 → simple
 */
const inferComplexityFallback = (
  text: string,
  additionalPatterns?: readonly RegExp[],
  disableSimpleMarkers?: boolean,
): "simple" | "complex" => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "simple";

  if (hasStrongComplexMarker(trimmed, additionalPatterns)) {
    return "complex";
  }

 if (!disableSimpleMarkers && STRONG_SIMPLE_MARKERS.some((pattern) => pattern.test(trimmed))) {
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
 * 从 LLM 的原始响应里抽取 JSON 对象字符串。
 *
 * 宽容策略：
 * 1. 如果整段就是一个 JSON 对象 —— 直接解析。
 * 2. 如果包在 ```json ... ``` 围栏里 —— 剥围栏再解析。
 * 3. 如果 JSON 对象被其他文字包裹 —— 取第一对平衡括号内的内容。
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
 * - `complexity ∈ {simple, complex}`
 * - `intent` 非空字符串（自动截断到 200 字符）
 * - `contextRelevance ∈ {related, unrelated}`，缺省视为 `related`
 * - `turnPolicy` 可选 subset（exclude/include tools/skills、pinSkills、visualization）
 *
 * 任一字段非法视为解析失败，返回 null 交由上层兜底。
 *
 * @returns 解析成功返回 IntentResult；解析失败返回 null（由上层回退到启发式）。
 */
/**
 * Intent 始终走 `intent` 能力路由。
 *
 * 意图分析为零物化阶段：只见 `[Image #N]`/`[File #N]` 轻量占位 token，从不接收
 * 资源负载，因此无需 vision 路由；后续模型由意图分析之后的 LLM 决策选定。
 */
const resolveIntentPhaseRoute = (router: ModelRouter): ModelRoute =>
  router.resolve("intent");

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

const parseTurnPolicyLlmOutput = (raw: unknown): IntentTurnPolicyLlmOutput | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const readNames = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return names.length > 0 ? names : [];
  };
  const excludeTools = readNames(obj.excludeTools);
  const includeTools = readNames(obj.includeTools);
  const excludeSkills = readNames(obj.excludeSkills);
  const pinSkills = readNames(obj.pinSkills);
  const visualization = typeof obj.visualization === "string" ? obj.visualization : undefined;
  if (
    excludeTools === undefined &&
    includeTools === undefined &&
    excludeSkills === undefined &&
    pinSkills === undefined &&
    visualization === undefined
  ) {
    return undefined;
  }
  return {
    ...(excludeTools !== undefined ? { excludeTools } : {}),
    ...(includeTools !== undefined ? { includeTools } : {}),
    ...(excludeSkills !== undefined ? { excludeSkills } : {}),
    ...(pinSkills !== undefined ? { pinSkills } : {}),
    ...(visualization !== undefined ? { visualization } : {}),
  };
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

  const turnPolicy = parseTurnPolicyLlmOutput(obj.turnPolicy);

  return {
    complexity,
    intent,
    contextRelevance,
    ...(turnPolicy ? { turnPolicy } : {}),
  };
};

const listRegistryNames = (
  registry: PhaseEnvironment["registry"],
  kind: "tool" | "skill",
): string[] => {
  if (typeof registry.list !== "function") return [];
  return registry.list(kind).map((descriptor) => descriptor.name);
};

const collectKnownToolNames = (env: PhaseEnvironment): Set<string> =>
  new Set([
    ...listRegistryNames(env.registry, "tool"),
    ...(env.scope?.additionalTools ?? []).map((tool) => tool.name),
    ...(env.scope?.intentAgentContext?.tools ?? []).map((tool) => tool.name),
  ]);

const collectKnownSkillNames = (env: PhaseEnvironment): Set<string> =>
  new Set([
    ...listRegistryNames(env.registry, "skill"),
    ...(env.scope?.additionalSkills ?? []).map((skill) => skill.name),
    ...(env.scope?.intentAgentContext?.skills ?? []).map((skill) => skill.name),
    ...(env.scope?.explicitSkillNames ?? []),
  ]);

const finalizeIntentPhase = (
  working: SafetyPhaseOutput,
  intent: IntentResult,
  env: PhaseEnvironment,
): SafetyPhaseOutput & { intent: IntentResult } => {
  const policy = normalizeTurnPolicy({
    llm: intent.turnPolicy,
    scope: env.scope,
    preseed: readTurnPolicy(working.input),
    knownToolNames: collectKnownToolNames(env),
    knownSkillNames: collectKnownSkillNames(env),
  });
  env.observability.emit(engineEventFromContext(working.context, {
    timestamp: Date.now(),
    phase: "intent",
    type: "progress",
    payload: {
      stage: "turn-policy",
      visualization: policy.visualization,
      excludeTools: policy.excludeTools,
      includeTools: policy.includeTools,
      explicitSkills: policy.explicitSkills,
      excludeSkills: policy.excludeSkills,
      pinSkills: policy.pinSkills,
    },
  }));
  return {
    ...working,
    input: withTurnPolicyMetadata(working.input, policy),
    intent,
  };
};

/**
 * 组装要喂给 intent LLM 的 Message 列表：system + 最近 N 轮历史 + 本轮用户输入。
 */
const buildIntentMessages = async (
  state: SafetyPhaseOutput,
  env: PhaseEnvironment,
  userContent: Message["content"],
  userResources?: ResourceReference[],
): Promise<Message[]> => {
  const messages: Message[] = [
    { role: "system", content: buildIntentSystemPrompt(env.config, env.scope) },
  ];

  try {
    const window = await env.memorySystem.load(state.context.correlation.sessionId, env.adapterContext);
    const history = window.entries
      .map(memoryEntryToMessage)
      .filter((m): m is Message => m !== null)
      .filter((m) => m.role !== "system")
      .slice(-INTENT_HISTORY_LIMIT);
 // Session 阶段已把本轮 user 写入 memory，先剥尾再 push currentInput，
 // 避免与历史末尾形成双发。语义见 prompt/turn-tail.ts。
    const trimmed = stripTrailingCurrentTurn(history, userContent);
    for (const m of trimmed) messages.push(m);
  } catch {
 // Memory 读取失败不阻塞 intent；历史只是锦上添花。
  }

  messages.push({
    role: "user",
    content: userContent,
    ...(userResources !== undefined ? { resources: userResources } : {}),
  });
 // intent 零物化——把资源 token / 裸 part 降级为 `[Image #N]` 占位文本，
 // 绝不把 base64/二进制喂给意图分析 LLM。
  return redactResourcesForIntent(messages);
};

/**
 * 发起一次 Intent LLM 调用，返回 IntentResult 或 null（交由上层回退）。
 */
const callIntentLLM = async (
  adapter: ProviderAdapter,
  model: string,
  messages: Message[],
  env: PhaseEnvironment,
): Promise<IntentResult | null> => {
  const llmTimeouts = resolveLlmTimeouts(env.config, "intent");
  const signal = buildLlmCallAbortSignal(
    env.activeAbortSignal,
    llmTimeouts.llmStreamingMs,
    "streaming",
  );
  const startedAt = Date.now();
  env.observability.emit(engineEventFromAdapterContext(env.adapterContext, {
    timestamp: startedAt,
    phase: "intent",
    type: "llm_call_start",
    payload: { provider: adapter.id, model, messageCount: messages.length },
  }));
  const usageTracker = createLlmUsageTracker({
    attribution: {
      id: env.nextStreamId?.() ?? `${env.adapterContext.correlation.traceId}:intent:${startedAt}`,
      kind: "llm_call",
      ...(env.currentPhaseStepId !== undefined
        ? { parentId: env.currentPhaseStepId }
        : {}),
      label: "intent",
      meta: {
        phase: "intent",
        provider: adapter.id,
        model,
      },
    },
    estimatedInputTokens: await estimateMessagesTokens(adapter, messages, model),
    emit: env.emitUsageTelemetry,
  });
  usageTracker.start();

  try {
 // intent 消息已零物化（无资源 part），直接调用 adapter.chat，
 // 不经过物化 seam。
    const response = await adapter.chat({ model, messages }, env.adapterContext, signal);
    usageTracker.addOutputDelta(response.content);
    usageTracker.final(response.usage);
 // ：把真实 usage 回流到 orchestrator，以覆盖此前仅用 Prompt 估算 token 的逻辑。
    env.onProviderUsage?.(response.usage);
    const parsed = parseIntentJson(response.content);

    if (parsed) {
      env.observability.emit(engineEventFromAdapterContext(env.adapterContext, {
        timestamp: Date.now(),
        phase: "intent",
        type: "llm_call_end",
        payload: {
          provider: adapter.id,
          model,
          durationMs: Date.now() - startedAt,
          usage: response.usage,
          parsed: true,
        },
      }));
      return parsed;
    }

 // JSON 解析失败但 LLM 确实返回了文本：
 // 直接把文本摘要作为 intent.intent，并归类为 simple 交给 direct-answer 子流程重新生成答复。
 // 这样既保留了"尊重 LLM 有内容"的信号，又把"答复产出"责任交给语义统一的子流程，
 // 避免了"把分类器的口水当成最终答复"的反 UX 回归。
    const rawText = response.content.trim();
    env.observability.emit(engineEventFromAdapterContext(env.adapterContext, {
      timestamp: Date.now(),
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
    }));
    if (rawText.length === 0) return null;
    return {
      complexity: "simple",
      intent: rawText.slice(0, 200),
      contextRelevance: "related",
    };
  } catch (error) {
    const budgetTimeout = isBudgetTimeoutAbort(signal);
    if (budgetTimeout) {
      usageTracker.terminal("failed");
      throw budgetTimeout;
    }
    usageTracker.terminal(env.activeAbortSignal.aborted ? "cancelled" : "failed");
    env.observability.emit(engineEventFromAdapterContext(env.adapterContext, {
      timestamp: Date.now(),
      phase: "intent",
      type: "warning",
      payload: {
        provider: adapter.id,
        model,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        reason: "intent LLM call failed; falling back to heuristic",
      },
    }));
    return null;
  }
};

/**
 * 阶段 3：意图分析。
 *
 * 流程：
 * 1. 从 `config.models.capabilityMapping.intent` 解析目标模型与 provider；
 * 2. 组装 system + 历史 + 当前输入 的 Message 列表；
 * 3. 调用 ProviderAdapter.chat 获取 LLM 响应；
 * 4. 解析 JSON 结果为 `IntentResult`；
 * 5. 任何一步失败（provider 未注册 / 调用抛错 / JSON 解析失败 / 被取消）都会
 * 回退到关键词启发式，并在 observability 中留下 warning。
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

 // 编译业务层注入的额外 complex patterns（WeakMap 缓存，只在首次命中时 compile）
  const additionalPatterns = compileAdditionalPatterns(
    env.config.intent?.additionalComplexPatterns,
  );

 /** CLI / host pre-seeded includeTools: skip Intent LLM when turn policy already requests tools. */
  const preseedPolicy = readTurnPolicy(working.input);
  if (preseedPolicy.includeTools.length > 0 && working.input.metadata?.source !== undefined) {
    const intentText = contentForHeuristic.slice(0, 200);
    await env.runtimeState.update(working.context.correlation.sessionId, { currentPhase: "intent" });
    return finalizeIntentPhase(
      working,
      {
        complexity: "simple",
        intent: intentText.length > 0 ? intentText : "explicit-tool-turn",
        contextRelevance: "related",
      },
      env,
    );
  }

  const agentTools =
    env.scope?.intentAgentContext?.tools?.map(toNameMatchToolDescriptor) ??
    env.scope?.explicitToolNames?.map((name) => toNameMatchToolDescriptor({ name })) ??
    [];
  const nameMatchToolNames =
    agentTools.length > 0
      ? [
          ...new Set(
            (
              await explicitToolNameMatchStrategy.score({
                query: contentForHeuristic,
                agentVisibleTools: agentTools,
                registry: env.registry,
                observability: env.observability,
                signal: env.activeAbortSignal,
                correlation: working.context.correlation,
                subject: working.context.subject,
              })
            ).map((contribution) => contribution.toolName),
          ),
        ]
      : [];
  const explicitToolNames = [
    ...new Set([
      ...(env.scope?.explicitToolNames ?? []),
      ...nameMatchToolNames,
    ]),
  ];
  if (explicitToolNames.length > 0) {
    env.observability.emit(engineEventFromContext(working.context, {
      timestamp: Date.now(),
      phase: "intent",
      type: "progress",
      payload: {
        stage: "fast-path",
        reason: "explicit-tool-mention",
        toolNames: explicitToolNames,
      },
    }));
    await env.runtimeState.update(working.context.correlation.sessionId, { currentPhase: "intent" });
    return finalizeIntentPhase(
      working,
      {
        complexity: "complex",
        intent: contentForHeuristic.slice(0, 200),
        contextRelevance: "related",
      },
      env,
    );
  }

 // fast-path: 命中强 complex marker（内置 + 业务注入）→ 直接判 complex，跳过 intent LLM。
  if (hasStrongComplexMarker(contentForHeuristic, additionalPatterns)) {
    env.observability.emit(engineEventFromContext(working.context, {
      timestamp: Date.now(),
      phase: "intent",
      type: "progress",
      payload: { stage: "fast-path", reason: "strong-complex-marker" },
    }));
    await env.runtimeState.update(working.context.correlation.sessionId, { currentPhase: "intent" });
    return finalizeIntentPhase(
      working,
      {
        complexity: "complex",
        intent: contentForHeuristic.slice(0, 200),
        contextRelevance: "related",
      },
      env,
    );
  }

 // fast-path: 短输入命中强 simple marker 且不含强 complex → 直接 simple。
 // 若 config.intent.disableSimpleMarkers=true，跳过此路径，交由 LLM 分类。
  const trimmedHeuristic = contentForHeuristic.trim();
  if (
    !env.config.intent?.disableSimpleMarkers &&
    trimmedHeuristic.length > 0 &&
    trimmedHeuristic.length <= 40 &&
 STRONG_SIMPLE_MARKERS.some((p) => p.test(trimmedHeuristic))
  ) {
    env.observability.emit(engineEventFromContext(working.context, {
      timestamp: Date.now(),
      phase: "intent",
      type: "progress",
      payload: { stage: "fast-path", reason: "strong-simple-short" },
    }));
    await env.runtimeState.update(working.context.correlation.sessionId, { currentPhase: "intent" });
    return finalizeIntentPhase(
      working,
      {
        complexity: "simple",
        intent: trimmedHeuristic.slice(0, 200),
        contextRelevance: "related",
      },
      env,
    );
  }

  let intent: IntentResult | null = null;

  try {
    const route = resolveIntentPhaseRoute(env.modelRouter);
    const adapter = env.providers.get(route.provider);
    if (adapter) {
      const messages = await buildIntentMessages(
        working,
        env,
        getIntentUserMessageContent(working.input),
        working.input.resources,
      );
      intent = await callIntentLLM(
        adapter,
        route.model,
        messages,
        env,
      );
    } else {
      env.observability.emit(engineEventFromContext(working.context, {
        timestamp: Date.now(),
        phase: "intent",
        type: "warning",
        payload: {
          reason: `provider "${route.provider}" not registered; intent LLM call skipped`,
          capability: "intent",
        },
      }));
    }
  } catch (error) {
 // 预算超时必须中断当前 run，而非回退启发式继续。
    if (error instanceof BudgetExhaustedError) {
      throw error;
    }
    env.observability.emit(engineEventFromContext(working.context, {
      timestamp: Date.now(),
      phase: "intent",
      type: "warning",
      payload: {
        reason: "intent capability routing failed; falling back to heuristic",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }

  if (!intent) {
    intent = {
      complexity: inferComplexityFallback(
        contentForHeuristic,
        additionalPatterns,
        env.config.intent?.disableSimpleMarkers,
      ),
      intent: contentForHeuristic.slice(0, 200),
      contextRelevance: "related",
    };
  } else if (
    intent.complexity === "simple" &&
    hasStrongComplexMarker(contentForHeuristic, additionalPatterns)
  ) {
 // 事后守护：即便 LLM 判为 simple，只要输入里含强信号（内置 + 业务注入），一律强制升级为 complex。
    env.observability.emit(engineEventFromContext(working.context, {
      timestamp: Date.now(),
      phase: "intent",
      type: "warning",
      payload: {
        reason:
          "LLM classified as simple but input contains strong complex markers (url/path/command/realtime); upgrading to complex",
        originalComplexity: "simple",
      },
    }));
    intent = { ...intent, complexity: "complex" };
  }

  await env.runtimeState.update(working.context.correlation.sessionId, { currentPhase: "intent" });
  return finalizeIntentPhase(working, intent, env);
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
  buildIntentSystemPrompt,
};
