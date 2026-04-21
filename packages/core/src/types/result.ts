/**
 * 意图分析结果。
 *
 * `IntentResult` 以复杂度 + 意图摘要 + 会话相关性为主干；
 * 文生图由可选字段 `textToImage` 表达（见 Intent LLM JSON）。
 * 不包含 `directAnswer`：面向用户的自然语言答复统一由 Phase 7 的内置
 * Sub-flow `direct-answer` 产出（参见 ADR 0001）。
 */
export interface IntentResult {
  complexity: "simple" | "complex";
  intent: string;
  contextRelevance: "related" | "unrelated";
  /**
   * Intent LLM 判定用户是否要求**文生图**（输出图像），非读图、非纯文字创作。
   * 与 {@link InputMetadata.textToImage} 对齐；显式 CLI 路径可不经过 LLM。
   */
  textToImage?: boolean | undefined;
  relevantContext?: unknown | undefined;
}

/**
 * 任务节点。
 */
export interface TaskNode {
  id: string;
  type: "tool" | "agent" | "sub-flow";
  ref: string;
  input: Record<string, unknown>;
  contextSlice?: unknown | undefined;
  /**
   * 引擎内部在调度链条上附加的元数据，不对 planner / LLM 暴露。
   *
   * 目前承载：
   *   - `approvalGranted`：当 `tool-use` sub-flow 的 `onBeforeToolCall` 审批
   *     通过（`{ type: "approve" }`）后写入。宿主的 TaskExecutor 可据此决定
   *     是否对该次调用豁免工作区沙箱等静态策略 —— 语义上用户已经通过
   *     argumentsPreview 看到并确认了参数（含路径等敏感字段）。
   *     注意：没有审批回调或审批未触发时此字段**不会被设置**；宿主应把
   *     `metadata?.approvalGranted !== true` 视作"未经用户明确授权"并走默认沙箱。
   */
  metadata?: {
    approvalGranted?: boolean;
  } | undefined;
}

/**
 * 任务依赖边。
 */
export interface TaskEdge {
  from: string;
  to: string;
}

/**
 * 排名方案。
 */
export interface RankedPlan {
  rank: number;
  tasks: TaskNode[];
  edges: TaskEdge[];
}

/**
 * 规划结果。
 */
export interface PlanningResult {
  plans: RankedPlan[];
}

/**
 * 结果验证结构。
 */
export interface ValidationResult {
  passed: boolean;
  diagnosis?: {
    type: "execution_issue" | "planning_issue";
    reason: string;
    /**
     * 失败任务 ID 列表（可选）。
     *
     * 用于：
     *   - Orchestrator 在切换备选方案时定位"失败子图"
     *   - Output 阶段在 honest fallback 中输出"哪些任务失败"
     */
    failedTaskIds?: string[];
  } | undefined;
}

