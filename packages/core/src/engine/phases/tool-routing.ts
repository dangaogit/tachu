import type { ExecutionRoute, TaskNode, ToolDescriptor } from "../../types";
import type { SafetyPhaseOutput } from "./safety";
import type { PhaseEnvironment } from "./index";
import { engineEventFromContext } from "../turn-outcome";
import {
  NameMatchToolCandidateStrategy,
  createToolActivationProfile,
} from "../tool-activation";
import { createActivation } from "../activation";
import { expandDiscoverySiblings } from "../tool-activation/discovery-expansion";
import {
  normalizeGatingPolicy,
  readGatingPolicy,
  withGatingPolicyMetadata,
} from "../gating-policy";
import { PlanningError } from "../../errors";
import { topologicalSort } from "../../utils";

/**
 * 确定性工具路由(ADR-0006 D1/D5,取代旧的 intent 分类、计划路由与图校验步骤)。
 *
 * 深单 loop 塌陷后,不再有 LLM 分类 simple/complex,也不再有 direct-answer /
 * tool-use 两条路由分支 —— **所有请求统一构造单个 `tool-use` 任务**,工具集通过
 * `ToolActivator.visibleTools` 确定性收窄(而非全量 registry),loop 内 LLM
 * 自主决定是否调用工具;零工具调用的纯回答由 loop step-1 自然承接
 * (subsumes 原 direct-answer)。
 *
 * 例外:显式 @agent 提及仍走确定性的 agent-batch 快路径(与 complexity 分类无关,
 * 是独立的名称匹配能力,ADR-0006 未要求删除)。
 *
 * gatingPolicy 规范化(原 `finalizeIntentPhase` 职责的确定性部分保留):
 * 只消费 `scope` / 已 pre-seed 的 `input.metadata.gatingPolicy`(如 CLI 显式指定),
 * 不再有 `llm` 分量 —— hard enforcement(工具 allow/deny、技能 pin/exclude)
 * 仅由 host 显式 / config / agent snapshot 驱动,不做模型猜测。
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
  state: SafetyPhaseOutput,
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

const shouldLimitToRunShell = (prompt: string): boolean => {
  const text = prompt.trim();
  if (text.length === 0) return false;
  return CURRENT_TIME_MARKERS.some((pattern) => pattern.test(text));
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
    ...(env.scope?.activationHints?.tools ?? []).map((tool) => tool.name),
  ]);

const collectKnownSkillNames = (env: PhaseEnvironment): Set<string> =>
  new Set([
    ...listRegistryNames(env.registry, "skill"),
    ...(env.scope?.additionalSkills ?? []).map((skill) => skill.name),
    ...(env.scope?.activationHints?.skills ?? []).map((skill) => skill.name),
    ...(env.scope?.explicitSkillNames ?? []),
  ]);

/**
 * 单任务 DAG 的最小图校验(取代原独立 graph-check 步骤):校验任务引用的
 * tool/agent 存在于 registry,并跑一次拓扑排序(单任务/单边场景恒通过,
 * 保留是为了在未来任务数增多时仍有真实校验)。
 */
const validateRoute = (route: ExecutionRoute, env: PhaseEnvironment): void => {
  for (const task of route.tasks) {
    if (task.type === "tool" && !env.registry.get("tool", task.ref)) {
      throw PlanningError.invalidPlan(`任务引用了不存在的 Tool: ${task.ref}`);
    }
    if (task.type === "agent" && !env.registry.get("agent", task.ref)) {
      throw PlanningError.invalidPlan(`任务引用了不存在的 Agent: ${task.ref}`);
    }
  }
  topologicalSort(route.tasks, route.edges);
};

/**
 * `runToolRoutingPhase` 输出。
 *
 * `intent` 仅是一句从用户输入原样抽取的摘要文本（无 LLM 分类），供
 * `output.ts` 兜底文案 / `validation/phase.ts` 诊断日志等下游读取点沿用
 * `.intent.intent` 访问路径；`route` 是本轮唯一的确定性执行路由。
 */
export interface ToolRoutingPhaseOutput extends SafetyPhaseOutput {
  intent: { intent: string };
  route: ExecutionRoute;
}

/**
 * 确定性工具路由步骤(取代 intent 分类、precheck、计划分支与图校验步骤)。
 *
 * 输出约束:
 * 1. plans.length === 1, plans[0].tasks.length >= 1
 * 2. 显式 @agent 提及 → agent-batch 任务(与 complexity 无关的独立能力)
 * 3. 其余情况一律单步 `tool-use` 任务(Agentic Loop),工具集由
 *    `ToolActivator.visibleTools` 收窄;零匹配工具时 loop 仍会执行,
 *    LLM 在无 tool_call 的情况下自然产出纯文本答复(subsumes direct-answer)。
 */
