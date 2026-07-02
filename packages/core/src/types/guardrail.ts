import type { ExecutionCorrelation, ExecutionSubject } from "./context";

/**
 * 对称守卫 seam(ADR-0006 D4)。
 *
 * 一个通用 guardrail 契约,挂 `turnStart`(pre-guard)与 `turnStop`(post-guard):
 * 单个 guard 干合规检查、内容策略、还是质量 validation,由宿主消费方决定,
 * core 不区分语义,只区分挂载点。
 */
export type GuardrailPoint = "turnStart" | "turnStop";

/**
 * Guardrail 的处置结果。
 *
 * 恒 fail-closed:
 * - `pass`:放行,无附加处置。
 * - `block`:拒付。`turnStart` 场景中止整轮;`turnStop` 场景拒绝交付候选答案。
 * - `degrade`:放行但降级说明(如"仅确认部分内容"),`userVisibleReason` 会前缀/替换到
 *   最终 `candidateAnswer.content`。
 * - `annotate`:放行但附加简短前缀说明(如安全警告),不改写正文其余部分。
 *
 * 刻意不提供"静默重排版"语义 —— 想改格式是显式 transform,不是 guard 的职责
 * (ADR-0006 D4)。
 */
export type GuardrailDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string; readonly userVisibleReason?: string }
  | { readonly kind: "degrade"; readonly reason: string; readonly userVisibleReason: string }
  | { readonly kind: "annotate"; readonly prefix: string };

/**
 * 传给 Guardrail 的运行时上下文。
 *
 * `data` 的具体形状取决于 `point`:
 * - `turnStart`:`{ input: InputEnvelope; context: ExecutionContext; violations: SafetyViolation[] }`
 * - `turnStop`:`{ candidateAnswer: { content: string }; validation?: ValidationResult }`
 *
 * 刻意用 `unknown` 而非强类型联合,避免 `types/guardrail.ts` 反向依赖
 * `engine/phases/*` 具体阶段类型,保持这是一个可独立复用的横切契约。
 */
export interface GuardrailContext {
  readonly point: GuardrailPoint;
  readonly correlation: ExecutionCorrelation;
  readonly subject?: ExecutionSubject | undefined;
  readonly data: unknown;
}

/**
 * 一个 guardrail。
 *
 * `id` 用于 observability 审计与调试(哪个 guard 做出了处置);`run` 可同步或异步,
 * 允许宿主接入远程合规服务 / LLM judge 等真实 I/O。
 */
export interface Guardrail {
  readonly id: string;
  run(ctx: GuardrailContext): GuardrailDecision | Promise<GuardrailDecision>;
}
