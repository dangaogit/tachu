import type { Message, SkillDescriptor, ToolUseObservation, ToolUseResult } from "../../types";
import type { CandidateAnswer, ClaimEntry, EvidenceEntry, EvidenceProducerId } from "../../types/evidence";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";
import { renderActiveSkills } from "../../prompt/render-skills";
import { mapDeterministicClaims } from "../evidence/claim-mapper";
import {
  mergeEvidence,
  normalizeAgentRunEvidence,
  normalizeExternalSourceRefs,
  normalizeFileWriteRecords,
  normalizeToolObservations,
  type DescriptorRegistryView,
} from "../evidence/normalize";
import { buildLlmCallAbortSignal, resolveLlmTimeouts } from "../llm-timeouts";
import { resolveSystemPromptBase } from "../../utils/system-prompt-base";
import {
  createLlmUsageTracker,
  estimateMessagesTokens,
} from "../llm-usage-telemetry";
import {
  chatWithResolvedMessages,
  streamChatWithResolvedMessages,
  resolveProviderDemand,
  emitResourceDegradations,
} from "../resolve-provider-messages";
import { engineEventFromContext } from "../turn-outcome";
import { sanitizeInternalTerms } from "./output";
import { renderTokensToDisplay } from "../../utils/resource-pool";

const DIRECT_ANSWER_TASK_ID = "task-direct-answer";
const TOOL_USE_TASK_ID = "task-tool-use";
const OUTPUT_FORMAT_SKILL_TAG = "output-format";
const CHART_OUTPUT_SKILL_NAME = "chart-output";

const isChartOutputSkill = (skill: SkillDescriptor): boolean =>
  skill.name === CHART_OUTPUT_SKILL_NAME ||
  skill.tags?.includes("chart") === true ||
  skill.tags?.includes("visualization") === true;

const CHART_OUTPUT_FINAL_ANSWER_RULES = `

## Chart Output Requirements (mandatory)
When chart-output is active, the final answer MUST include at least one fenced code block labeled exactly \`echarts\` or \`mermaid\` per the Active Skills contract.
- Do NOT output \`python\`, \`javascript\`, \`js\`, or other code fences for charts.
- Do NOT output matplotlib, pyplot, or ECharts initialization code (\`echarts.init\`, \`setOption\`).
- Do NOT say the environment cannot render charts, cannot call a chart tool, or requires an external editor.
- Put brief Markdown explanation around chart blocks; chart data must live inside the \`echarts\` strict JSON fence.`;

const CHART_OUTPUT_TERMINAL_DRAFT_NOTE = `

If the terminal draft above contains Python, matplotlib, JavaScript, or other non-echarts/mermaid chart code, ignore that draft and synthesize valid \`echarts\` or \`mermaid\` fenced blocks from the tool observations instead.`;

export interface CandidateAnswerPhaseOutput extends ExecutionPhaseOutput {
  evidence: EvidenceEntry[];
  candidateAnswer: CandidateAnswer;
}

const isToolUseResult = (value: unknown): value is ToolUseResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "tool-use-result";
};

interface AgentRunOutput {
  kind: "agent-run-result";
  agent: string;
  status: "completed";
  output: unknown;
  evidence?: EvidenceEntry[] | undefined;
}

const isAgentRunOutput = (value: unknown): value is AgentRunOutput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "agent-run-result";
};

const stringifyTaskResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractInputText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
};

const clipForPrompt = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;

const observationToPromptText = (observation: ToolUseObservation, index: number): string =>
  [
    `Observation ${index + 1}`,
    `Tool: ${observation.tool}`,
    `CallId: ${observation.callId}`,
    "Output:",
    clipForPrompt(observation.text, 4_000),
  ].join("\n");

const TOOL_USE_FINAL_ANSWER_SYSTEM_PROMPT = `You are the final answer writer for a tool-assisted task.

Write the user-facing final answer using only the user's request, tool observations, and any terminal draft provided by the tool loop.

Rules:
- Do not mention internal engine phases, tool-loop implementation details, task ids, or provider errors.
- If tool observations are partial, say what could be confirmed and what remains uncertain.
- Do not invent facts not supported by the observations.
- Produce natural language Markdown in the same language as the user's latest request.`;