export const runToolRoutingPhase = async (
  state: SafetyPhaseOutput,
  env: PhaseEnvironment,
): Promise<ToolRoutingPhaseOutput> => {
  const prompt = extractPrompt(state.input.content);

// Engine 触发 turn-level retry 时,PhaseEnvironment.previousAttempt 会被填充。
// 路由本身是确定性的,不会因上一轮 outcome 改变任务构造,这里仅 emit 一条
// progress 事件保留观测/审计能力(迁自旧计划步骤的同名机制,避免随
// 旧前置步骤删除一并悄悄丢失该诊断信号)。
  if (env.previousAttempt) {
    env.observability.emit(engineEventFromContext(state.context, {
      timestamp: Date.now(),
      phase: "preLLM",
      type: "progress",
      payload: {
        reason: "previous-attempt-injected",
        intent: prompt,
        previousAttempt: env.previousAttempt,
      },
    }));
  }

// gatingPolicy 规范化:只消费 scope / 已 pre-seed 的 metadata,不再有 LLM 分量
// (ADR-0006 D1:gatingPolicy-as-LLM-manifest 删除)。
  const policy = normalizeGatingPolicy({
    scope: env.scope,
    preseed: readGatingPolicy(state.input),
    knownToolNames: collectKnownToolNames(env),
    knownSkillNames: collectKnownSkillNames(env),
  });
  const effectiveState: SafetyPhaseOutput = {
    ...state,
    input: withGatingPolicyMetadata(state.input, policy),
  };
  const gatingPolicy = policy;

  let visibleTools: ToolDescriptor[] | undefined;
 // A 概念对齐：tool 激活经统一激活 seam（`activateDescriptors` +
 // `createToolActivationProfile`），与 rule/skill/agent 同形。旧
 // `DefaultToolActivator` 的打分/选择逻辑已抽为 `scoreToolStrategies` /
 // `selectVisibleTools`，成为本 Profile placement 的内部实现（策略只跑一次）。
  if (env.toolStrategies !== undefined) {
    const agentVisibleTools = [
      ...(env.scope?.additionalTools ?? []),
      ...env.registry.list("tool"),
    ];
    const profile = createToolActivationProfile({
      strategies: env.toolStrategies,
      gatingPolicy,
      disableAllStrategies: env.scope?.toolRoutingDisabled === true,
      ...(effectiveState.context.subject !== undefined
        ? { subject: effectiveState.context.subject }
        : {}),
      ...(env.semanticRetrieval !== undefined
        ? { semanticRetrieval: env.semanticRetrieval }
        : {}),
      ...(env.config.runtime.toolActivation?.discoveryExpansion !== undefined
        ? { discoveryExpansion: env.config.runtime.toolActivation.discoveryExpansion }
        : {}),
    });
    const activation = await createActivation({ profiles: { tool: profile } }).activate(
      "tool",
      {
        query: prompt,
        registry: { list: (kind) => (kind === "tool" ? agentVisibleTools : []) },
        observability: {
          emit: (event: unknown) =>
            env.observability.emit(event as Parameters<typeof env.observability.emit>[0]),
        },
        signal: env.activeAbortSignal,
        correlation: effectiveState.context.correlation as unknown as Record<
          string,
          unknown
        >,
      },
    );
    visibleTools = activation.active;
  }

  const candidateTools = visibleTools ?? [
    ...(env.scope?.additionalTools ?? []),
    ...env.registry.list("tool"),
  ];
  const candidateToolNames = candidateTools.map((tool) => tool.name);
  const candidateAgents = env.registry.list("agent");
  const explicitAgentNames = await descriptorNamesMatchedByName(
    prompt,
    candidateAgents,
    env,
    effectiveState,
  );
  const promptExplicitToolNames = await descriptorNamesMatchedByName(
    prompt,
    candidateTools,
    env,
    effectiveState,
  );
  const explicitToolNames = [
    ...new Set([
      ...(env.scope?.explicitToolNames ?? []),
      ...promptExplicitToolNames,
    ]),
  ].filter((name) => candidateToolNames.includes(name));
  const includeToolNames = gatingPolicy.includeTools.filter((name) =>
    candidateToolNames.includes(name),
  );

  const discoveryExpansion = env.config.runtime.toolActivation?.discoveryExpansion;
  const registeredToolNames = new Set<string>([
    ...(env.scope?.additionalTools ?? []).map((tool) => tool.name),
    ...env.registry.list("tool").map((tool) => tool.name),
  ]);
  const excludeToolSet = new Set<string>(gatingPolicy.excludeTools);
  const applyDiscoveryExpansion = (names: string[]): string[] =>
    discoveryExpansion
      ? expandDiscoverySiblings(names, discoveryExpansion, registeredToolNames, excludeToolSet)
      : names;

  let tasks: TaskNode[];
  if (explicitAgentNames.length > 0) {
    env.observability.emit(engineEventFromContext(effectiveState.context, {
      timestamp: Date.now(),
      phase: "preLLM",
      type: "progress",
      payload: {
        decision: "agent-batch",
        selectedAgentNames: explicitAgentNames,
        reason: "explicit-agent-mention",
      },
    }));
    tasks = buildAgentTasks(prompt, explicitAgentNames);
  } else {
    const selectedToolNames = explicitToolNames.length > 0
      ? applyDiscoveryExpansion(explicitToolNames)
      : includeToolNames.length > 0
        ? applyDiscoveryExpansion(includeToolNames)
        : shouldLimitToRunShell(prompt) && candidateTools.some((tool) => tool.name === "run-shell")
          ? ["run-shell"]
          : undefined;
    env.observability.emit(engineEventFromContext(effectiveState.context, {
      timestamp: Date.now(),
      phase: "preLLM",
      type: "progress",
      payload: {
        decision: "tool-use",
        toolCount: candidateTools.length,
        ...(selectedToolNames ? { selectedToolNames } : {}),
        reason:
          explicitToolNames.length > 0
            ? "explicit-tool-mention"
            : includeToolNames.length > 0
              ? "gating-policy-include"
              : "default",
      },
    }));
    tasks = [buildToolUseTask(prompt, selectedToolNames)];
  }

  const edges = tasks
    .slice(1)
    .map((task, index) => ({ from: tasks[index]!.id, to: task.id }));
  const route: ExecutionRoute = {
    tasks,
    edges,
    ...(visibleTools !== undefined ? { visibleTools } : {}),
  };
  validateRoute(route, env);

  await env.runtimeState.update(effectiveState.context.correlation.sessionId, {
    currentPhase: "tool-routing",
    activeRoute: route,
  });
  return { ...effectiveState, intent: { intent: prompt }, route };
};

export const __toolRoutingTesting = {
  shouldLimitToRunShell,
};
