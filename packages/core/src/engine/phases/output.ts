import type {
  EngineOutput,
  OutputMetadata,
  ToolUseResult,
} from "../../types";
import type { ValidationPhaseOutput } from "./validation";
import { isValidationPassing } from "./validation";
import type { PhaseEnvironment } from "./index";

/**
 * `task-direct-answer` 是 Phase 5 为兜底路径分配的固定任务 ID。
 * `task-tool-use` 是 Phase 5 为 Agentic Loop 分配的固定任务 ID（
 * Phase 9 据此从 taskResults 中提取最终答复内容。
 */
const DIRECT_ANSWER_TASK_ID = "task-direct-answer";
const TOOL_USE_TASK_ID = "task-tool-use";

/**
 * 兜底答复的最短可接受长度（沿用旧契约，方便外部调用方做断言）。
 *
 * 本地模板长度恒满足该约束；之后 Output Phase 不再向 LLM 发起任何
 * 后置 fallback 请求，因此该常量只用于注释与契约文档化目的。
 */
const FALLBACK_MIN_LENGTH = 30;

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

const isToolUseResult = (value: unknown): value is ToolUseResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "tool-use-result";
};

interface AgentRunOutput {
  kind: "agent-run-result";
  agent: string;
  status: "completed";
  output: unknown;
}

const isAgentRunOutput = (value: unknown): value is AgentRunOutput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "agent-run-result";
};

const buildAgentSynthesisText = (results: AgentRunOutput[]): string => {
  const lines = ["已完成分派任务，汇总如下：", ""];
  for (const result of results) {
    lines.push(`### ${result.agent}`);
    lines.push(stringifyTaskResult(result.output).trim() || "未返回内容。");
    lines.push("");
  }
  return sanitizeInternalTerms(lines.join("\n").trim());
};

const buildToolUseLocalFallbackText = (
  state: ValidationPhaseOutput,
  toolUseResult: ToolUseResult,
): string => {
  const intent =
    typeof state.intent.intent === "string" && state.intent.intent.trim().length > 0
      ? state.intent.intent.trim()
      : "当前请求";
  const previews = toolUseResult.observations.slice(0, 3).map((item) => {
    const text =
      item.text.length <= 600 ? item.text.trim() : `${item.text.slice(0, 600)}...`;
    return `- ${item.tool}: ${text || "工具返回为空"}`;
  });
  const lines = [
    `本次${intent}没有完成完整的最终整理，但工具步骤已经返回了部分结果。`,
    "",
    ...(previews.length > 0 ? previews : ["- 没有可展示的工具结果。"]),
  ];
  if (toolUseResult.error) {
    lines.push("", `后续生成答案时遇到问题：${toolUseResult.error.message}`);
  }
  return sanitizeInternalTerms(lines.join("\n"));
};

/**
 * 本地模板兜底 —— 不调任何外部依赖，保证 100% 可用。
 *
 * 文案只用用户侧可读词：
 * - 不含 `Phase \d+` / `task-tool-*` / `task-tool-use` / `direct-answer 子流程` / `tool-use 子流程` / `capability 路由` / `Tool / Agent 描述符`
 * - 不使用 code 字段
 * - 结构：一句承认 + 可能原因 + 下一步建议
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
 * 兜底答复总入口。
 *
 * **设计契约（重要）**：validation 失败之后的 Output Phase **不得**再向 LLM
 * 发起任何调用。任何"LLM best-effort summary"思路（patch-01-fallback 旧路径）
 * 已经退役 —— 如果未来仍希望由 LLM 产出友好兜底，应当在 validation **之前**
 * 把它合成成 `CandidateAnswer`（带 claims + evidence），让 validation 一并把关。
 *
 * 当前实现：
 * - 始终返回 `buildFallbackTemplate(state)`（本地确定性模板）
 * - 模板长度恒满足 `FALLBACK_MIN_LENGTH`
 * - 模板已经走过 `sanitizeInternalTerms`
 * - **不得**向上抛异常；保留 `env` 参数仅为向后兼容旧 PhaseEnvironment 调用方
 *
 * 该函数从此 100% 同步可计算，但保留 `Promise<string>` 返回类型以避免破坏现有
 * `runOutputPhase` 调用链。
 */
export const ensureFallbackText = async (
  state: ValidationPhaseOutput,
 // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _env: PhaseEnvironment,
): Promise<string> => {
  const text = sanitizeInternalTerms(buildFallbackTemplate(state));
  if (text.length < FALLBACK_MIN_LENGTH) {
 // Defensive: the template is human-authored and always satisfies the bound,
 // but we sanity-check so future template edits cannot silently shrink the
 // floor without a test catching it.
    return `${text}\n\n（如需更具体的帮助，请补充更多上下文或换一种描述方式。）`;
  }
  return text;
};

/**
 * 阶段 9：输出装配。
 *
 * `content` 选取策略（按优先级）：
 * 1. `taskResults` 中存在 `task-direct-answer` 或 `task-tool-use`（
 * 的非空内容 → 直接使用（simple / Agentic Loop / complex-fallback 路径的常态）
 * 2. validation 通过（`outcome.kind === "pass"` 优先、`passed === true` 兜底）→
 * 结构化 JSON 输出（保留给无内置自然语言子流程的路径）
 * 3. validation 未通过 → `ensureFallbackText()` 产出的用户友好兜底文案
 * （先 LLM best-effort，失败降级到本地模板；保证 ≥ 30 字 ∧ 无内部术语）
 *
 * 本阶段不再直接读 `state.validation.passed`，统一走
 * `isValidationPassing()` helper，以便 host 注入的 `outcome.kind` 立即生效；
 * `passed` 字段在所有 outcome 全消费完毕前保留为后向兼容回退路径。
 */
export const runOutputPhase = async (
  state: ValidationPhaseOutput,
  env: PhaseEnvironment,
  metadata: OutputMetadata,
): Promise<EngineOutput> => {
  const toolUseResultRaw = state.taskResults[TOOL_USE_TASK_ID];
  const toolUseResult = isToolUseResult(toolUseResultRaw)
    ? toolUseResultRaw
    : null;
  const agentResults = Object.values(state.taskResults).filter(isAgentRunOutput);
  const validationPassing = isValidationPassing(state.validation);
  const candidateContent = state.candidateAnswer?.content?.trim() ?? "";

  let content: string;
  if (validationPassing && candidateContent.length > 0) {
    content = candidateContent;
  } else if (validationPassing && agentResults.length > 0) {
    content =
      candidateContent.length > 0
        ? candidateContent
        : buildAgentSynthesisText(agentResults);
  } else if (validationPassing) {
    content = JSON.stringify(
      {
        intent: state.intent.intent,
        taskResults: state.taskResults,
      },
      null,
      2,
    );
  } else if (toolUseResult !== null && candidateContent.length > 0) {
    content = buildToolUseLocalFallbackText(state, toolUseResult);
  } else {
    content = await ensureFallbackText(state, env);
  }

  const output: EngineOutput = {
    type: "text",
    content,
    steps: state.steps,
    metadata,
    correlation: state.context.correlation,
    ...(state.context.subject !== undefined ? { subject: state.context.subject } : {}),
    deliveryMode: "streaming",
  };
  await env.runtimeState.update(state.context.correlation.sessionId, { currentPhase: "output" });
  return output;
};
