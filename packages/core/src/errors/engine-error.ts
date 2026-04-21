/**
 * 错误面向用户的语言。
 *
 * 自 patch-01-fallback 起，每个 `EngineError` 实例都携带一份 `userMessage`，
 * 用于直接渲染给终端用户（不含内部术语、不含 code/stack/内部步骤 ID）。
 *
 * 当前只实现 `zh-CN`；`en-US` 保留占位 hook，便于后续追加英文模板。
 */
export type ErrorLocale = "zh-CN" | "en-US";

let currentLocale: ErrorLocale = "zh-CN";

/**
 * 设置后续构造的 `EngineError` 默认使用的语言。
 *
 * 仅影响"未显式传入 userMessage"的 error；已构造的实例不会被追溯修改。
 */
export const setErrorLocale = (locale: ErrorLocale): void => {
  currentLocale = locale;
};

/**
 * 读取当前错误语言。
 */
export const getErrorLocale = (): ErrorLocale => currentLocale;

type UserMessageTemplate = (context?: Record<string, unknown>) => string;

/**
 * 中文 userMessage 模板表。
 *
 * 覆盖 core 与 extensions 中所有已知的 `code`：
 *   - 对每个 code 提供一句"问题是什么"+ 一句"你可以怎么做"的文案
 *   - 不得包含内部术语：`Phase \d+` / `task-tool-\d+` / `direct-answer 子流程` /
 *     `capability 路由` / `Tool / Agent 描述符`
 *   - 不得引用错误 code 本身（留给开发者日志）
 *   - 必须 ≥ 20 字 ≤ 200 字；便于 CLI 单屏展示
 */