const buildToolUseFinalAnswerMessages = (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
  toolUseResult: ToolUseResult,
): Message[] => {
  const userInput = clipForPrompt(
    extractInputText(
      renderTokensToDisplay(
        state.input.content as Message["content"],
        state.input.resources,
      ),
    ),
    2_000,
  );
  const observations =
    toolUseResult.observations.length > 0
      ? toolUseResult.observations
          .slice(0, 12)
          .map(observationToPromptText)
          .join("\n\n---\n\n")
      : "No tool observations were produced.";
  const terminalDraft =
    typeof toolUseResult.terminalDraft === "string" &&
    toolUseResult.terminalDraft.trim().length > 0
      ? clipForPrompt(toolUseResult.terminalDraft.trim(), 2_000)
      : "No terminal draft was produced.";
  const error =
    toolUseResult.error !== undefined
      ? `Partial/error status: ${toolUseResult.status}\nError: ${toolUseResult.error.message}`
      : `Status: ${toolUseResult.status}`;

  const activeSkills = resolveFinalAnswerSkills(env, state);
  const hasChartOutput = activeSkills.some(isChartOutputSkill);
  const userPrompt = `User request:
${userInput}

${error}

Tool observations:
${observations}

Terminal draft from tool loop:
${terminalDraft}${hasChartOutput ? CHART_OUTPUT_TERMINAL_DRAFT_NOTE : ""}

Now write the final answer.`;

  const skillBlock =
    activeSkills.length > 0
      ? `\n\n## Active Skills\n${renderActiveSkills(activeSkills)}`
      : "";
  const chartRulesBlock = hasChartOutput ? CHART_OUTPUT_FINAL_ANSWER_RULES : "";
  const systemPromptBase = resolveSystemPromptBase(
    env.config.toolUse?.finalAnswerSystemPromptBase,
    TOOL_USE_FINAL_ANSWER_SYSTEM_PROMPT,
  );

  return [
    {
      role: "system",
      content: systemPromptBase + skillBlock + chartRulesBlock,
    },
    { role: "user", content: userPrompt },
  ];
};

const resolveOutputRoute = (
  env: PhaseEnvironment,
): { provider: string; model: string } => {
  try {
    return env.modelRouter.resolve("high-reasoning");
  } catch {
    try {
      return env.modelRouter.resolve("intent");
    } catch {
      return env.modelRouter.resolve("fast-cheap");
    }
  }
};

