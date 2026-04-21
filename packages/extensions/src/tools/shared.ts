import type { Session } from "@tachu/core";

/**
 * Tool 执行时上下文。
 *
 * 字段语义：
 *   - `workspaceRoot`：工作区根目录（绝对路径）。向后兼容保留，路径校验不再
 *     直接依赖它，而是以 {@link allowedRoots} 为准。
 *   - `allowedRoots`：允许读写的根目录列表；由宿主在 engine-factory 层组装，
 *     通常包含 `workspaceRoot`、平台临时目录（`os.tmpdir()`），以及用户通过
 *     `safety.allowedWriteRoots` 配置扩展的路径。长度 ≥ 1。
 *   - `sandboxWaived`：本次调用是否豁免沙箱（审批已通过）。见
 *     `@tachu/core` 的 `TaskNode.metadata.approvalGranted`：宿主在审批通过后
 *     把它翻译成这里的布尔值。
 *   - `session`：当前会话引用。
 *
 * 兼容性：历史代码读 `workspaceRoot` 仍然可用；新代码请走 {@link resolveAllowedPath}
 * + `allowedRoots` + `sandboxWaived` 三件套。
 */
export interface ToolExecutionContext {
  abortSignal: AbortSignal;
  workspaceRoot: string;
  allowedRoots?: readonly string[];
  sandboxWaived?: boolean;
  session: Session;
}

/**
 * Tool 执行器签名。
 */
export type ToolExecutor<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

/**
 * 检查中断状态。
 *
 * @param signal 取消信号
 * @throws Error 当已中断
 */
export const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
};

/**
 * 从 `ToolExecutionContext` 推导出本次工具调用的沙箱策略。
 *
 * 老版本 context 只有 `workspaceRoot`；本函数做一次规范化，让工具执行器
 * 不必关心调用方是否已经迁移到新字段。
 */
export const resolveSandboxPolicy = (
  context: ToolExecutionContext,
): { allowedRoots: readonly string[]; sandboxWaived: boolean } => {
  const roots = context.allowedRoots && context.allowedRoots.length > 0
    ? context.allowedRoots
    : [context.workspaceRoot];
  return {
    allowedRoots: roots,
    sandboxWaived: context.sandboxWaived === true,
  };
};
