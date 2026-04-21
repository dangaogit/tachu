import type { PlanningResult, RankedPlan, TaskNode } from "../../types";
import { envelopeNeedsTextToImage } from "../../utils/input-vision";
import type { PrecheckPhaseOutput } from "./precheck";
import type { PhaseEnvironment } from "./index";

/**
 * 规划阶段决策规则（ADR-0002 更新）：
 *
 *   `Phase 5` 必须输出至少 1 条可执行任务，否则视为规划失败。
 *   `simple` 意图 → 单步 direct-answer 子流程任务
 *   `complex` 意图 + 有匹配工具 → 单步 `tool-use` 子流程任务（Agentic Loop）
 *   `complex` 意图 + 无匹配工具 → 单步 direct-answer 子流程任务，带 warn=true 提示
 *
 * **设计说明**：`complex + 有工具` 不会把前 N 个工具机械拆成独立任务并串行执行，
 * 而是统一走 `tool-use` 子流程，让 LLM 自主决定调用哪些工具、以什么参数调用、
 * 是否需要基于输出继续追问工具。
 *
 * 该文件内部还提供一个"后置守护"：`ensureNonEmptyTasks`，在极端情况下（比如上游重构
 * 导致 task 列表为空）用 direct-answer 补一条兜底，杜绝空 Plan 传到 Phase 6。
 */

const extractPrompt = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
};

/**
 * 构造 direct-answer 兜底任务。
 *
 * @param prompt Phase 3 的 intent 摘要或原始输入字符串（哪个有用就用哪个）
 * @param warn 若为 true 会让 direct-answer Sub-flow 在答复中坦诚说明"未匹配到工具"
 */
const buildDirectAnswerTask = (
  prompt: string,
  warn: boolean,
  textToImage?: boolean,
): TaskNode => {
  let taskInput: Record<string, unknown>;
  if (warn) {
    taskInput = { prompt, warn: true };
  } else if (textToImage === true) {
    taskInput = { prompt, textToImage: true };
  } else {
    taskInput = { prompt };
  }
  return {
    id: "task-direct-answer",
    type: "sub-flow",
    ref: "direct-answer",
    input: taskInput,
  };
};

/**
 * 构造 Agentic `tool-use` 子流程任务（ADR-0002）。
 *
 * 整个 Agentic Loop 被包装成一个任务节点——循环内的每次工具调用由子流程内部处理，
 * 不再占用 DAG 上的独立节点。这保证 Planning 对 simple / complex 的输出结构同构，
 * 便于 Phase 6 保持"单任务 DAG"的简化假设。
 */
const buildToolUseTask = (prompt: string): TaskNode => ({
  id: "task-tool-use",
  type: "sub-flow",
  ref: "tool-use",
  input: { prompt },
});

/**
 * 阶段 5：任务规划（ADR-0002 更新）。
 *
 * 输出约束：
 *   1. plans.length >= 1
 *   2. plans[0].tasks.length >= 1
 *   3. simple 意图 → 单步 direct-answer 任务
 *   4. complex 意图 + 有匹配工具 → 单步 `tool-use` 任务（Agentic Loop）
 *   5. complex 意图 + 无匹配工具 → 单步 direct-answer 任务（warn=true）
 */
export const runPlanningPhase = async (
  state: PrecheckPhaseOutput,
  env: PhaseEnvironment,
): Promise<PrecheckPhaseOutput & { planning: PlanningResult }> => {
  const prompt = extractPrompt(state.input.content);
  const intentSummary = state.intent.intent.length > 0 ? state.intent.intent : prompt;
  const textToImage = envelopeNeedsTextToImage(state.input);

  let tasks: TaskNode[];
  if (textToImage) {
    tasks = [buildDirectAnswerTask(intentSummary, false, true)];
  } else if (state.intent.complexity === "simple") {
    tasks = [buildDirectAnswerTask(intentSummary, false)];
  } else {
    const candidateTools = env.registry.list("tool");
    if (candidateTools.length > 0) {
      env.observability.emit({
        timestamp: Date.now(),
        traceId: state.context.traceId,
        sessionId: state.context.sessionId,
        phase: "planning",
        type: "progress",
        payload: {
          decision: "tool-use",
          toolCount: candidateTools.length,
          intent: intentSummary,
        },
      });
      tasks = [buildToolUseTask(intentSummary)];
    } else {
      env.observability.emit({
        timestamp: Date.now(),
        traceId: state.context.traceId,
        sessionId: state.context.sessionId,
        phase: "planning",
        type: "warning",
        payload: {
          reason: "no matching tool/agent found; falling back to direct-answer sub-flow",
          intent: intentSummary,
        },
      });
      tasks = [buildDirectAnswerTask(intentSummary, true)];
    }
  }

  // 后置守护：任何情况下 tasks 都不允许为空。
  // 这层判断是为了兜住"上游重构误删分支"这种低概率但高代价的回归。
  if (tasks.length === 0) {
    env.observability.emit({
      timestamp: Date.now(),
      traceId: state.context.traceId,
      sessionId: state.context.sessionId,
      phase: "planning",
      type: "warning",
      payload: {
        reason: "planning produced empty task list; enforcing direct-answer fallback",
        intent: intentSummary,
      },
    });
    tasks = [buildDirectAnswerTask(intentSummary, true)];
  }

  const edges = tasks
    .slice(1)
    .map((task, index) => ({ from: tasks[index]!.id, to: task.id }));
  const plan: RankedPlan = {
    rank: 1,
    tasks,
    edges,
  };
  const planning: PlanningResult = { plans: [plan] };
  await env.runtimeState.update(state.context.sessionId, {
    currentPhase: "planning",
    activePlan: plan,
  });
  return { ...state, planning };
};
