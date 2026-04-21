import { SafetyError, type ExecutionContext, type TaskExecutor, type TaskNode } from "@tachu/core";

/**
 * `run-shell` 默认命令黑名单。
 *
 * 命中任一条目即拒绝执行。匹配方式为："在命令 + 参数拼接成的字符串上做正则 test"，
 * 因此既能拦截 `rm -rf /` 这种直接形态，也能拦截 `/bin/rm -rf /` / `rm -rfv /`
 * 等等价表达。非穷尽：旨在捕获最具破坏性的常见形态，更严格的策略由宿主自行补充。
 */
export const DEFAULT_SHELL_COMMAND_DENYLIST: ReadonlyArray<RegExp> = [
  // rm 递归+强制删除根目录（或以 / 开头的敏感目录）
  /(^|\/|\s)rm\b[^|;&]*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*[^|;&]*\s+(\/|\/\*|\/bin|\/etc|\/usr|\/var|\/home|\/root|\/boot|~)/i,
  // mkfs / mkfs.* 创建文件系统（易破坏磁盘）
  /(^|\/|\s)mkfs(\.|\s)/i,
  // dd 向设备写入
  /(^|\/|\s)dd\b[^|;&]*\sof=\/dev\//i,
  // shutdown / reboot / halt / poweroff / init 0
  /(^|\/|\s)(shutdown|reboot|halt|poweroff)\b/i,
  /(^|\/|\s)init\s+0\b/i,
  // Fork bomb 典型形态 :(){:|:&};:
  /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}\s*;/,
  // curl / wget | sh 链式下载直接执行
  /(^|\/|\s)(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh|fish)\b/i,
  // sudo 提权（默认 gate 下禁止）
  /(^|\/|\s)sudo\b/i,
  // chmod 777 根级目录
  /(^|\/|\s)chmod\b[^|;&]*\s7{2,3}\s+\/(\s|$)/i,
];

/**
 * 命令黑名单检查入参：对 `command + args` 的拼接形态做正则 test。
 */
export interface ShellCommandCheckInput {
  command: string;
  args?: readonly string[] | undefined;
}

/**
 * 判断某 shell 命令是否命中黑名单。
 *
 * 拼接规则：`command` 与 `args` 以单空格拼接；regex 在该字符串上以 `test` 进行匹配。
 */
export const matchesShellDenylist = (
  input: ShellCommandCheckInput,
  denylist: ReadonlyArray<RegExp> = DEFAULT_SHELL_COMMAND_DENYLIST,
): RegExp | null => {
  const joined = [input.command, ...(input.args ?? [])].join(" ");
  for (const pattern of denylist) {
    if (pattern.test(joined)) {
      return pattern;
    }
  }
  return null;
};

/**
 * 审批回调签名。返回 `true` 放行，返回 `false` 视为拒绝。
 *
 * 允许异步：宿主可据此接入 TUI / HTTP 审批流。
 */
export type ApprovalProvider = (
  task: TaskNode,
  context: ExecutionContext,
) => Promise<boolean>;

/**
 * Default Tool Gate 策略集合。
 *
 * 所有字段均可选：未配置的字段一律视为"不做该项检查"。
 */
export interface DefaultGatePolicies {
  /**
   * 允许执行的 tool 名称白名单。
   *
   * 当设置且 `task.ref` 不在其中时，视为拒绝。`undefined` 表示不做白名单过滤。
   */
  allowTools?: readonly string[] | undefined;
  /**
   * 禁止执行的 tool 名称黑名单。
   *
   * 命中 `task.ref` 即拒绝。与 `allowTools` 同时出现时，`denyTools` 优先。
   */
  denyTools?: readonly string[] | undefined;
  /**
   * 按 tool 名声明所需 scopes。
   *
   * 调用方在 `ExecutionContext.scopes` 中必须**全部包含**该列表，否则拒绝。
   * 该字段与 descriptor 上的 scopes 字段互补：descriptor 管"工具声明的需求"，
   * 这里管"宿主策略强制追加的需求"。
   */
  scopeRequirements?: Record<string, readonly string[]> | undefined;
  /**
   * 按 tool 名覆盖/追加 requiresApproval 决策。
   *
   * 未出现的 tool 以其 descriptor 的 `requiresApproval` 为准；出现且为 `true`
   * 时必须通过 `approvalProvider` 获取放行凭据，否则拒绝。
   */
  requiresApproval?: Record<string, boolean> | undefined;
  /**
   * 审批回调。当策略命中 approval 要求时调用。
   *
   * 未配置时等价于"所有 approval 要求一律拒绝"，确保默认闭合（deny by default）。
   */
  approvalProvider?: ApprovalProvider | undefined;
  /**
   * run-shell 命令黑名单覆盖。未显式提供时使用 {@link DEFAULT_SHELL_COMMAND_DENYLIST}。
   *
   * 宿主可传入 `[]` 显式关闭，但**强烈不建议**。
   */
  shellDenylist?: ReadonlyArray<RegExp> | undefined;
  /**
   * 可选：命中策略时的额外观察回调。
   *
   * helper 本身不直接依赖 observability，为了保持 zero-deps，采用 callback 形态；
   * 宿主可在此处转发到 `ObservabilityEmitter` 或自有日志系统。
   */
  onViolation?: ((violation: GateViolation) => void) | undefined;
}

/**
 * 默认闸门拒绝原因。
 */
export type GateViolationReason =
  | "denied-by-allowlist"
  | "denied-by-denylist"
  | "missing-scope"
  | "approval-required"
  | "approval-rejected"
  | "shell-denylist";

