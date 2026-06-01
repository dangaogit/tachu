import type { ToolUseResult, ValidationFinding } from "../../../../types";
import type { ValidationRule, ValidationRuleContext } from "../registry";

const isToolUseResult = (value: unknown): value is ToolUseResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === "tool-use-result";
};

/**
 * 极简 JSON Schema 校验：仅检查 `type` 与 `required`，不引入 ajv/zod。
 *
 * 设计权衡：
 * - 完整 JSON Schema 实现需 100kb+ 依赖；当前 ValidationRule 只需"任务输出
 * 是否大致符合契约"的快速判定。
 * - 真正复杂的 schema（嵌套 / oneOf / pattern）属于 host 业务范畴，由 host
 * 注入自定义 ValidationRule 覆盖。
 * - 因此本地实现限定：`type` ∈ {"object", "array", "string", "number",
 * "integer", "boolean", "null"} + 顶层 `required` 字段是否存在。
 *
 * 返回 null 表示通过；非 null 即为人类可读的失败原因。
 */
const validateAgainstMinimalSchema = (
  value: unknown,
  schema: Record<string, unknown>,
): string | null => {
  const expectedType = typeof schema.type === "string" ? schema.type : undefined;
  if (expectedType !== undefined) {
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value === "number" && Number.isInteger(value) && expectedType === "integer"
          ? "integer"
          : typeof value;
    const ok =
      (expectedType === "object" && actual === "object") ||
      (expectedType === "array" && actual === "array") ||
      (expectedType === "string" && actual === "string") ||
      (expectedType === "number" && (actual === "number" || actual === "integer")) ||
      (expectedType === "integer" && actual === "integer") ||
      (expectedType === "boolean" && actual === "boolean") ||
      (expectedType === "null" && actual === "null");
    if (!ok) return `expected type "${expectedType}", got "${actual}"`;
  }
  if (
    expectedType === "object" &&
    Array.isArray(schema.required) &&
    value !== null &&
    typeof value === "object"
  ) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      if (!(key in obj)) return `missing required field "${key}"`;
    }
  }
  return null;
};

const describeFailedSteps = (count: number): string =>
  `执行过程中有 ${count} 个步骤未成功完成`;

/**
 * deterministic.execution.steps
 *
 * 触发条件：本轮 plan 内存在 status === "failed" 的 step。
 * 严重程度：error；retryable 依据 task 错误体的 retryable 字段。
 */
export const executionFailedRule: ValidationRule = {
  id: "deterministic.execution.steps",
  kind: "deterministic",
  evaluate({ state }) {
    const failed = state.steps.filter((step) => step.status === "failed");
    if (failed.length === 0) return [];
    const retryable = failed.some(
      (step) => state.taskErrors?.[step.name]?.retryable === true,
    );
    const finding: ValidationFinding = {
      ruleId: "deterministic.execution.steps",
      kind: "deterministic",
      severity: "error",
      code: "execution_failed",
      message: describeFailedSteps(failed.length),
      userVisibleMessage: describeFailedSteps(failed.length),
      retryable,
    };
    return [finding];
  },
};

/**
 * deterministic.tool-use.status
 *
 * 触发条件：taskResults 中存在 `kind === "tool-use-result"` 且 status 不为
 * `ready_for_output` 的结果（partial / error 等）。
 *
 * 严重程度：error；retryable 依据 result.error.retryable。
 */
export const toolUsePartialRule: ValidationRule = {
  id: "deterministic.tool-use.status",
  kind: "deterministic",
  evaluate({ state }) {
    const findings: ValidationFinding[] = [];
    for (const [taskId, result] of Object.entries(state.taskResults)) {
      if (!isToolUseResult(result)) continue;
      if (result.status === "ready_for_output") continue;
      findings.push({
        ruleId: "deterministic.tool-use.status",
        kind: "deterministic",
        severity: "error",
        code: "tool_use_partial",
        message: `tool-use result for ${taskId} ended as ${result.status}`,
        userVisibleMessage:
          result.status === "partial"
            ? "工具执行只返回了部分结果。"
            : "工具循环未能生成完整可交付结果。",
        retryable: result.error?.retryable === true,
      });
    }
    return findings;
  },
};

