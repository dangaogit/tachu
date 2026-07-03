import type { HookEvent, HookGuardDecision, HookPoint } from "./hooks";

/**
 * Guard 决策类型别名（`HookGuardDecision` 的 re-export）。
 *
 * rc.12 起 standalone `Guardrail` 公共接口已移除；pre/post guard 统一经
 * `HookAction` 的 `{ type: "guard"; decision }` 表达。本文件保留别名供
 * 内置 helper（`createSafetyViolationsGuardAction` 等）与测试引用。
 */
export type GuardrailPoint = Extract<HookPoint, "turnStart" | "turnStop">;

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
export type GuardrailDecision = HookGuardDecision;

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
export type GuardrailContext = HookEvent;