const buildToolUseLocalFallbackText = (
  state: ExecutionPhaseOutput,
  toolUseResult: ToolUseResult,
): string => {
  const intent =
    typeof state.intent.intent === "string" && state.intent.intent.trim().length > 0
      ? state.intent.intent.trim()
      : "当前请求";
  const previews = toolUseResult.observations.slice(0, 3).map((item) => {
    const text = clipForPrompt(item.text.trim(), 600);
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

const buildAgentSynthesisText = (results: AgentRunOutput[]): string => {
  const lines = ["已完成分派任务，汇总如下：", ""];
  for (const result of results) {
    lines.push(`### ${result.agent}`);
    lines.push(stringifyTaskResult(result.output).trim() || "未返回内容。");
    lines.push("");
  }
  return sanitizeInternalTerms(lines.join("\n").trim());
};

const safeEmit = (
  env: PhaseEnvironment,
  event: Parameters<PhaseEnvironment["observability"]["emit"]>[0],
): void => {
  try {
    env.observability.emit(event);
  } catch {
 // Observability failures must not break candidate answer synthesis.
  }
};

export const resolveFinalAnswerSkills = (
  env: PhaseEnvironment,
  state: ExecutionPhaseOutput,
): SkillDescriptor[] => {
  const source = env.finalAnswerActiveSkills ?? [];
  const scope = env.config.runtime.finalAnswerSkillScope ?? "all-active";
  if (scope !== "output-format-only") {
    return source;
  }
  const filtered = source.filter((skill) =>
    skill.tags?.includes(OUTPUT_FORMAT_SKILL_TAG),
  );
  if (source.length > 0 && filtered.length === 0) {
    safeEmit(
      env,
      engineEventFromContext(state.context, {
        timestamp: Date.now(),
        phase: "execution",
        type: "warning",
        payload: {
          purpose: "final-answer",
          reason: "finalAnswerSkillScope output-format-only matched no active skills",
          scope: "output-format-only",
          activeSkillCount: source.length,
        },
      }),
    );
  }
  return filtered;
};

const generateToolUseFinalAnswer = async (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
  toolUseResult: ToolUseResult,
): Promise<string | null> => {
  const emit = (event: Parameters<typeof engineEventFromContext>[1]): void => {
    safeEmit(env, engineEventFromContext(state.context, event));
  };
  const route = resolveOutputRoute(env);
  const adapter = env.providers.get(route.provider);
  if (!adapter) {
    emit({
      timestamp: Date.now(),
      phase: "execution",
      type: "warning",
      payload: {
        purpose: "final-answer",
        provider: route.provider,
        reason: "provider not registered",
      },
    });
    return null;
  }

  const messages = buildToolUseFinalAnswerMessages(state, env, toolUseResult);
  const startedAt = Date.now();
  emit({
    timestamp: startedAt,
    phase: "execution",
    type: "llm_call_start",
    payload: {
      provider: adapter.id,
      model: route.model,
      purpose: "final-answer",
      messageCount: messages.length,
    },
  });

  const llmTimeouts = resolveLlmTimeouts(env.config, "output");
  const useStream =
    env.config.runtime.streamingOutput === true &&
    env.onFinalAnswerDelta !== undefined;
  const usageTracker = createLlmUsageTracker({
    attribution: {
      id:
        env.nextStreamId?.() ??
        `${state.context.correlation.traceId}:candidate-final-answer:${startedAt}`,
      kind: "llm_call",
      ...(env.currentPhaseStepId !== undefined
        ? { parentId: env.currentPhaseStepId }
        : {}),
      label: "final-answer",
      meta: {
        phase: "execution",
        purpose: "final-answer",
        provider: adapter.id,
        model: route.model,
      },
    },
    estimatedInputTokens: await estimateMessagesTokens(adapter, messages, route.model),
    emit: env.emitUsageTelemetry,
  });
  usageTracker.start();

  const demand = await resolveProviderDemand(env.resourceDemandRouter, {
    adapter,
    model: route.model,
    unit: "candidate-answer",
    phase: "execution",
    messages,
  });

  if (useStream) {
    const signal = buildLlmCallAbortSignal(
      env.activeAbortSignal,
      llmTimeouts.llmStreamingMs,
      "streaming",
    );
    let content = "";
    let deltaCount = 0;
    try {
      for await (const part of streamChatWithResolvedMessages(
        adapter,
        { model: route.model, messages },
        env.adapterContext,
        env.multimodalResolver,
        signal,
        demand,
        (degradations) =>
          emitResourceDegradations(
            env.observability,
            env.adapterContext,
            "candidate-answer",
            "execution",
            degradations,
          ),
      )) {
        if (part.type === "text-delta") {
          if (part.delta.length === 0) continue;
          content += part.delta;
          deltaCount += 1;
          usageTracker.addOutputDelta(part.delta);
          env.onFinalAnswerDelta?.(part.delta);
        } else if (part.type === "finish" && part.usage !== undefined) {
          if (part.usage.totalTokens > 0) {
            usageTracker.final(part.usage);
          }
          env.onProviderUsage?.(part.usage);
        }
      }
      const text = sanitizeInternalTerms(content.trim());
      emit({
        timestamp: Date.now(),
        phase: "execution",
        type: "llm_call_end",
        payload: {
          provider: adapter.id,
          model: route.model,
          purpose: "final-answer",
          durationMs: Date.now() - startedAt,
          empty: text.length === 0,
          streamed: true,
        },
      });
      return text.length > 0 ? text : null;
    } catch (error) {
      emit({
        timestamp: Date.now(),
        phase: "execution",
        type: "warning",
        payload: {
          provider: adapter.id,
          model: route.model,
          purpose: "final-answer",
          durationMs: Date.now() - startedAt,
          deltaCount,
          message: error instanceof Error ? error.message : String(error),
          reason: "final answer stream failed",
        },
      });
      if (deltaCount > 0) {
        usageTracker.terminal(env.activeAbortSignal.aborted ? "cancelled" : "failed");
        throw error;
      }
      usageTracker.terminal(env.activeAbortSignal.aborted ? "cancelled" : "failed");
      return null;
    }
  }

  const signal = buildLlmCallAbortSignal(
    env.activeAbortSignal,
    llmTimeouts.llmStreamingMs,
    "streaming",
  );
  try {
    const chatResult = await chatWithResolvedMessages(
      adapter,
      { model: route.model, messages },
      env.adapterContext,
      env.multimodalResolver,
      signal,
      demand,
    );
    if (!chatResult.ok) {
      return chatResult.userVisibleReason;
    }
    emitResourceDegradations(
      env.observability,
      env.adapterContext,
      "candidate-answer",
      "execution",
      chatResult.degradations,
    );
    const response = chatResult.response;
    usageTracker.addOutputDelta(response.content);
    usageTracker.final(response.usage);
    env.onProviderUsage?.(response.usage);
    const text = sanitizeInternalTerms(response.content.trim());
    emit({
      timestamp: Date.now(),
      phase: "execution",
      type: "llm_call_end",
      payload: {
        provider: adapter.id,
        model: route.model,
        purpose: "final-answer",
        durationMs: Date.now() - startedAt,
        usage: response.usage,
        empty: text.length === 0,
        streamed: false,
      },
    });
    return text.length > 0 ? text : null;
  } catch (error) {
    usageTracker.terminal(env.activeAbortSignal.aborted ? "cancelled" : "failed");
    emit({
      timestamp: Date.now(),
      phase: "execution",
      type: "warning",
      payload: {
        provider: adapter.id,
        model: route.model,
        purpose: "final-answer",
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        reason: "final answer LLM call failed",
      },
    });
    return null;
  }
};

const collectEvidence = (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): EvidenceEntry[] => {
  const toolUseRaw = state.taskResults[TOOL_USE_TASK_ID];
  const toolUse = isToolUseResult(toolUseRaw) ? toolUseRaw : null;
  const agentResults = Object.values(state.taskResults).filter(isAgentRunOutput);
  const plan = state.planning.plans[0];
  const registry =
    env.registry && typeof (env.registry as unknown as DescriptorRegistryView).get === "function"
      ? (env.registry as unknown as DescriptorRegistryView)
      : undefined;
  const descriptorInput = {
    steps: state.steps,
    plan,
    registry,
    toolUseResult: toolUse,
  };
  return mergeEvidence(
    normalizeToolObservations(toolUse),
    ...agentResults.map((result) => normalizeAgentRunEvidence(result)),
    normalizeFileWriteRecords(descriptorInput),
    normalizeExternalSourceRefs(descriptorInput),
  );
};

const buildDirectAnswerCandidate = (
  state: ExecutionPhaseOutput,
  evidence: EvidenceEntry[],
): CandidateAnswer | null => {
  const raw = state.taskResults[DIRECT_ANSWER_TASK_ID];
  if (raw === undefined) return null;
  const text = stringifyTaskResult(raw)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .trim();
  if (text.length === 0) return null;
  return {
    content: text,
    producedBy: "direct-answer",
    claims: [],
    evidence,
  };
};

const buildClaims = (evidence: EvidenceEntry[], extra: ClaimEntry[] = []): ClaimEntry[] => [
  ...mapDeterministicClaims(evidence),
  ...extra,
];

/**
 * Internal synthesis between execution and validation.
 *
 * Tool-use final-answer LLM lives here — OutputPhase must not generate new factual claims.
 */
export const runCandidateAnswerPhase = async (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): Promise<CandidateAnswerPhaseOutput> => {
  const evidence = collectEvidence(state, env);
  const direct = buildDirectAnswerCandidate(state, evidence);
  if (direct !== null) {
    return { ...state, evidence, candidateAnswer: direct };
  }

  const toolUseRaw = state.taskResults[TOOL_USE_TASK_ID];
  const toolUseResult = isToolUseResult(toolUseRaw) ? toolUseRaw : null;
  if (toolUseResult !== null) {
    const content =
      (await generateToolUseFinalAnswer(state, env, toolUseResult)) ??
      buildToolUseLocalFallbackText(state, toolUseResult);
    const candidateAnswer: CandidateAnswer = {
      content,
      producedBy: "tool-use" satisfies EvidenceProducerId,
      claims: buildClaims(evidence),
      evidence,
    };
    return { ...state, evidence, candidateAnswer };
  }

  const agentResults = Object.values(state.taskResults).filter(isAgentRunOutput);
  if (agentResults.length > 0) {
    const candidateAnswer: CandidateAnswer = {
      content: buildAgentSynthesisText(agentResults),
      producedBy: "agent-runtime",
      claims: buildClaims(evidence),
      evidence,
    };
    return { ...state, evidence, candidateAnswer };
  }

  const candidateAnswer: CandidateAnswer = {
    content: "",
    producedBy: "execution",
    claims: [],
    evidence,
  };
  return { ...state, evidence, candidateAnswer };
};
