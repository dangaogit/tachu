import { resolve } from "node:path";
import { BudgetExhaustedError, SafetyError } from "../errors";
import type { EngineConfig, ExecutionContext, InputEnvelope } from "../types";
import type { ObservabilityEmitter } from "./observability";

/**
 * 引擎标准阶段名（用于 `SafetyPolicy.scope`）。
 */
export type PhaseName =
  | "session"
  | "safety"
  | "intent"
  | "precheck"
  | "planning"
  | "graph-check"
  | "execution"
  | "validation"
  | "output";

/**
 * 安全违规项（按 detailed-design §9.6 规约）。
 */
export interface SafetyViolation {
  /** 命中违规的策略 ID（基线规则使用 `baseline/*`）。 */
  policyId: string;
  /** 违规严重级别：`error` 会中止主流程，`warning` 仅用于记录。 */
  severity: "warning" | "error";
  /** 人类可读的违规描述。 */
  message: string;
  /** 额外的结构化上下文（供日志与业务拦截器使用）。 */
  details?: Record<string, unknown>;
}

/**
 * 安全检查结果。
 */
export interface SafetyResult {
  passed: boolean;
  violations: SafetyViolation[];
}

/**
 * 策略生效范围：阶段名集合或通配符。
 */
export type SafetyScope = PhaseName[] | ["*"];

/**
 * 业务安全策略。
 */
export interface SafetyPolicy {
  id: string;
  scope: SafetyScope;
  /**
   * 执行策略检查。
   *
   * 返回 `SafetyResult`：`violations` 为空表示通过；严重级 `error` 会由 SafetyModule
   * 主流程转换成 `SafetyError` 抛出，`warning` 仅记录到观察事件。
   */
  check(input: InputEnvelope, context: ExecutionContext): Promise<SafetyResult>;
}

/**
 * 安全模块接口。
 *
 * `checkBaseline` / `checkBusiness` 命中 error 时 throw `SafetyError`；命中 warning
 * 时会经由可观测通道 emit `warning` 事件但返回 `passed=true`。
 */
export interface SafetyModule {
  checkBaseline(input: InputEnvelope, context: ExecutionContext): Promise<SafetyResult>;
  /**
   * 执行业务策略检查。
   *
   * @param phase 当前处于的阶段名，默认 `"safety"`，用于匹配 `SafetyPolicy.scope`。
   */
  checkBusiness(
    input: InputEnvelope,
    context: ExecutionContext,
    phase?: PhaseName,
  ): Promise<SafetyResult>;
  /** 注册业务策略。返回可调用的取消函数，用于删除先前注册的 policy。 */
  registerPolicy(policy: SafetyPolicy): () => void;
}

const extractPotentialPaths = (input: unknown, collector: string[]): void => {
  if (!input) {
    return;
  }
  if (typeof input === "string") {
    return;
  }
  if (Array.isArray(input)) {
    for (const value of input) {
      extractPotentialPaths(value, collector);
    }
    return;
  }
  if (typeof input !== "object") {
    return;
  }
  const record = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === "string" &&
      /path|file|filepath|filename|location/i.test(key)
    ) {
      collector.push(value);
    } else {
      extractPotentialPaths(value, collector);
    }
  }
};

/**
 * 默认安全模块实现。
 */
export class DefaultSafetyModule implements SafetyModule {
  private readonly policies: SafetyPolicy[] = [];

  constructor(
    private readonly config: EngineConfig,
    private readonly observability?: ObservabilityEmitter,
  ) {}

