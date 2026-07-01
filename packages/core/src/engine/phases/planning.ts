import type { PlanningResult, RankedPlan, TaskNode, ToolDescriptor } from "../../types";
import type { PrecheckPhaseOutput } from "./precheck";
import type { PhaseEnvironment } from "./index";
import { engineEventFromContext } from "../turn-outcome";
import { NameMatchToolCandidateStrategy } from "../tool-activation";
import { expandDiscoverySiblings } from "../tool-activation/discovery-expansion";
import { readTurnPolicy } from "../turn-policy";

/**
 * 规划阶段决策规则（ 更新）：
 *
 * `Phase 5` 必须输出至少 1 条可执行任务，否则视为规划失败。
 * `simple` 意图 → 单步 direct-answer 子流程任务
 * `complex` 意图 + 有匹配工具 → 单步 `tool-use` 子流程任务（Agentic Loop）
 * `complex` 意图 + 无匹配工具 → 单步 direct-answer 子流程任务，带 warn=true 提示
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

const nameMatchStrategy = new NameMatchToolCandidateStrategy();

const descriptorNamesMatchedByName = async (
  prompt: string,
  descriptors: ReadonlyArray<{ name: string; description: string; displayName?: string | undefined; tags?: string[] | undefined; deprecated?: boolean | undefined }>,
  env: PhaseEnvironment,
  state: PrecheckPhaseOutput,
): Promise<string[]> => {
  if (prompt.trim().length === 0 || descriptors.length === 0) return [];
  const asTools: ToolDescriptor[] = descriptors.map((descriptor) => ({
    kind: "tool",
    name: descriptor.name,
    description: descriptor.description,
    ...(descriptor.displayName !== undefined ? { displayName: descriptor.displayName } : {}),
    ...(descriptor.tags !== undefined ? { tags: descriptor.tags } : {}),
    ...(descriptor.deprecated !== undefined ? { deprecated: descriptor.deprecated } : {}),
    sideEffect: "readonly",
    idempotent: true,
    requiresApproval: false,
    timeout: 0,
    inputSchema: {},
    execute: "<name-match-only>",
  }));
  const contributions = await nameMatchStrategy.score({
    query: prompt,
    agentVisibleTools: asTools,
    registry: env.registry,
    observability: env.observability,
    signal: env.activeAbortSignal,
    correlation: state.context.correlation,
    subject: state.context.subject,
  });
  return [...new Set(contributions.map((contribution) => contribution.toolName))];
};

/**
 * 构造 direct-answer 兜底任务。
 *
 * @param prompt Phase 3 的 intent 摘要或原始输入字符串（哪个有用就用哪个）
 * @param warn 若为 true 会让 direct-answer Sub-flow 在答复中坦诚说明"未匹配到工具"
 */
const buildDirectAnswerTask = (prompt: string, warn: boolean): TaskNode => {
  const taskInput: Record<string, unknown> = warn ? { prompt, warn: true } : { prompt };
  return {
    id: "task-direct-answer",
    type: "sub-flow",
    ref: "direct-answer",
    input: taskInput,
  };
};

/**
 * 构造 Agentic `tool-use` 子流程任务（
 *
 * 整个 Agentic Loop 被包装成一个任务节点——循环内的每次工具调用由子流程内部处理，
 * 不再占用 DAG 上的独立节点。这保证 Planning 对 simple / complex 的输出结构同构，
 * 便于 Phase 6 保持"单任务 DAG"的简化假设。
 */
const buildToolUseTask = (prompt: string, toolNames?: string[]): TaskNode => ({
  id: "task-tool-use",
  type: "sub-flow",
  ref: "tool-use",
  input:
    toolNames && toolNames.length > 0
      ? { prompt, toolNames }
      : { prompt },
});

const buildAgentTasks = (intent: string, agentNames: readonly string[]): TaskNode[] =>
  agentNames.map((agentName) => ({
    id: `task-agent-${agentName}`,
    type: "agent",
    ref: agentName,
    input: { objective: intent },
  }));