/**
 * 闸门违例详情。
 */
export interface GateViolation {
  reason: GateViolationReason;
  task: TaskNode;
  message: string;
  /** 额外上下文（missing scope 名；命中的 regex；等） */
  context?: Record<string, unknown>;
}

/**
 * 在 inner executor 外围包装默认 Tool 闸门。
 *
 * 语义：
 *   - 对 `task.type !== "tool"` 的任务直接透传（sub-flow / agent 走各自的安全路径）。
 *   - 对 `task.type === "tool"` 的任务按 allowlist → denylist → scopes → approval → shell-denylist
 *     的顺序做 fail-fast 检查；任一未通过即抛 `SafetyError`，并通过 `onViolation` 回调上报。
 *
 * 不修改 task 输入，不包装 inner 的异常。宿主在 `tachu.config.ts` 显式 opt-in
 * `safety.defaultGate: true` 时，由 engine-factory 将其包裹到默认 TaskExecutor 外层。
 *
 * @param inner 被包装的 TaskExecutor
 * @param policies 策略集合
 * @returns 带默认闸门的 TaskExecutor
 */
export const withDefaultGate = (
  inner: TaskExecutor,
  policies: DefaultGatePolicies = {},
): TaskExecutor => {
  const shellDenylist = policies.shellDenylist ?? DEFAULT_SHELL_COMMAND_DENYLIST;

  const notify = (violation: GateViolation): void => {
    try {
      policies.onViolation?.(violation);
    } catch {
      // 回调失败不阻塞主策略返回
    }
  };

  return async (task: TaskNode, context: ExecutionContext, signal: AbortSignal) => {
    if (task.type !== "tool") {
      return inner(task, context, signal);
    }

    if (policies.allowTools && !policies.allowTools.includes(task.ref)) {
      const violation: GateViolation = {
        reason: "denied-by-allowlist",
        task,
        message: `tool "${task.ref}" 不在默认闸门允许列表中`,
        context: { allowTools: [...policies.allowTools] },
      };
      notify(violation);
      throw new SafetyError("SAFETY_TOOL_NOT_ALLOWED", violation.message, {
        context: {
          tool: task.ref,
          reason: violation.reason,
        },
      });
    }

    if (policies.denyTools?.includes(task.ref)) {
      const violation: GateViolation = {
        reason: "denied-by-denylist",
        task,
        message: `tool "${task.ref}" 命中默认闸门拒绝列表`,
        context: { denyTools: [...policies.denyTools] },
      };
      notify(violation);
      throw new SafetyError("SAFETY_TOOL_DENIED", violation.message, {
        context: {
          tool: task.ref,
          reason: violation.reason,
        },
      });
    }

    const requiredScopes = policies.scopeRequirements?.[task.ref];
    if (requiredScopes && requiredScopes.length > 0) {
      const scopes = new Set(context.scopes ?? []);
      const missing = requiredScopes.filter((scope) => !scopes.has(scope) && !scopes.has("*"));
      if (missing.length > 0) {
        const violation: GateViolation = {
          reason: "missing-scope",
          task,
          message: `tool "${task.ref}" 缺少必须的 scope: ${missing.join(", ")}`,
          context: { missing, required: [...requiredScopes] },
        };
        notify(violation);
        throw new SafetyError("SAFETY_SCOPE_MISSING", violation.message, {
          context: {
            tool: task.ref,
            reason: violation.reason,
            missing,
          },
        });
      }
    }

    if (policies.requiresApproval?.[task.ref] === true) {
      if (!policies.approvalProvider) {
        const violation: GateViolation = {
          reason: "approval-required",
          task,
          message: `tool "${task.ref}" 需要 approval，但未配置 approvalProvider`,
        };
        notify(violation);
        throw new SafetyError("SAFETY_APPROVAL_REQUIRED", violation.message, {
          context: {
            tool: task.ref,
            reason: violation.reason,
          },
        });
      }
      const approved = await policies.approvalProvider(task, context);
      if (!approved) {
        const violation: GateViolation = {
          reason: "approval-rejected",
          task,
          message: `tool "${task.ref}" 未获得 approval 放行`,
        };
        notify(violation);
        throw new SafetyError("SAFETY_APPROVAL_REJECTED", violation.message, {
          context: {
            tool: task.ref,
            reason: violation.reason,
          },
        });
      }
    }

    if (task.ref === "run-shell") {
      const hit = matchesShellDenylist(
        extractShellCommand(task.input),
        shellDenylist,
      );
      if (hit) {
        const violation: GateViolation = {
          reason: "shell-denylist",
          task,
          message: `run-shell 命令命中默认黑名单: ${hit.source}`,
          context: { pattern: hit.source },
        };
        notify(violation);
        throw new SafetyError("SAFETY_SHELL_DENYLISTED", violation.message, {
          context: {
            tool: task.ref,
            reason: violation.reason,
            pattern: hit.source,
          },
        });
      }
    }

    return inner(task, context, signal);
  };
};

/**
 * 从 run-shell 任务 input 中抽取 command/args。
 *
 * 对未按约定传入的 input（例如缺少 `command`）回退为空字符串，交由 inner 的参数校验
 * 处理；这里只关心黑名单匹配本身。
 */
const extractShellCommand = (input: Record<string, unknown>): ShellCommandCheckInput => {
  const command = typeof input.command === "string" ? input.command : "";
  const args = Array.isArray(input.args)
    ? input.args.filter((value): value is string => typeof value === "string")
    : undefined;
  return args !== undefined ? { command, args } : { command };
};