  /**
   * 执行基线安全校验（detailed-design §9.6 五项基线）。
   *
   * 依次检查：
   * - 输入体量 `maxInputSizeBytes`，超限抛 {@link SafetyError.inputTooLarge}
   * - 递归深度 `maxRecursionDepth`，超限抛 {@link SafetyError.recursionTooDeep}
   * - 预算 `maxTokens` / `maxWallTimeMs` / `maxToolCalls`，超限抛 {@link BudgetExhaustedError}
   * - 路径穿越：从 `input.content` 里提取 `*path*` 字段，相对 `safety.workspaceRoot`
   *   解析后若逃逸工作区则抛 {@link SafetyError.pathTraversal}
   * - 提示注入模式匹配：命中 `safety.promptInjectionPatterns` 时记录 `warning`（`passed=true`）
   *
   * @param input 原始输入信封
   * @param context 执行上下文
   * @returns 基线校验结果；仅注入类为 `warning`，其他违规项以 `throw` 方式触发
   * @throws {SafetyError} 体量/递归/路径穿越命中 error 时
   * @throws {BudgetExhaustedError} 预算超限时
   */
  async checkBaseline(input: InputEnvelope, context: ExecutionContext): Promise<SafetyResult> {
    const inputSize =
      input.metadata.size ??
      (typeof input.content === "string"
        ? Buffer.byteLength(input.content, "utf8")
        : Buffer.byteLength(JSON.stringify(input.content ?? null), "utf8"));
    if (inputSize > this.config.safety.maxInputSizeBytes) {
      throw SafetyError.inputTooLarge(inputSize, this.config.safety.maxInputSizeBytes);
    }

    const depth = context.recursionDepth ?? 0;
    if (depth > this.config.safety.maxRecursionDepth) {
      throw SafetyError.recursionTooDeep(depth, this.config.safety.maxRecursionDepth);
    }

    if (
      context.budget.maxTokens !== undefined &&
      context.budget.maxTokens > this.config.budget.maxTokens
    ) {
      throw BudgetExhaustedError.tokenExceeded(
        context.budget.maxTokens,
        this.config.budget.maxTokens,
      );
    }
    if (
      context.budget.maxDurationMs !== undefined &&
      context.budget.maxDurationMs > this.config.budget.maxWallTimeMs
    ) {
      throw BudgetExhaustedError.wallTimeExceeded(
        context.budget.maxDurationMs,
        this.config.budget.maxWallTimeMs,
      );
    }
    if (
      context.budget.maxToolCalls !== undefined &&
      context.budget.maxToolCalls > this.config.budget.maxToolCalls
    ) {
      throw BudgetExhaustedError.toolCallExceeded(
        context.budget.maxToolCalls,
        this.config.budget.maxToolCalls,
      );
    }

    const candidatePaths: string[] = [];
    extractPotentialPaths(input.content, candidatePaths);
    const workspaceRoot = resolve(this.config.safety.workspaceRoot);
    for (const candidatePath of candidatePaths) {
      const fullPath = resolve(workspaceRoot, candidatePath);
      if (!fullPath.startsWith(workspaceRoot)) {
        throw SafetyError.pathTraversal(candidatePath);
      }
    }

    const violations: SafetyViolation[] = [];
    const text = typeof input.content === "string" ? input.content.toLowerCase() : "";
    for (const marker of this.config.safety.promptInjectionPatterns) {
      if (text.includes(marker.toLowerCase())) {
        const violation: SafetyViolation = {
          policyId: "baseline/prompt-injection",
          severity: "warning",
          message: `检测到可疑注入片段: ${marker}`,
          details: { marker },
        };
        violations.push(violation);
        this.emitWarning(context, "safety", violation);
      }
    }

    // baseline 5 项中仅 prompt-injection 为 warning，保留 passed=true
    return { passed: true, violations };
  }

  /**
   * 执行业务策略校验。
   *
   * 遍历已注册策略，按 `policy.scope` 过滤出与当前 `phase` 匹配的项后串行运行；
   * 命中第一条 `severity=error` 时立即抛出 {@link SafetyError}，后续策略不再执行。
   *
   * @param input 原始输入信封
   * @param context 执行上下文
   * @param phase 当前阶段名（默认 `"safety"`），用于 `policy.scope` 匹配
   * @returns 汇总后的 `SafetyResult`；`violations` 仅包含 `warning`（error 已被 throw 拦截）
   * @throws {SafetyError} 任一业务策略返回 `severity=error` 的违规时
   */
  async checkBusiness(
    input: InputEnvelope,
    context: ExecutionContext,
    phase: PhaseName = "safety",
  ): Promise<SafetyResult> {
    const violations: SafetyViolation[] = [];
    for (const policy of this.policies) {
      if (!this.isPolicyInScope(policy, phase)) {
        continue;
      }
      const result = await policy.check(input, context);
      for (const violation of result.violations) {
        violations.push(violation);
        if (violation.severity === "warning") {
          this.emitWarning(context, phase, violation);
        }
      }
      const firstError = result.violations.find((item) => item.severity === "error");
      if (firstError) {
        throw new SafetyError("SAFETY_POLICY_DENY", firstError.message, {
          context: {
            policyId: firstError.policyId,
            ...firstError.details,
          },
        });
      }
    }
    return {
      passed: violations.every((item) => item.severity !== "error"),
      violations,
    };
  }

  /**
   * 注册一条业务策略。
   *
   * 重复调用会把同一实例追加多次；若重复，请先调用返回的取消函数再注册。
   *
   * @param policy 业务策略定义
   * @returns 取消函数，调用后会从注册表中移除该策略（幂等：重复调用安全）
   * @example
   * ```ts
   * const off = safety.registerPolicy({ id: 'pii', scope: ['*'], check: async () => ({ passed: true, violations: [] }) });
   * // ...
   * off(); // 撤销注册
   * ```
   */
  registerPolicy(policy: SafetyPolicy): () => void {
    this.policies.push(policy);
    let removed = false;
    return () => {
      if (removed) {
        return;
      }
      removed = true;
      const index = this.policies.findIndex((item) => item === policy);
      if (index >= 0) {
        this.policies.splice(index, 1);
      }
    };
  }

  private isPolicyInScope(policy: SafetyPolicy, phase: PhaseName): boolean {
    const scope = policy.scope as ReadonlyArray<PhaseName | "*">;
    if (scope.includes("*")) {
      return true;
    }
    return scope.includes(phase);
  }

  private emitWarning(
    context: ExecutionContext,
    phase: PhaseName,
    violation: SafetyViolation,
  ): void {
    if (!this.observability) {
      return;
    }
    this.observability.emit({
      timestamp: Date.now(),
      traceId: context.traceId,
      sessionId: context.sessionId,
      phase,
      type: "warning",
      payload: {
        category: "safety",
        policyId: violation.policyId,
        message: violation.message,
        details: violation.details ?? {},
      },
    });
  }
}