const USER_MESSAGE_ZH: Record<string, UserMessageTemplate> = {
  __DEFAULT__: () =>
    "引擎出现未知错误。请稍后再试；若持续出现，建议检查网络与配置后重试。",

  ENGINE_UNKNOWN_ERROR: () =>
    "引擎出现未知错误。请稍后再试；若持续出现，建议检查网络与配置后重试。",

  SAFETY_INPUT_TOO_LARGE: (ctx) =>
    `输入内容过长（约 ${ctx?.actual ?? "超限"} 字节，上限 ${ctx?.max ?? "未知"} 字节）。请精简内容后再试。`,
  SAFETY_RECURSION_TOO_DEEP: () =>
    "请求结构过于复杂，嵌套层级超出安全阈值。请简化输入后重试。",
  SAFETY_PATH_TRAVERSAL: () =>
    "请求中包含路径穿越风险（例如 `../`），出于安全考虑已被拦截。请改用项目内部的相对或绝对路径。",
  SAFETY_POLICY_DENY: () =>
    "安全策略判定本次请求不可执行。请检查输入或调整安全策略后重试。",
  SAFETY_TOOL_NOT_ALLOWED: (ctx) =>
    `请求的工具${ctx?.tool ? ` "${ctx.tool}"` : ""}不在允许列表中。请在 safety.allowedTools 中加入该工具，或改用被允许的工具。`,
  SAFETY_TOOL_DENIED: (ctx) =>
    `工具${ctx?.tool ? ` "${ctx.tool}"` : ""}被明确禁止。如确需使用，请从 deniedTools 中移除。`,
  SAFETY_SCOPE_MISSING: () =>
    "缺少必要的作用域授权。请补全 scopes 后重试。",
  SAFETY_APPROVAL_REQUIRED: () =>
    "该操作需要人工审批，但当前环境未提供审批回调。请在应用层接入审批流程后重试。",
  SAFETY_APPROVAL_REJECTED: () =>
    "审批者拒绝了本次操作。如需继续，请调整请求后重新发起审批。",
  SAFETY_SHELL_DENYLISTED: () =>
    "命令命中危险命令黑名单（例如 rm -rf / 重定向到设备文件），已被拦截。",
  SAFETY_INVALID_URL: () =>
    "URL 格式无效。请检查后重试。",
  SAFETY_PROTOCOL_NOT_ALLOWED: () =>
    "该协议的网络请求不被允许（仅支持 http / https）。",
  SAFETY_PRIVATE_NETWORK_BLOCKED: () =>
    "为防止访问内网敏感资源，对私网 / 保留网段的请求已被阻止。",

  PROVIDER_UNAVAILABLE: (ctx) =>
    `模型服务${ctx?.provider ? ` "${ctx.provider}"` : ""}当前不可用。请稍后再试；若持续失败可切换到备用 provider。`,
  PROVIDER_CALL_FAILED: () =>
    "模型调用失败。请稍后再试；若持续失败，建议切换模型或 provider 再重试。",
  PROVIDER_AUTH_FAILED: () =>
    "模型服务认证失败。请确认 API Key 是否有效、未过期、且有对应模型的访问权限。",
  PROVIDER_RATE_LIMITED: () =>
    "模型服务正在限流。请稍后再试，或降低并发请求数。",
  PROVIDER_UPSTREAM_ERROR: () =>
    "模型上游服务返回错误。通常为临时问题，稍后重试即可。",
  PROVIDER_INVALID_INPUT: () =>
    "提交给模型的输入参数不完整或格式不正确。请检查参数后重试。",

  BUDGET_TOKEN_EXHAUSTED: (ctx) =>
    `本轮 token 预算已用尽${ctx?.used && ctx?.max ? `（${ctx.used} / ${ctx.max}）` : ""}。请简化请求、开启新会话，或在配置中提高 tokens 上限。`,
  BUDGET_TOOL_CALL_EXHAUSTED: (ctx) =>
    `工具调用次数预算已用尽${ctx?.used && ctx?.max ? `（${ctx.used} / ${ctx.max}）` : ""}。请拆分任务或在配置中提高 toolCalls 上限。`,
  BUDGET_WALL_TIME_EXHAUSTED: (ctx) =>
    `本轮执行时长预算已用尽${ctx?.used && ctx?.max ? `（${ctx.used} ms / ${ctx.max} ms）` : ""}。请稍后重试或提高时长预算。`,

  VALIDATION_INVALID_CONFIG: () =>
    "配置不合法。请对照文档检查 tachu.config.ts（尤其是 models / providers / safety 三段）。",
  VALIDATION_RESULT_FAILED: () =>
    "本次生成的结果未通过校验。可以直接重试一次；若持续失败，请简化请求或换用其他模型。",
  VALIDATION_PROMPT_TOO_LARGE: (ctx) =>
    `提示词总长度超过模型窗口${ctx?.tokens && ctx?.max ? `（${ctx.tokens} > ${ctx.max}）` : ""}。请精简输入，或切换到窗口更大的模型。`,
  VALIDATION_FILE_OPERATION: () =>
    "文件操作请求的参数不完整（例如缺少 path / operation / content）。请补全后重试。",
  VALIDATION_EMPTY_COMMAND: () =>
    "命令内容为空。请提供要执行的命令。",
  VALIDATION_INVALID_URL: () =>
    "URL 参数缺失或非法。请提供合法的 http/https URL。",
  VALIDATION_DOCUMENT_PATH: () =>
    "文档转文本请求缺少 path 参数。",
  VALIDATION_PATCH_FORMAT: () =>
    "补丁格式不合法。请确认文件符合标准的 unified diff 格式。",
  VALIDATION_PATCH_EMPTY: () =>
    "补丁内容为空，没有任何可应用的变更。",
  VALIDATION_PATCH_CONFLICT: () =>
    "补丁片段之间存在冲突，无法一次性应用。请拆分后分别提交。",
  VALIDATION_PATH_ESCAPE: () =>
    "路径超出允许的工作目录范围，已被拒绝。",

  TIMEOUT_TASK: (ctx) =>
    `任务执行超时${ctx?.timeoutMs ? `（${ctx.timeoutMs} ms）` : ""}。请稍后再试，或在配置中提高单任务超时阈值。`,
  TIMEOUT_HOOK: () =>
    "钩子执行超时。请检查自定义 hook 的外部依赖是否可用，或提高 hook 超时阈值。",
  TIMEOUT_PROVIDER_REQUEST: () =>
    "模型请求超时。通常由网络波动引起，稍后重试即可。",

  REGISTRY_DUPLICATE: (ctx) =>
    `注册冲突：尝试重复注册同名项${ctx?.name ? ` "${ctx.name}"` : ""}。请改名或在启动前反注册旧实例。`,
  REGISTRY_MISSING_DEP: () =>
    "缺少必要依赖。请检查 extensions 的注册顺序与 tachu.config.ts 中对应配置。",
  REGISTRY_MODEL_NOT_FOUND: (ctx) =>
    `未找到模型映射${ctx?.tag ? ` "${ctx.tag}"` : ""}。请在 tachu.config.ts 的 models.capabilityMapping 中补齐该能力对应的 provider + model。`,
  REGISTRY_RESERVED_NAME: () =>
    "该名称为引擎内置保留名，业务侧不可注册或注销。请改用其他名称。",

  PLANNING_GRAPH_CYCLE: () =>
    "任务规划中出现了循环依赖。请检查任务拓扑或重新组织任务拆分方式。",
  PLANNING_INVALID_PLAN: () =>
    "任务规划不合法。请检查任务定义或重新描述需求。",

  TOOL_LOOP_STEPS_EXHAUSTED: (ctx) =>
    `本轮思考与工具调用轮数已用尽${ctx?.steps ? `（${ctx.steps} 轮）` : ""}。请拆分请求或在配置中提高 toolLoopMaxSteps。`,
  TOOL_LOOP_EMPTY_TERMINAL_RESPONSE: () =>
    "模型在完成工具调用后没有给出最终回复。请稍后重试；若持续发生可切换模型。",
  TOOL_LOOP_UNKNOWN_TOOL: (ctx) =>
    `模型请求了一个未注册的工具${ctx?.tool ? ` "${ctx.tool}"` : ""}。请确认工具是否已通过描述符挂载，或在配置中允许该工具。`,
  TOOL_LOOP_TOOL_EXECUTION_FAILED: (ctx) =>
    `工具${ctx?.tool ? ` "${ctx.tool}"` : ""}执行失败。请检查该工具的日志与参数是否正确。`,
  TOOL_LOOP_PROVIDER_NO_RESPONSE: () =>
    "模型返回空响应且未请求任何工具。请稍后重试或切换模型。",
  TOOL_LOOP_APPROVAL_DENIED: (ctx) =>
    `工具${ctx?.tool ? ` "${ctx.tool}"` : ""}的执行被用户拒绝${
      ctx?.reason ? `：${ctx.reason}` : ""
    }。可以调整请求后再试，或让模型改用其它方式完成任务。`,
};

