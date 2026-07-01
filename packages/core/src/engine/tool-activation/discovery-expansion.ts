import type { DiscoveryExpansionConfig } from "../../types/config";

/**
 * 计算工具名的「命名空间前缀」= 最后一个 `.` 或 `__` 分隔符之前的串。
 * 无分隔符（如 `run-shell`）返回空串，表示「无命名空间」，不参与前缀分组。
 */
const namespacePrefixOf = (name: string): string => {
  const lastDot = name.lastIndexOf(".");
  const lastUnderscore = name.lastIndexOf("__");
  const sep = Math.max(lastDot, lastUnderscore);
  return sep > 0 ? name.slice(0, sep) : "";
};

/**
 * 发现工具展开（domain 无关纯函数）。
 *
 * 给定一组被 pin 的工具名，按配置把「同域兄弟」并入，返回最终应下发给模型的工具名列表。
 * 详见 `DiscoveryExpansionConfig` 与 handoff 设计。activator 与 planning 共用本函数以保持 DRY。
 *
 * 不变量：
 * - `enabled !== true` 时原样返回 `names`（完全等价现状）。
 * - 结果 dedup、`∩ registeredNames`、`\ excludeTools`。
 * - pinned（`names` 入参顺序）恒排在兄弟之前；pinned 不会被 cap 截断，只截断兄弟。
 */
export function expandDiscoverySiblings(
  names: readonly string[],
  cfg: DiscoveryExpansionConfig,
  registeredNames: ReadonlySet<string>,
  excludeTools: ReadonlySet<string>,
): string[] {
  if (cfg.enabled !== true) {
    return [...names];
  }

  const seen = new Set<string>();
  const admit = (name: string, sink: string[]): void => {
    if (seen.has(name)) return;
    if (!registeredNames.has(name)) return;
    if (excludeTools.has(name)) return;
    seen.add(name);
    sink.push(name);
  };

  const pinned: string[] = [];
  for (const name of names) {
    admit(name, pinned);
  }

  const siblings: string[] = [];
  for (const name of names) {
    for (const sib of cfg.siblings?.[name] ?? []) {
      admit(sib, siblings);
    }
  }

  if (cfg.groupByNamespacePrefix === true) {
 // 收集所有 pinned 的非空命名空间前缀，把同前缀的已注册工具并入兄弟。
    const pinnedPrefixes = new Set<string>();
    for (const name of names) {
      const prefix = namespacePrefixOf(name);
      if (prefix.length > 0) pinnedPrefixes.add(prefix);
    }
    if (pinnedPrefixes.size > 0) {
      for (const candidate of registeredNames) {
        if (pinnedPrefixes.has(namespacePrefixOf(candidate))) {
          admit(candidate, siblings);
        }
      }
    }
  }

 // cap 只截断兄弟：pinned 全部保留，兄弟按顺序填满剩余预算。
  const maxTools = cfg.maxTools ?? 20;
  const siblingBudget = Math.max(0, maxTools - pinned.length);
  return [...pinned, ...siblings.slice(0, siblingBudget)];
}
