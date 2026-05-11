import { BudgetExhaustedError } from "../errors";
import type { EngineConfig, PlanningResult, RankedPlan } from "../types";
import type { ObservabilityEmitter } from "../modules/observability";

/**
 * 编排控制面。
 *
 * 负责计划切换、预算追踪与重规划信号发射。
 */
export class ExecutionOrchestrator {
  private plans: RankedPlan[] = [];
  private activePlanIndex = 0;
  private readonly used = {
    promptTokens: 0,
    completionTokens: 0,
    /**
     * Prompt caching 命中累计（OpenAI `prompt_tokens_details.cached_tokens`
     * / Anthropic `cache_read_input_tokens`）。仅用于 CLI/账单展示与可观测性，
     * `assertBudget` 仍按 `promptTokens + completionTokens` 全额校验。
     */
    cachedPromptTokens: 0,
    tokens: 0,
    toolCalls: 0,
    wallTimeMs: 0,
    toolLoopActiveMs: 0,
  };
  private readonly startedAt = Date.now();
  private toolLoopActiveStartedAt: number | null = null;
  private toolLoopBlockedStartedAt: number | null = null;
  private toolLoopBlockedAccumulatedMs = 0;

  constructor(
    private readonly config: EngineConfig,
    private readonly trace: { traceId: string; sessionId: string },
    private readonly emitter: ObservabilityEmitter,
  ) {}

  /**
   * 设置并排序候选规划结果。
   *
   * @param planning 规划阶段输出
   */
  setPlanningResult(planning: PlanningResult): void {
    this.plans = [...planning.plans].sort((a, b) => a.rank - b.rank);
    this.activePlanIndex = 0;
  }

  /**
   * 获取当前活动计划。
   *
   * @returns 当前执行计划
   * @throws Error 当没有可用计划时抛出
   */
  getActivePlan(): RankedPlan {
    const plan = this.plans[this.activePlanIndex];
    if (!plan) {
      throw new Error("No active plan");
    }
    return plan;
  }

  /**
   * 切换到下一个候选计划。
   *
   * @param reason 切换原因
   * @returns 新计划；若已无可切换计划则返回 null
   */
  switchToNextPlan(reason: string): RankedPlan | null {
    if (this.activePlanIndex + 1 >= this.plans.length) {
      return null;
    }
    this.activePlanIndex += 1;
    const plan = this.plans[this.activePlanIndex] ?? null;
    if (plan) {
      this.emitter.emit({
        timestamp: Date.now(),
        traceId: this.trace.traceId,
        sessionId: this.trace.sessionId,
        phase: "orchestrator",
        type: "plan_switched",
        payload: {
          reason,
          activePlanIndex: this.activePlanIndex,
        },
      });
    }
    return plan;
  }

  /**
   * 记录一次模型调用 token 消耗并执行预算校验。
   *
   * @param promptTokens 输入 token（OpenAI 把 cached 部分**已经含在内**）
   * @param completionTokens 输出 token
   * @param cachedPromptTokens Prompt caching 命中量（默认 0）；仅用于展示，
   *   不影响预算校验
   */
  recordModelUsage(
    promptTokens: number,
    completionTokens: number,
    cachedPromptTokens = 0,
  ): void {
    this.used.promptTokens += promptTokens;
    this.used.completionTokens += completionTokens;
    this.used.cachedPromptTokens += cachedPromptTokens;
    this.used.tokens = this.used.promptTokens + this.used.completionTokens;
    this.assertBudget();
  }

  /**
   * 记录一次工具调用并执行预算校验。
   */
  recordToolCall(): void {
    this.used.toolCalls += 1;
    this.assertBudget();
  }

  /**
   * 发射重规划请求事件。
   *
   * @param reason 触发重规划的原因
   */
  markReplanRequest(reason: string): void {
    this.emitter.emit({
      timestamp: Date.now(),
      traceId: this.trace.traceId,
      sessionId: this.trace.sessionId,
      phase: "orchestrator",
      type: "warning",
      payload: {
        replan: true,
        reason,
      },
    });
  }