/**
 * 英文占位（仅 i18n hook，未填充具体文案）。
 *
 * 当前所有 key 都回退到中文模板；后续需要 en-US 时替换本表即可，无需改调用方。
 */
const USER_MESSAGE_EN: Record<string, UserMessageTemplate> = {
  __DEFAULT__: () => USER_MESSAGE_ZH.__DEFAULT__!(),
};

/**
 * 根据 code + 当前 locale + context 解析 userMessage。
 *
 * 未命中的 code 落到 `__DEFAULT__`；locale 缺省模板时回退到中文表。
 * 模板执行异常时（极罕见）再回退到默认文案，确保永远返回字符串。
 */
const resolveUserMessage = (code: string, context?: Record<string, unknown>): string => {
  const preferred = currentLocale === "zh-CN" ? USER_MESSAGE_ZH : USER_MESSAGE_EN;
  const template =
    preferred[code] ?? USER_MESSAGE_ZH[code] ?? USER_MESSAGE_ZH.__DEFAULT__;
  try {
    return template!(context);
  } catch {
    return USER_MESSAGE_ZH.__DEFAULT__!(context);
  }
};

/**
 * 引擎标准错误基类。
 *
 * 自 patch-01-fallback 起新增字段 `userMessage`：
 *   - 面向终端用户的短文本，不含 code / stack / 内部步骤 ID / Phase 编号
 *   - 构造时若未显式传入，由 `code + context` 查表自动填充
 *   - 通过 `toUserFacing()` 只导出 `{ code, userMessage, retryable }` 给 UI 层
 *
 * 原 `message` 字段保留 **给开发者日志 / OpenTelemetry 使用**，不改变语义。
 */
export abstract class EngineError extends Error {
  readonly code: string;
  readonly cause: unknown | undefined;
  readonly retryable: boolean;
  readonly context: Record<string, unknown> | undefined;
  /**
   * 面向终端用户的文案（不含内部术语）。
   *
   * 由构造函数根据 `code + context` 自动解析；也可以显式在 `options.userMessage` 覆盖。
   */
  readonly userMessage: string;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      context?: Record<string, unknown>;
      /**
       * 若提供，则覆盖模板表的默认中文文案。
       * 显式传入时**必须自行保证不包含内部术语**。
       */
      userMessage?: string;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
    this.context = options?.context;
    this.userMessage =
      typeof options?.userMessage === "string" && options.userMessage.trim().length > 0
        ? options.userMessage
        : resolveUserMessage(code, options?.context);
  }

  /**
   * 导出给 UI 层的脱敏投影。
   *
   * 返回的对象只含 `code` / `userMessage` / `retryable`，不含 `message` / `cause` / `context` /
   * `stack`，避免把内部信息泄漏到终端用户视野。
   */
  toUserFacing(): { code: string; userMessage: string; retryable: boolean } {
    return {
      code: this.code,
      userMessage: this.userMessage,
      retryable: this.retryable,
    };
  }

  /**
   * 把任意异常包装成统一的 `EngineError`（具体落到 `HostError` 子类）。
   *
   * - 若传入值已经是 `EngineError`，直接原样返回，保留原 `code` / `context` / `userMessage`。
   * - 否则以给定 `code`（默认 `ENGINE_UNKNOWN_ERROR`）与原错误 `message` 构造
   *   `HostError`，原始错误挂在 `cause` 上；`userMessage` 走查表兜底。
   */
  static fromUnknown(
    error: unknown,
    code: string = "ENGINE_UNKNOWN_ERROR",
  ): EngineError {
    if (error instanceof EngineError) {
      return error;
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    return new HostError(code, message, { cause: error });
  }
}

