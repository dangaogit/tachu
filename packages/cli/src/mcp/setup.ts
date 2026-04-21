import type { DescriptorRegistry, EngineConfig } from "@tachu/core";
import { colorize } from "../renderer/color";
import {
  matchesKeywords,
  mountMcpServers,
  type GatedMcpGroup,
  type MountedMcpServers,
  type MountMcpServersOptions,
} from "./mount";

/**
 * CLI `setupMcpServersFromConfig` 的返回值。
 *
 * 相比底层 `MountedMcpServers`，额外暴露一个 `activateForPrompt` 钩子——
 * 每轮对话之前传入当轮用户输入（或其规范化形态），按各 gated server 的
 * `keywords` 命中情况动态注册/注销工具。
 */
export interface SetupMcpServersResult extends MountedMcpServers {
  /**
   * 按用户当轮输入评估所有 gated groups，命中即注册，未命中即注销。
   *
   * 常驻（非 gated）工具已在装配阶段一次性注册，不受此方法影响。
   *
   * @param input 当轮用户输入（string 或任意可序列化对象；非字符串按
   *   `JSON.stringify` 后做子串匹配）
   * @param hooks 可选的激活/注销观察点，便于 `--debug` 输出
   * @returns 本次激活 / 注销的 namespaced 工具名列表
   */
  activateForPrompt(
    input: unknown,
    hooks?: ActivationHooks,
  ): Promise<ActivationSummary>;
}

/**
 * `activateForPrompt` 可观察钩子。
 */
export interface ActivationHooks {
  /** 单个 group 评估完成时回调（成功 / 跳过都会触发） */
  onGroupEvaluated?: (evt: {
    serverId: string;
    matched: boolean;
    activatedCount: number;
    deactivatedCount: number;
    keywords: readonly string[];
  }) => void;
}

/**
 * `activateForPrompt` 单次执行摘要。
 */
export interface ActivationSummary {
  /** 本次新激活的 namespaced tool 名列表 */
  activated: string[];
  /** 本次被注销的 namespaced tool 名列表 */
  deactivated: string[];
  /** 全部 gated group 的评估结果（含未变动的） */
  groups: Array<{
    serverId: string;
    matched: boolean;
    toolCount: number;
    keywords: readonly string[];
  }>;
}

/**
 * CLI 命令（`tachu run` / `tachu chat`）共用的 MCP 装配入口。
 *
 * 职责：
 * 1. 调 `mountMcpServers` 建立 adapters、拉取远端工具
 * 2. 把常驻 descriptors 注册到传入的 DescriptorRegistry；失败仅打警告，
 *    继续注册其余工具（与主流程解耦，保持"一个 MCP server/tool 挂了不能
 *    拖垮整个 CLI 进程"的生产预期）
 * 3. 按 server 结果向 stderr 打出一行摘要，便于用户确认连接状态
 * 4. 暴露 `activateForPrompt`：每轮对话前按 `keywords` 动态激活/注销
 *    `expandOnKeywordMatch` 下的 gated 工具，避免常规对话被大批量工具
 *    schema 拖慢
 *
 * @param config 引擎配置（只读 `mcpServers` 字段）
 * @param registry 已扫描的 DescriptorRegistry
 * @param options `mountMcpServers` 的装配选项
 * @returns `SetupMcpServersResult`，调用方需在进程退出路径调用 `disconnectAll`
 */
export async function setupMcpServersFromConfig(
  config: { mcpServers?: EngineConfig["mcpServers"] },
  registry: DescriptorRegistry,
  options: MountMcpServersOptions,
): Promise<SetupMcpServersResult> {
  const mounted = await mountMcpServers(config.mcpServers, options);

  for (const descriptor of mounted.descriptors) {
    try {
      // 用户定义的同名工具已经先由 `scanDescriptors` 注册；此处再次注册会
      // 让 Registry 抛 `RegistryError.duplicate`。MCP 工具的唯一名已经带上
      // `<serverId>__` 前缀，理论上不会冲突；一旦冲突说明用户在
      // `.tachu/tools` 里人工占用了相同名字，应保留用户版本、仅警告。
      await registry.register(descriptor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        colorize(
          `[tachu][mcp] 工具 ${descriptor.name} 注册失败：${message}\n`,
          "yellow",
        ),
      );
    }
  }

  for (const summary of mounted.servers) {
    switch (summary.status) {
      case "ok": {
        const gateTag = summary.gated
          ? `；惰性装配（keywords: ${summary.keywords.join(",")}）`
          : "";
        process.stderr.write(
          colorize(
            `[tachu][mcp] ${summary.serverId} (${summary.transport}) 已连接；工具 ${summary.toolsRegistered}/${summary.toolsListed}，${summary.durationMs}ms${gateTag}\n`,
            "gray",
          ),
        );
        break;
      }
      case "disabled":
        process.stderr.write(
          colorize(
            `[tachu][mcp] ${summary.serverId} 已禁用（config.disabled=true）\n`,
            "gray",
          ),
        );
        break;
      case "failed":
        process.stderr.write(
          colorize(
            `[tachu][mcp] ${summary.serverId} 连接失败：${summary.error}\n`,
            "yellow",
          ),
        );
        break;
    }
  }

  // gated group 的 activation state：记录当前每组工具是否已注册到 registry，
  // 这样 activateForPrompt 可以幂等执行多次（同一输入不重复注册/注销）。
  const activeGroups = new Set<string>();

  const activateForPrompt = async (
    input: unknown,
    hooks?: ActivationHooks,
  ): Promise<ActivationSummary> => {
    const activated: string[] = [];
    const deactivated: string[] = [];
    const groupResults: ActivationSummary["groups"] = [];

    for (const group of mounted.gatedGroups) {
      const matched = matchesKeywords(input, group.keywords);
      const currentlyActive = activeGroups.has(group.serverId);
      let activatedCount = 0;
      let deactivatedCount = 0;

      if (matched && !currentlyActive) {
        for (const descriptor of group.descriptors) {
          try {
            await registry.register(descriptor);
            activated.push(descriptor.name);
            activatedCount += 1;
          } catch (err) {
            // 注册失败（典型：同名 descriptor 被用户占用）——不阻塞其他工具，
            // 但要让用户在 stderr 看到原因。
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              colorize(
                `[tachu][mcp] 激活工具 ${descriptor.name} 失败：${message}\n`,
                "yellow",
              ),
            );
          }
        }
        activeGroups.add(group.serverId);
      } else if (!matched && currentlyActive) {
        for (const descriptor of group.descriptors) {
          try {
            await registry.unregister("tool", descriptor.name);
            deactivated.push(descriptor.name);
            deactivatedCount += 1;
          } catch {
            // 注销失败通常因为该工具已被外部移除；静默忽略。
          }
        }
        activeGroups.delete(group.serverId);
      }

      groupResults.push({
        serverId: group.serverId,
        matched,
        toolCount: group.descriptors.length,
        keywords: group.keywords,
      });

      hooks?.onGroupEvaluated?.({
        serverId: group.serverId,
        matched,
        activatedCount,
        deactivatedCount,
        keywords: group.keywords,
      });
    }

    return { activated, deactivated, groups: groupResults };
  };

  return {
    ...mounted,
    activateForPrompt,
  };
}

// 一次性"列出所有 gated 工具"的便利函数，供 `--debug` 诊断使用。
export const listAllGatedTools = (
  groups: ReadonlyArray<GatedMcpGroup>,
): string[] => {
  const names: string[] = [];
  for (const g of groups) {
    for (const d of g.descriptors) names.push(d.name);
  }
  return names;
};
