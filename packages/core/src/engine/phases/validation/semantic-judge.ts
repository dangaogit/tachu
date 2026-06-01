import type {
  ValidationFinding,
  ValidationSignals,
} from "../../../types";

/**
 * SemanticJudgeAdapter 接入契约。
 *
 * 设计原则：
 * - 判定路径必须**显式可观测、可预算、可超时降级**。Judge 输出附加到
 * deterministic finding 之后再 reduce outcome，不允许悄悄替换确定性结果。
 * - 同一 turn 内**至多 N 次**（默认 2）真实 judge 调用；超出预算回退为空 finding，
 * 由 deterministic 规则独自定夺，不抛错。
 * - 单次 judge 必须设上限超时（默认 800ms）；超时回退为空 finding，并在 finding
 * 列表追加一条 `severity: "info"` 的 `semantic.judge.timeout` 用于可观测性。
 * - 同 turn 同 cacheKey 命中缓存时**不再**消耗预算。
 */
export interface SemanticJudgeInput {
 /** 完整 judge prompt（system + user 已组装）。 */
  readonly prompt: string;
 /** 当前轮次的结构化信号，便于 judge 做条件化推理。 */
  readonly signals: ValidationSignals;
 /**
 * 调用方显式指定的缓存键；未提供时由 wrapper 用 `hash(prompt) + hash(signals)`
 * 自动派生。命中缓存的判定在 wrapper 内完成。
 */
  readonly cacheKey?: string;
}

export interface SemanticJudgeAdapter {
  judge(input: SemanticJudgeInput): Promise<readonly ValidationFinding[]>;
}

/**
 * Per-turn 预算计数器。Engine 在 validation 阶段入口处构造一份并注入 wrapper；
 * 单 turn 内多次 judge 调用共享同一实例。
 */
export class JudgeBudget {
  private consumedCount = 0;

  constructor(public readonly maxCalls: number) {
    if (!Number.isInteger(maxCalls) || maxCalls < 0) {
      throw new Error(`JudgeBudget.maxCalls must be a non-negative integer; got ${maxCalls}`);
    }
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.consumedCount);
  }

  get consumed(): number {
    return this.consumedCount;
  }

 /**
 * 申请一次预算。命中返回 true 并扣减；耗尽返回 false。
 */
  consume(): boolean {
    if (this.consumedCount >= this.maxCalls) return false;
    this.consumedCount += 1;
    return true;
  }
}

/**
 * 轻量 FNV-1a 32-bit hash；用于派生 cacheKey。无加密语义，仅做去重。
 */
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const deriveCacheKey = (input: SemanticJudgeInput): string => {
  if (input.cacheKey !== undefined && input.cacheKey.length > 0) return input.cacheKey;
  const signalsBlob = JSON.stringify({
    n: input.signals.intentValidationNeed ?? "none",
    c: input.signals.finalAnswerHasClaims,
    o: input.signals.hasToolObservations,
    s: input.signals.hasExternalSources,
    w: input.signals.hasFileWrites,
    p: input.signals.hasPartialOrErrorObservations,
    d: input.signals.descriptorSemanticRequired,
    m: input.signals.policyMode,
  });
  return `${fnv1a(input.prompt)}:${fnv1a(signalsBlob)}`;
};

export interface BudgetedSemanticJudgeOptions {
  readonly inner: SemanticJudgeAdapter;
  readonly budget: JudgeBudget;
 /** 单次 judge 调用超时（毫秒）。默认 800ms。 */
  readonly timeoutMs?: number;
 /** 缓存上限；超过 LRU 驱逐。默认 128。 */
  readonly cacheCapacity?: number;
}

/**
 * 给任意 `SemanticJudgeAdapter` 补上 cache + budget + timeout fallback 三层封装。
 *
 * 失败路径行为：
 * - 预算耗尽：返回空 finding，调用 `inner.judge` 0 次（缓存未命中前提下）；
 * - 超时：返回 `[ { ruleId: "semantic.judge", code: "semantic.judge.timeout", severity: "info", … } ]`；
 * - inner throw：返回 `[ { …, code: "semantic.judge.error", severity: "warning", … } ]`，吞错不向上抛。
 *
 * 上述失败路径**仍然消耗预算**——避免反复触发昂贵 fallback。
 */
export class BudgetedSemanticJudgeAdapter implements SemanticJudgeAdapter {
  private readonly inner: SemanticJudgeAdapter;
  private readonly budget: JudgeBudget;
  private readonly timeoutMs: number;
  private readonly cacheCapacity: number;
  private readonly cache = new Map<string, readonly ValidationFinding[]>();

  constructor(opts: BudgetedSemanticJudgeOptions) {
    this.inner = opts.inner;
    this.budget = opts.budget;
    this.timeoutMs = opts.timeoutMs ?? 800;
    this.cacheCapacity = opts.cacheCapacity ?? 128;
    if (this.timeoutMs <= 0) {
      throw new Error(`BudgetedSemanticJudgeAdapter.timeoutMs must be > 0; got ${this.timeoutMs}`);
    }
    if (this.cacheCapacity < 1) {
      throw new Error(
        `BudgetedSemanticJudgeAdapter.cacheCapacity must be >= 1; got ${this.cacheCapacity}`,
      );
    }
  }

  async judge(input: SemanticJudgeInput): Promise<readonly ValidationFinding[]> {
    const key = deriveCacheKey(input);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
 // LRU touch: 移到末尾。
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (!this.budget.consume()) {
      const findings: readonly ValidationFinding[] = [
        {
          ruleId: "semantic.judge",
          kind: "semantic",
          severity: "info",
          code: "semantic.judge.budget_exhausted",
          message: "semantic judge budget exhausted for this turn; deterministic only",
        },
      ];
      this.writeCache(key, findings);
      return findings;
    }
    const findings = await this.runWithTimeout(input);
    this.writeCache(key, findings);
    return findings;
  }

  private writeCache(key: string, findings: readonly ValidationFinding[]): void {
    if (this.cache.size >= this.cacheCapacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, findings);
  }

  private async runWithTimeout(
    input: SemanticJudgeInput,
  ): Promise<readonly ValidationFinding[]> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<readonly ValidationFinding[]>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve([
          {
            ruleId: "semantic.judge",
            kind: "semantic",
            severity: "info",
            code: "semantic.judge.timeout",
            message: `semantic judge timed out after ${this.timeoutMs}ms; deterministic only`,
          },
        ]);
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        this.inner.judge(input).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          return [
            {
              ruleId: "semantic.judge",
              kind: "semantic",
              severity: "warning",
              code: "semantic.judge.error",
              message: `semantic judge threw: ${message}; deterministic only`,
            },
          ] as readonly ValidationFinding[];
        }),
        timeoutPromise,
      ]);
      return result;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}