/**
 * deterministic.output.schema
 *
 * 触发条件：plan 中存在 `type === "tool"` 的 task，其描述符声明了 `outputSchema`，
 * 且对应 `state.taskResults[task.id]` 不符合该 schema（极简 type+required 校验）。
 *
 * 严重程度：error；retryable=true（结构化输出不符通常是模型偶发问题，重试常可恢复）。
 *
 * 反模式守则：禁止在此规则内对结果做字符串关键词匹配；所有判定 grounded 在
 * descriptor.outputSchema 与 result 的结构上。
 */
export const structuredOutputViolationRule: ValidationRule = {
  id: "deterministic.output.schema",
  kind: "deterministic",
  evaluate(ctx: ValidationRuleContext) {
    const findings: ValidationFinding[] = [];
    for (const task of ctx.plan.tasks) {
      if (task.type !== "tool") continue;
      const getLatest = (ctx.registry as { getLatest?: (kind: string, name: string) => unknown }).getLatest;
      if (typeof getLatest !== "function") continue;
      const descriptor = getLatest.call(ctx.registry, "tool", task.ref) as
        | { kind?: string; outputSchema?: Record<string, unknown> | undefined }
        | null;
      if (!descriptor || descriptor.kind !== "tool") continue;
      const schema = descriptor.outputSchema;
      if (!schema || typeof schema !== "object") continue;
      if (!(task.id in ctx.state.taskResults)) continue;
      const raw = ctx.state.taskResults[task.id];
 // tool-use-result 的实际负载在 finalDraft / observations 中；用 result.output 兜底。
      const payload = isToolUseResult(raw)
        ? (raw as { finalDraft?: unknown }).finalDraft ?? raw
        : raw;
      const reason = validateAgainstMinimalSchema(payload, schema as Record<string, unknown>);
      if (reason === null) continue;
      findings.push({
        ruleId: "deterministic.output.schema",
        kind: "deterministic",
        severity: "error",
        code: "structured_output_violation",
        message: `task ${task.id} (${task.ref}) output violates schema: ${reason}`,
        userVisibleMessage: "工具返回结果与声明的结构契约不一致。",
        retryable: true,
      });
    }
    return findings;
  },
};

/**
 * deterministic.output.length-budget
 *
 * 触发条件：`env.config.validation.outputBudget.maxChars` 已配置，且
 * `state.taskResults` 中存在 string 形态结果或可序列化为 string 的结果，
 * 其长度超过 budget。
 *
 * 严重程度：warning（不阻断 Output；提示 host 可走 degrade 路径产生摘要）；
 * retryable=false（重新生成同样长内容意义不大）。
 *
 * 设计取舍：本规则消费 ExecutionPhase 已落地的 taskResults，不涉及 Output
 * 阶段的最终回答（Output δ 的 fallback 由 outcome.kind 决定）。
 */
export const lengthBudgetExceededRule: ValidationRule = {
  id: "deterministic.output.length-budget",
  kind: "deterministic",
  evaluate(ctx: ValidationRuleContext) {
    const cfgValidation = (
      ctx.state as unknown as {
        validationConfig?: { outputBudget?: { maxChars?: number } };
      }
    ).validationConfig;
 // outputBudget 的真实读取在 phase.ts；此处通过 state 透传字段实现解耦。
    const maxChars =
      typeof cfgValidation?.outputBudget?.maxChars === "number"
        ? cfgValidation.outputBudget.maxChars
        : undefined;
    if (maxChars === undefined || maxChars <= 0) return [];
    const findings: ValidationFinding[] = [];
    for (const [taskId, raw] of Object.entries(ctx.state.taskResults)) {
      const payload = isToolUseResult(raw)
        ? (raw as { finalDraft?: unknown }).finalDraft
        : raw;
      let length = 0;
      if (typeof payload === "string") {
        length = payload.length;
      } else if (payload !== undefined && payload !== null) {
        try {
          length = JSON.stringify(payload).length;
        } catch {
          continue;
        }
      } else {
        continue;
      }
      if (length <= maxChars) continue;
      findings.push({
        ruleId: "deterministic.output.length-budget",
        kind: "deterministic",
        severity: "warning",
        code: "length_budget_exceeded",
        message: `task ${taskId} output length ${length} exceeds budget ${maxChars}`,
        userVisibleMessage: "工具输出超出长度预算，可能需要摘要后再呈现。",
        retryable: false,
      });
    }
    return findings;
  },
};
