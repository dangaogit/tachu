import type { ToolUseResult } from "../../types";
import type { CandidateAnswer, ClaimEntry, EvidenceEntry, EvidenceProducerId } from "../../types/evidence";
import type { ExecutionPhaseOutput } from "./execution";
import type { PhaseEnvironment } from "./index";
import { mapDeterministicClaims } from "../evidence/claim-mapper";
import {
  mergeEvidence,
  normalizeAgentRunEvidence,
  normalizeExternalSourceRefs,
  normalizeFileWriteRecords,
  normalizeToolObservations,
  type DescriptorRegistryView,
} from "../evidence/normalize";
import { sanitizeInternalTerms } from "./output";

const TOOL_USE_TASK_ID = "task-tool-use";

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

const buildAgentSynthesisText = (results: AgentRunOutput[]): string => {
  const lines = ["已完成分派任务，汇总如下：", ""];
  for (const result of results) {
    lines.push(`### ${result.agent}`);
    lines.push(stringifyTaskResult(result.output).trim() || "未返回内容。");
    lines.push("");
  }
  return sanitizeInternalTerms(lines.join("\n").trim());
};

/**
 * Tool-use 路径的 candidateAnswer 内容派生（ADR-0006 D4/C3）。
 *
 * `terminalDraft` 已在完整 prebuiltPrompt（persona + rules + active skills）下
 * 由 loop 写就，不再有独立的 final-answer LLM 重写它 —— 直接作为候选答案正文。
 *
 * 非 `ready_for_output` 状态（`partial` / `exhausted` / `failed`）不在本 phase
 * 软性捏造叙述性兜底文案：返回空内容，让下游 validation 的
 * `deterministic.tool-use.status` 规则如实判定失败，Output Phase 的确定性
 * fallback 模板接管（诚实报错 + 下一步指引，无 LLM 参与）。可恢复场景的
 * "继续 loop / 询问用户下一步" 路由属于 turnStop guardrail seam（ADR-0006 C3b），
 * 在挂载面就位前不在此提前决定。
 */
const deriveToolUseCandidateContent = (toolUseResult: ToolUseResult): string => {
  if (toolUseResult.status !== "ready_for_output") return "";
  const draft = toolUseResult.terminalDraft?.trim();
  return draft !== undefined && draft.length > 0 ? draft : "";
};

const collectEvidence = (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): EvidenceEntry[] => {
  const toolUseRaw = state.taskResults[TOOL_USE_TASK_ID];
  const toolUse = isToolUseResult(toolUseRaw) ? toolUseRaw : null;
  const agentResults = Object.values(state.taskResults).filter(isAgentRunOutput);
  const plan = state.route;
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

const buildClaims = (evidence: EvidenceEntry[], extra: ClaimEntry[] = []): ClaimEntry[] => [
  ...mapDeterministicClaims(evidence),
  ...extra,
];

/**
 * Internal synthesis between execution and validation.
 *
 * Tool-use 路径不再发起独立的 final-answer LLM 调用（ADR-0006 D4/C3）：
 * `terminalDraft` 已经是 loop 在完整 prompt 下写就的候选正文，OutputPhase
 * 仍然不得据此产生新的事实性主张。
 */
export const runCandidateAnswerPhase = async (
  state: ExecutionPhaseOutput,
  env: PhaseEnvironment,
): Promise<CandidateAnswerPhaseOutput> => {
  const evidence = collectEvidence(state, env);
  const toolUseRaw = state.taskResults[TOOL_USE_TASK_ID];
  const toolUseResult = isToolUseResult(toolUseRaw) ? toolUseRaw : null;
  if (toolUseResult !== null) {
    const candidateAnswer: CandidateAnswer = {
      content: deriveToolUseCandidateContent(toolUseResult),
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
