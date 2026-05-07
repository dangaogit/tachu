import type { ApprovalRecord } from "./approval-store";

/**
 * 纯函数，判断 record 是否匹配当前 tool+args，不含 I/O。
 *
 * 匹配逻辑：
 * 1. 过期检查：expiresAt < Date.now() 则跳过
 * 2. sessionId 检查：record.sessionId 存在且与 currentSessionId 不同则跳过
 * 3. tool 名匹配
 * 4. match.kind 匹配
 */
export function matchesRecord(
  record: ApprovalRecord,
  tool: string,
  args: Record<string, unknown>,
  currentSessionId?: string,
): boolean {
  if (record.expiresAt !== undefined && record.expiresAt < Date.now()) {
    return false;
  }

  if (record.sessionId !== undefined && record.sessionId !== currentSessionId) {
    return false;
  }

  if (record.tool !== tool) {
    return false;
  }

  const { match } = record;

  if (match.kind === "any") {
    return true;
  }

  if (match.kind === "shellCommand") {
    const command = typeof args.command === "string" ? args.command : "";
    const hasArgs = Array.isArray(args.args) && (args.args as unknown[]).length > 0;
    if (hasArgs) return false;
    try {
      return new RegExp(match.pattern).test(command);
    } catch {
      return false;
    }
  }

  if (match.kind === "argPattern") {
    const fieldValue = args[match.field];
    if (typeof fieldValue !== "string") return false;
    try {
      return new Bun.Glob(match.pattern).match(fieldValue);
    } catch {
      return false;
    }
  }

  return false;
}
