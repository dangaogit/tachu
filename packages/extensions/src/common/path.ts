import { resolve, relative, isAbsolute } from "node:path";
import { ValidationError } from "@tachu/core";

/**
 * 解析一条工具输入路径的可选上下文。
 */
export interface ResolveAllowedPathOptions {
  /**
   * 允许访问的根目录列表（绝对路径）。相对路径会以第一个根为基准展开。
   * 至少包含一个；通常是 `[workspaceRoot, ...extraRoots]`。
   */
  allowedRoots: readonly string[];
  /**
   * 本次调用是否已经通过用户审批（见 `@tachu/core` 的 `onBeforeToolCall`）。
   *
   * 一旦为 `true`，路径校验会直接放行：语义上用户已经在审批提示里看过
   * `argumentsPreview`（包括任何路径字段）并显式同意。这条通道只用于"本次
   * 工具调用"，不会污染后续调用的沙箱策略。
   *
   * 审批未触发或被拒绝时必须保持 `false`。
   */
  sandboxWaived?: boolean;
}

const PARENT_DIR_PREFIX = `..${"/"}`;

/**
 * 把用户输入路径规范化到允许的根目录集合之一。
 *
 * 沙箱层级自上而下：
 *   1. `sandboxWaived === true` → 本次调用豁免，直接返回 `resolve(...)` 后的绝对路径；
 *   2. 否则检查候选路径是否落在任意 `allowedRoots` 之下；全部不满足时抛出
 *      `ValidationError(VALIDATION_PATH_ESCAPE)`。
 *
 * 该函数对"同时传入了相对路径与绝对路径"的语义：相对路径基于
 * `allowedRoots[0]` 展开（通常就是 workspaceRoot），因为模型给出相对路径时
 * 默认意图"相对工作区"；绝对路径则直接 resolve 后再做白名单判定。
 *
 * @throws ValidationError 当沙箱未豁免且候选路径不在任何允许的根下
 */
export const resolveAllowedPath = (
  targetPath: string,
  options: ResolveAllowedPathOptions,
): string => {
  const { allowedRoots, sandboxWaived } = options;
  if (allowedRoots.length === 0) {
    throw new ValidationError(
      "VALIDATION_PATH_ESCAPE",
      "未配置任何允许的根目录：请检查宿主是否正确注入 allowedRoots。",
      { context: { targetPath } },
    );
  }
  const primaryRoot = allowedRoots[0]!;
  const candidate = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(primaryRoot, targetPath);

  if (sandboxWaived === true) {
    return candidate;
  }

  for (const root of allowedRoots) {
    if (isInsideRoot(root, candidate)) {
      return candidate;
    }
  }

  throw new ValidationError(
    "VALIDATION_PATH_ESCAPE",
    [
      `路径越界：${targetPath} 不在任何允许的根目录内。`,
      `允许的根：${allowedRoots.join(", ")}。`,
      "可按以下任一方式放开该路径：",
      "  1) 把目标改为相对路径（如 ./cat.txt）或上述根下的绝对路径；",
      "  2) 在 tachu.config.ts 的 safety.allowedWriteRoots 追加该位置（静态白名单）；",
      "  3) 如果该工具本身需要用户确认（requiresApproval），审批通过会一次性放行本次调用。",
    ].join("\n"),
    {
      context: { allowedRoots: [...allowedRoots], targetPath, candidate },
    },
  );
};

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  if (rel.length === 0) return true; // candidate === root
  if (rel.startsWith("..")) return false;
  if (rel.includes(PARENT_DIR_PREFIX)) return false;
  return true;
};

/**
 * 旧签名兼容层：仅允许 `workspaceRoot` 一个根，不走审批豁免。
 *
 * @deprecated 新代码请改用 {@link resolveAllowedPath}，通过 `ToolExecutionContext.allowedRoots`
 * 和 `ToolExecutionContext.sandboxWaived` 传递完整的白名单/审批状态。
 */
export const resolveWorkspacePath = (workspaceRoot: string, targetPath: string): string => {
  return resolveAllowedPath(targetPath, { allowedRoots: [workspaceRoot] });
};

/**
 * 将绝对路径转换为相对工作区路径。
 *
 * @param workspaceRoot 工作区根目录
 * @param absPath 绝对路径
 * @returns 相对路径（POSIX 风格）
 */
export const toWorkspaceRelativePath = (workspaceRoot: string, absPath: string): string => {
  const rel = relative(workspaceRoot, absPath).replaceAll("\\", "/");
  return rel.length === 0 ? "." : rel;
};