const CURRENT_TIME_MARKERS: readonly RegExp[] = [
  /(?:当前|现在|此刻|今天|今日).{0,12}(?:时间|日期|几点|几号)/u,
  /(?:时间|日期|几点|几号).{0,12}(?:当前|现在|此刻|今天|今日)/u,
  /^\s*(?:时间|日期|几点|几号|当前时间|当前日期)\s*$/u,
  /\b(?:current\s+(?:date|time)|date\s+now|time\s+now|what'?s\s+the\s+time|today'?s\s+date)\b/i,
];

const shouldLimitToRunShell = (prompt: string, intentSummary: string): boolean => {
  const text = `${prompt}\n${intentSummary}`.trim();
  if (text.length === 0) return false;
 return CURRENT_TIME_MARKERS.some((pattern) => pattern.test(text));
};

/**
 * 阶段 5：任务规划（ 更新）。
 *
 * 输出约束：
 * 1. plans.length >= 1
 * 2. plans[0].tasks.length >= 1
 * 3. simple 意图 → 单步 direct-answer 任务
 * 4. complex 意图 + 有匹配工具 → 单步 `tool-use` 任务（Agentic Loop）
 * 5. complex 意图 + 无匹配工具 → 单步 direct-answer 任务（warn=true）
 */
export const runPlanningPhase = async (
  state: PrecheckPhaseOutput,
  env: PhaseEnvironment,
): Promise<PrecheckPhaseOutput & { planning: PlanningResult }> => {
  const prompt = extractPrompt(state.input.content);
  const intentSummary = state.intent.intent.length > 0 ? state.intent.intent : prompt;
  const turnPolicy = readTurnPolicy(state.input);

 // Engine 触发 turn-level retry 时，PhaseEnvironment.previousAttempt
 // 会被填充。本阶段需要：(a) emit 一条 progress 事件以便观测/审计；
 // (b) 把上一轮的 outcome 摘要透传给 planner 作为评分提示（短期仅记录，未来由
 // candidate strategy 消费）。当 previousAttempt 缺省时此分支不产生任何副作用。
  if (env.previousAttempt) {
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "planning",
      type: "progress",
      payload: {
        reason: "previous-attempt-injected",
        intent: intentSummary,
        previousAttempt: env.previousAttempt,
      },
    }));
  }

 // Resolve visible tools via ToolActivator.
  let visibleTools: ToolDescriptor[] | undefined;
  if (env.toolActivator) {
    const toolResult = await env.toolActivator.activate({
      query: prompt,
      agentVisibleTools: [
        ...(env.scope?.additionalTools ?? []),
        ...env.registry.list("tool"),
      ],
      registry: env.registry,
      observability: env.observability,
      signal: env.activeAbortSignal,
      correlation: state.context.correlation,
      subject: state.context.subject,
      disableAllStrategies: env.scope?.toolRoutingDisabled === true,
      turnPolicy,
      ...(env.semanticRetrieval !== undefined
        ? { semanticRetrieval: env.semanticRetrieval }
        : {}),
      ...(env.config.runtime.toolActivation?.discoveryExpansion !== undefined
        ? { discoveryExpansion: env.config.runtime.toolActivation.discoveryExpansion }
        : {}),
    });
    visibleTools = toolResult.visibleTools;
  }

  const candidateTools = visibleTools ?? [
    ...(env.scope?.additionalTools ?? []),
    ...env.registry.list("tool"),
  ];

  const candidateToolNames = candidateTools.map((tool) => tool.name);
  const candidateAgents = env.registry.list("agent");
  const candidateAgentNames = candidateAgents.map((agent) => agent.name);
  const explicitAgentNames = await descriptorNamesMatchedByName(prompt, candidateAgents, env, state);
  const promptExplicitToolNames = await descriptorNamesMatchedByName(
    prompt,
    candidateTools,
    env,
    state,
  );
  const explicitToolNames = [
    ...new Set([
      ...(env.scope?.explicitToolNames ?? []),
      ...promptExplicitToolNames,
    ]),
  ].filter((name) => candidateToolNames.includes(name));
  const includeToolNames = turnPolicy.includeTools.filter((name) =>
    candidateToolNames.includes(name),
  );

 // 发现工具展开（Change 1）：pin 一个「动作类」工具时把同域「发现/列举类」兄弟
 // 一并纳入本轮下发给 tool-use 的工具集，避免弱模型盲猜标识符。这是「模型实际收到
 // 的工具集」的真正收窄点——tool-use 会用 input.toolNames 硬过滤 prebuilt tools。
 // 「宇宙」取全量注册工具（而非被激活收窄后的 candidateToolNames），否则被饿掉的
 // 兄弟不在候选里、无从并入。enabled=false / 未配置时为纯 no-op，完全等价现状。
  const discoveryExpansion = env.config.runtime.toolActivation?.discoveryExpansion;
  const registeredToolNames = new Set<string>([
    ...(env.scope?.additionalTools ?? []).map((tool) => tool.name),
    ...env.registry.list("tool").map((tool) => tool.name),
  ]);
  const excludeToolSet = new Set<string>(turnPolicy.excludeTools);
  const applyDiscoveryExpansion = (names: string[]): string[] =>
    discoveryExpansion
      ? expandDiscoverySiblings(names, discoveryExpansion, registeredToolNames, excludeToolSet)
      : names;

  let tasks: TaskNode[];
  if (explicitAgentNames.length > 0) {
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "planning",
      type: "progress",
      payload: {
        decision: "agent-batch",
        selectedAgentNames: explicitAgentNames,
        intent: intentSummary,
        reason: "explicit-agent-mention",
      },
    }));
    tasks = buildAgentTasks(intentSummary, explicitAgentNames);
  } else if (explicitToolNames.length > 0) {
    const expandedToolNames = applyDiscoveryExpansion(explicitToolNames);
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "planning",
      type: "progress",
      payload: {
        decision: "tool-use",
        toolCount: candidateTools.length,
        selectedToolNames: expandedToolNames,
        intent: intentSummary,
        reason: "explicit-tool-mention",
      },
    }));
    tasks = [buildToolUseTask(intentSummary, expandedToolNames)];
  } else if (includeToolNames.length > 0) {
    const expandedToolNames = applyDiscoveryExpansion(includeToolNames);
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "planning",
      type: "progress",
      payload: {
        decision: "tool-use",
        toolCount: candidateTools.length,
        selectedToolNames: expandedToolNames,
        intent: intentSummary,
        reason: "intent-turn-policy-include",
      },
    }));
    tasks = [buildToolUseTask(intentSummary, expandedToolNames)];
  } else if (state.intent.complexity === "simple") {
    tasks = [buildDirectAnswerTask(intentSummary, false)];
  } else {
    if (candidateTools.length > 0) {
      const selectedToolNames =
        shouldLimitToRunShell(prompt, intentSummary) &&
        candidateTools.some((tool) => tool.name === "run-shell")
          ? ["run-shell"]
          : undefined;
      env.observability.emit(engineEventFromContext(state.context, {
        timestamp: Date.now(),
        phase: "planning",
        type: "progress",
        payload: {
          decision: "tool-use",
          toolCount: candidateTools.length,
          ...(selectedToolNames ? { selectedToolNames } : {}),
          intent: intentSummary,
        },
      }));
      tasks = [buildToolUseTask(intentSummary, selectedToolNames)];
    } else {
      env.observability.emit(engineEventFromContext(state.context, {
        timestamp: Date.now(),
        phase: "planning",
        type: "warning",
        payload: {
          reason: "no matching tool/agent found; falling back to direct-answer sub-flow",
          intent: intentSummary,
        },
      }));
      tasks = [buildDirectAnswerTask(intentSummary, true)];
    }
  }

 // 后置守护：任何情况下 tasks 都不允许为空。
 // 这层判断是为了兜住"上游重构误删分支"这种低概率但高代价的回归。
  if (tasks.length === 0) {
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "planning",
      type: "warning",
      payload: {
        reason: "planning produced empty task list; enforcing direct-answer fallback",
        intent: intentSummary,
      },
    }));
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
  const planning: PlanningResult = {
    plans: [plan],
    ...(visibleTools !== undefined ? { visibleTools } : {}),
  };
  await env.runtimeState.update(state.context.correlation.sessionId, {
    currentPhase: "planning",
    activePlan: plan,
  });
  return { ...state, planning };
};
