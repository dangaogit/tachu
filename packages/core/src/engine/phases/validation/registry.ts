import type { RankedPlan, ValidationFinding } from "../../../types";
import type { DescriptorRegistry } from "../../../registry";
import type { ExecutionPhaseOutput } from "../execution";
import type { CandidateAnswer, EvidenceEntry } from "../../../types/evidence";

/**
 * Phase-8 ValidationRule 接入契约。
 *
 * Phase 8（result validation）的设计原则：
 * - 每条 rule 都是 **structural / metadata-driven**，禁止字符串关键词正则。
 * - 每条 rule 都是 **deterministic** 或 **semantic** —— 二者由 `kind` 区分；
 * deterministic 规则必须可在毫秒级、无网络调用下完成评估。
 * - 每条 rule 在 `evaluate` 中只产出 0..N 条 finding；outcome reduce 由
 * `runValidationPhase` 统一处理，rule 本身不决定 retry/degrade 走向。
 *
 * `appliesTo` 仅做粗筛（执行模式 / 任务类型 / 是否有 sideEffect），
 * 真正的判定全部在 `evaluate` 内基于结构化元数据完成。
 */
export interface ValidationRuleContext {
  state: ExecutionPhaseOutput;
 /** 当前轮被执行的 Plan（state.planning.plans[0]）。 */
  plan: RankedPlan;
 /** 描述符注册表，供 rule 查询任务 sideEffect / requiresApproval 等元数据。 */
  registry: DescriptorRegistry;
 /** Host / candidate-answer phase 规范化后的 evidence。 */
  evidence: readonly EvidenceEntry[];
 /** Validation 前形成的 candidate answer（如有）。 */
  candidateAnswer?: CandidateAnswer | undefined;
}

export interface ValidationRule {
 /**
 * 全局唯一 ID，形如 `deterministic.execution.steps`、`semantic.claim.support`。
 *
 * 命名约定：`<kind>.<domain>.<topic>`，便于 host policy / observability 过滤。
 */
  readonly id: string;
  readonly kind: "deterministic" | "semantic";
 /**
 * 粗筛：返回 false 时直接跳过 evaluate；用于性能优化与显式 scoping。
 *
 * 默认 ctx 全量适配。
 */
  appliesTo?(ctx: ValidationRuleContext): boolean;
 /**
 * 评估当前轮次，返回 0..N 条 finding。
 *
 * - 不允许 throw；内部错误应转化为 `severity: "warning"` 的 finding 并附 `code`。
 * - 不允许修改 `ctx.state`。
 */
  evaluate(ctx: ValidationRuleContext): readonly ValidationFinding[];
}

/**
 * 进程级 ValidationRule 注册表。
 *
 * - 同 id 重复注册时后者覆盖前者（host 可显式替换内置 rule）。
 * - 遍历顺序 = 插入顺序，便于 host 控制 finding 累积次序。
 */
export class ValidationRuleRegistry {
  private readonly rules = new Map<string, ValidationRule>();

  register(rule: ValidationRule): void {
    this.rules.set(rule.id, rule);
  }

  unregister(id: string): boolean {
    return this.rules.delete(id);
  }

  has(id: string): boolean {
    return this.rules.has(id);
  }

  list(): readonly ValidationRule[] {
    return Array.from(this.rules.values());
  }

 /**
 * 评估全部 rule，按插入顺序累积 finding。
 *
 * deterministic 与 semantic rule 混合时由调用方决定执行策略；本方法
 * 当前对二者一视同仁，留给阶段 1 后续增量加入超时 / 预算 / 并发控制。
 */
  evaluateAll(ctx: ValidationRuleContext): ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    for (const rule of this.rules.values()) {
      if (rule.appliesTo && !rule.appliesTo(ctx)) continue;
      findings.push(...rule.evaluate(ctx));
    }
    return findings;
  }
}
