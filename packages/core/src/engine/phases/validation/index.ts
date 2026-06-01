import { ValidationRuleRegistry } from "./registry";
import {
  executionFailedRule,
  lengthBudgetExceededRule,
  structuredOutputViolationRule,
  toolUsePartialRule,
} from "./rules/deterministic";
import { evidenceRequiredRule } from "./rules/evidence-required";
import type { ValidationResult } from "../../../types";

export { ValidationRuleRegistry } from "./registry";
export type { ValidationRule, ValidationRuleContext } from "./registry";
export { runValidationPhase } from "./phase";
export type { ValidationPhaseOutput } from "./phase";
export {
  BudgetedSemanticJudgeAdapter,
  JudgeBudget,
} from "./semantic-judge";
export { ProviderSemanticJudgeAdapter } from "./provider-semantic-judge";
export type { ProviderSemanticJudgeAdapterOptions } from "./provider-semantic-judge";
export type {
  SemanticJudgeAdapter,
  SemanticJudgeInput,
  BudgetedSemanticJudgeOptions,
} from "./semantic-judge";

/**
 * 判定 Validation 是否视作通过。
 *
 * 优先消费结构化 `outcome.kind === "pass"`；当 host / 旧调用方未设置 outcome
 * 时回退到 `passed` 布尔字段。该 helper 是"消费 outcome.kind 替代
 * validation.passed"的统一入口。
 *
 * 后续 outcome.kind 全消费完毕后，`passed` 字段会进入正式废弃流程。
 */
export const isValidationPassing = (validation: ValidationResult): boolean => {
  if (validation.outcome !== undefined) {
    return validation.outcome.kind === "pass";
  }
  return validation.passed === true;
};

/**
 * 构造内置默认 ValidationRule 注册表。
 *
 * 顺序约定：
 * 1. `deterministic.execution.steps` —— 调度层失败先报
 * 2. `deterministic.tool-use.status` —— 工具循环失败次报
 * 3. `deterministic.output.schema` —— 工具输出违反 schema
 * 4. `deterministic.output.length-budget` —— 工具输出超出长度预算（warning）
 * 5. `deterministic.evidence.required` —— claims 缺少支撑 evidence（ P-补丁）
 *
 * Host 可通过覆盖同名 id 替换实现，或注册新 id 扩展规则集。
 */
export const buildDefaultValidationRuleRegistry = (): ValidationRuleRegistry => {
  const registry = new ValidationRuleRegistry();
  registry.register(executionFailedRule);
  registry.register(toolUsePartialRule);
  registry.register(structuredOutputViolationRule);
  registry.register(lengthBudgetExceededRule);
  registry.register(evidenceRequiredRule);
  return registry;
};