/**
 * 宿主层通用错误。
 *
 * 用于 `EngineError.fromUnknown` 的落地类型；任何无法归类到具体子类的错误
 * 均包装为 `HostError`，保留原 `code` 以便观测链路区分。
 */
export class HostError extends EngineError {}

/**
 * 安全模块错误。
 */
export class SafetyError extends EngineError {
  static inputTooLarge(actual: number, max: number): SafetyError {
    return new SafetyError(
      "SAFETY_INPUT_TOO_LARGE",
      `输入过大: ${actual} bytes > ${max} bytes`,
      { context: { actual, max } },
    );
  }

  static recursionTooDeep(actual: number, max: number): SafetyError {
    return new SafetyError(
      "SAFETY_RECURSION_TOO_DEEP",
      `递归深度超限: ${actual} > ${max}`,
      { context: { actual, max } },
    );
  }

  static pathTraversal(pathValue: string): SafetyError {
    return new SafetyError("SAFETY_PATH_TRAVERSAL", `检测到路径穿越: ${pathValue}`, {
      context: { pathValue },
    });
  }
}

/**
 * Provider 调用错误。
 */
export class ProviderError extends EngineError {
  static unavailable(provider: string): ProviderError {
    return new ProviderError("PROVIDER_UNAVAILABLE", `Provider 不可用: ${provider}`, {
      retryable: true,
      context: { provider },
    });
  }

  static callFailed(provider: string, cause?: unknown): ProviderError {
    return new ProviderError("PROVIDER_CALL_FAILED", `Provider 调用失败: ${provider}`, {
      cause,
      retryable: true,
      context: { provider },
    });
  }
}

/**
 * 预算耗尽错误。
 *
 * 错误码统一使用 `_EXHAUSTED` 后缀，与 detailed-design §9.7 对齐。
 * 历史 `_EXCEEDED` 形态已在 v1 冻结前统一；外部消费方以 `code` 字段判别。
 */
export class BudgetExhaustedError extends EngineError {
  static tokenExceeded(used: number, max: number): BudgetExhaustedError {
    return new BudgetExhaustedError("BUDGET_TOKEN_EXHAUSTED", "Token 预算耗尽", {
      context: { used, max },
    });
  }

  static toolCallExceeded(used: number, max: number): BudgetExhaustedError {
    return new BudgetExhaustedError("BUDGET_TOOL_CALL_EXHAUSTED", "Tool 调用预算耗尽", {
      context: { used, max },
    });
  }

  static wallTimeExceeded(used: number, max: number): BudgetExhaustedError {
    return new BudgetExhaustedError("BUDGET_WALL_TIME_EXHAUSTED", "执行时长预算耗尽", {
      context: { used, max },
    });
  }
}

/**
 * 校验错误。
 */
export class ValidationError extends EngineError {
  static invalidConfig(message: string, context?: Record<string, unknown>): ValidationError {
    return new ValidationError(
      "VALIDATION_INVALID_CONFIG",
      message,
      context ? { context } : undefined,
    );
  }

  static invalidResult(message: string, context?: Record<string, unknown>): ValidationError {
    return new ValidationError(
      "VALIDATION_RESULT_FAILED",
      message,
      context ? { context } : undefined,
    );
  }

  /**
   * Prompt 组装结果超过模型窗口预算。
   *
   * v1 起该错误从 `BudgetExhaustedError` 迁移至 `ValidationError`：
   * 语义上它是"组装输入超过模型能力"，属于"请求形态不合法"而非"预算耗尽"。
   */
  static promptTooLarge(tokens: number, max: number): ValidationError {
    return new ValidationError(
      "VALIDATION_PROMPT_TOO_LARGE",
      `Prompt 超过模型窗口预算: ${tokens} > ${max}`,
      { context: { tokens, max } },
    );
  }
}

/**
 * 超时错误。
 */