  /**
   * 获取当前累积预算使用量。
   *
   * @returns token、toolCalls 与 wallTime 的当前用量；`cachedPromptTokens`
   *   为 prompt caching 命中量，仅用于展示
   */
  getUsage(): {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    tokens: number;
    toolCalls: number;
    wallTimeMs: number;
    toolLoopActiveMs: number;
  } {
    return {
      promptTokens: this.used.promptTokens,
      completionTokens: this.used.completionTokens,
      cachedPromptTokens: this.used.cachedPromptTokens,
      tokens: this.used.tokens,
      toolCalls: this.used.toolCalls,
      wallTimeMs: Date.now() - this.startedAt,
      toolLoopActiveMs: this.getCurrentToolLoopActiveMs(Date.now()),
    };
  }

  beginToolLoopActiveTimer(): void {
    if (this.toolLoopActiveStartedAt !== null) {
      return;
    }
    this.toolLoopActiveStartedAt = Date.now();
    this.toolLoopBlockedAccumulatedMs = 0;
    this.toolLoopBlockedStartedAt = null;
  }

  endToolLoopActiveTimer(): void {
    const now = Date.now();
    if (this.toolLoopActiveStartedAt === null) {
      return;
    }
    if (this.toolLoopBlockedStartedAt !== null) {
      this.toolLoopBlockedAccumulatedMs += now - this.toolLoopBlockedStartedAt;
      this.toolLoopBlockedStartedAt = null;
    }
    this.used.toolLoopActiveMs +=
      now - this.toolLoopActiveStartedAt - this.toolLoopBlockedAccumulatedMs;
    this.toolLoopActiveStartedAt = null;
    this.toolLoopBlockedAccumulatedMs = 0;
    this.assertBudget();
  }

  beginUserBlocking(): void {
    if (this.toolLoopActiveStartedAt === null || this.toolLoopBlockedStartedAt !== null) {
      return;
    }
    this.toolLoopBlockedStartedAt = Date.now();
  }

  endUserBlocking(): void {
    if (this.toolLoopBlockedStartedAt === null) {
      return;
    }
    this.toolLoopBlockedAccumulatedMs += Date.now() - this.toolLoopBlockedStartedAt;
    this.toolLoopBlockedStartedAt = null;
  }

  private assertBudget(): void {
    this.used.wallTimeMs = Date.now() - this.startedAt;
    if (this.used.tokens > this.config.budget.maxTokens) {
      throw BudgetExhaustedError.tokenExceeded(this.used.tokens, this.config.budget.maxTokens);
    }
    if (this.used.toolCalls > this.config.budget.maxToolCalls) {
      throw BudgetExhaustedError.toolCallExceeded(
        this.used.toolCalls,
        this.config.budget.maxToolCalls,
      );
    }
    if (this.used.wallTimeMs > this.config.budget.maxWallTimeMs) {
      throw BudgetExhaustedError.wallTimeExceeded(
        this.used.wallTimeMs,
        this.config.budget.maxWallTimeMs,
      );
    }
    const toolLoopActiveMs = this.getCurrentToolLoopActiveMs(Date.now());
    const maxToolLoopActiveMs = this.config.budget.maxToolLoopActiveMs;
    if (
      typeof maxToolLoopActiveMs === "number" &&
      toolLoopActiveMs > maxToolLoopActiveMs
    ) {
      throw BudgetExhaustedError.toolLoopActiveTimeExceeded(
        toolLoopActiveMs,
        maxToolLoopActiveMs,
      );
    }
  }

  private getCurrentToolLoopActiveMs(now: number): number {
    let current = this.used.toolLoopActiveMs;
    if (this.toolLoopActiveStartedAt === null) {
      return current;
    }
    const blocked =
      this.toolLoopBlockedAccumulatedMs +
      (this.toolLoopBlockedStartedAt !== null ? now - this.toolLoopBlockedStartedAt : 0);
    current += now - this.toolLoopActiveStartedAt - blocked;
    return current;
  }
}

