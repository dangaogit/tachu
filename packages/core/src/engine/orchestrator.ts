import { BudgetExhaustedError } from "../errors";
import type { EngineConfig } from "../types";

/**
 * Turn 级预算追踪器。
 *
 * 深单 loop（ADR-0006）下不再有多方案规划 / 计划切换 / 重规划信号：本类退化
 * 为纯粹的 turn 级预算追踪与 tool-loop 计时，累计 token / tool-call /
 * wall-time / tool-loop-active，并在越界时抛 `BudgetExhaustedError` 熔断。
 */
export class ExecutionOrchestrator {
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
 /**
 * 并发工具审批（`toolLoop.parallelism`>1 且多条 tool 同时命中审批）时，
 * `beginUserBlocking` / `endUserBlocking` 会交错调用。单时间戳无法表达「仍有一条
 * 审批在飞行」，会导致第二个 begin 被忽略、用户等待时间误计入 active tool-loop，
 * 进而误触发 `maxToolLoopActiveMs`。用深度计数表示重叠的用户阻塞区间。
 */
  private userBlockingDepth = 0;

  constructor(private readonly config: EngineConfig) {}

 /**
 * 记录一次模型调用 token 消耗并执行预算校验。
 *
 * @param promptTokens 输入 token（OpenAI 把 cached 部分**已经含在内**）
 * @param completionTokens 输出 token
 * @param cachedPromptTokens Prompt caching 命中量（默认 0）；仅用于展示，
 * 不影响预算校验
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
 * 获取当前累积预算使用量。
 *
 * @returns token、toolCalls 与 wallTime 的当前用量；`cachedPromptTokens`
 * 为 prompt caching 命中量，仅用于展示
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
    this.userBlockingDepth = 0;
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
    this.userBlockingDepth = 0;
    this.assertBudget();
  }

  beginUserBlocking(): void {
    if (this.toolLoopActiveStartedAt === null) {
      return;
    }
    this.userBlockingDepth += 1;
    if (this.userBlockingDepth === 1) {
      this.toolLoopBlockedStartedAt = Date.now();
    }
  }

  endUserBlocking(): void {
    if (this.userBlockingDepth <= 0) {
      return;
    }
    this.userBlockingDepth -= 1;
    if (this.userBlockingDepth === 0 && this.toolLoopBlockedStartedAt !== null) {
      this.toolLoopBlockedAccumulatedMs += Date.now() - this.toolLoopBlockedStartedAt;
      this.toolLoopBlockedStartedAt = null;
    }
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