export class TimeoutError extends EngineError {
  static taskTimeout(taskId: string, timeoutMs: number): TimeoutError {
    return new TimeoutError("TIMEOUT_TASK", `任务超时: ${taskId}`, {
      retryable: true,
      context: { taskId, timeoutMs },
    });
  }

  static hookTimeout(point: string, timeoutMs: number): TimeoutError {
    return new TimeoutError("TIMEOUT_HOOK", `Hook 超时: ${point}`, {
      retryable: true,
      context: { point, timeoutMs },
    });
  }
}

/**
 * 注册中心错误。
 */
export class RegistryError extends EngineError {
  static duplicate(kind: string, name: string): RegistryError {
    return new RegistryError("REGISTRY_DUPLICATE", `${kind} 重复注册: ${name}`, {
      context: { kind, name },
    });
  }

  static missingDependency(kind: string, name: string): RegistryError {
    return new RegistryError("REGISTRY_MISSING_DEP", `缺失依赖: ${kind}/${name}`, {
      context: { kind, name },
    });
  }

  static modelNotFound(tag: string): RegistryError {
    return new RegistryError("REGISTRY_MODEL_NOT_FOUND", `未找到模型映射: ${tag}`, {
      context: { tag },
    });
  }

  static reservedName(name: string): RegistryError {
    return new RegistryError(
      "REGISTRY_RESERVED_NAME",
      `名称 ${name} 为引擎内置保留名，业务侧不可注册或注销`,
      { context: { name } },
    );
  }
}

/**
 * 规划错误。
 */
export class PlanningError extends EngineError {
  static graphCycle(cycle: string[]): PlanningError {
    return new PlanningError("PLANNING_GRAPH_CYCLE", "任务依赖图存在环", {
      context: { cycle },
    });
  }

  static invalidPlan(message: string): PlanningError {
    return new PlanningError("PLANNING_INVALID_PLAN", message);
  }
}

/**
 * Agentic 工具循环错误（ADR-0002）。
 *
 * `tool-use` 内置 Sub-flow 执行过程中出现的各类异常：
 *   - 步数耗尽（`STEPS_EXHAUSTED`）：LLM 一直请求工具而未给出最终回复
 *   - 模型在声明 `stop` 之后返回空文本（`EMPTY_TERMINAL_RESPONSE`）
 *   - LLM 请求了一个未注册的工具（`UNKNOWN_TOOL`）
 *   - 工具执行抛错（`TOOL_EXECUTION_FAILED`）：通常包裹底层 TaskExecutor 的异常
 *   - Provider 既无 content 也无 toolCalls（`PROVIDER_NO_RESPONSE`）
 *
 * 所有子错误均带有 `retryable` 标志：`STEPS_EXHAUSTED` / `EMPTY_TERMINAL_RESPONSE` /
 * `PROVIDER_NO_RESPONSE` 属于"可重试"，其余需要调用方介入。
 */
export class ToolLoopError extends EngineError {
  static stepsExhausted(steps: number): ToolLoopError {
    return new ToolLoopError(
      "TOOL_LOOP_STEPS_EXHAUSTED",
      `Agentic 工具循环达到最大步数 ${steps}`,
      { retryable: true, context: { steps } },
    );
  }

  static emptyTerminalResponse(): ToolLoopError {
    return new ToolLoopError(
      "TOOL_LOOP_EMPTY_TERMINAL_RESPONSE",
      "模型声明停止后未返回任何文本内容",
      { retryable: true },
    );
  }

  static unknownTool(tool: string): ToolLoopError {
    return new ToolLoopError(
      "TOOL_LOOP_UNKNOWN_TOOL",
      `模型请求了未注册的工具: ${tool}`,
      { context: { tool } },
    );
  }

  static toolExecutionFailed(tool: string, cause?: unknown): ToolLoopError {
    return new ToolLoopError(
      "TOOL_LOOP_TOOL_EXECUTION_FAILED",
      `工具执行失败: ${tool}`,
      { cause, context: { tool } },
    );
  }

  static providerNoResponse(): ToolLoopError {
    return new ToolLoopError(
      "TOOL_LOOP_PROVIDER_NO_RESPONSE",
      "Provider 返回空响应且未请求任何工具",
      { retryable: true },
    );
  }

  static approvalDenied(tool: string, reason?: string): ToolLoopError {
    const context: Record<string, unknown> = { tool };
    if (reason && reason.length > 0) context.reason = reason;
    return new ToolLoopError(
      "TOOL_LOOP_APPROVAL_DENIED",
      `工具 "${tool}" 的执行被拒绝`,
      { context },
    );
  }
}
