import { join } from "node:path";
import { createDefaultEngineConfig, type EngineConfig } from "@tachu/core";
import { ConfigLoadError } from "../errors";
import { findConfigFile } from "../utils/path";

/**
 * 从指定工作目录加载 tachu.config.ts（或 .js / .mjs）。
 *
 * 加载顺序：
 * 1. CWD/tachu.config.ts
 * 2. 向上查找至 git root
 * 3. 找不到时使用默认配置并打印提示
 *
 * @param cwd 工作目录，默认为 `process.cwd()`
 * @returns 合并后的 EngineConfig
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<EngineConfig> {
  const defaultConfig = createDefaultEngineConfig();

  // 1. 尝试当前目录
  let configPath = findConfigFile(cwd);

  if (!configPath) {
    // 尝试 .tachu 子目录
    const altPath = join(cwd, ".tachu", "tachu.config.ts");
    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(altPath));
      if (stat.isFile()) {
        configPath = altPath;
      }
    } catch {
      // 不存在
    }
  }

  if (!configPath) {
    console.warn(
      `[tachu] 未找到 tachu.config.ts，使用默认配置。提示：运行 \`tachu init\` 初始化项目。`,
    );
    return defaultConfig;
  }

  try {
    const mod = await import(configPath);
    const userConfig: Partial<EngineConfig> = mod.default ?? mod;
    return mergeConfig(defaultConfig, userConfig);
  } catch (err) {
    throw new ConfigLoadError(`加载配置文件失败：${configPath}`, err);
  }
}

/**
 * 深度合并两份 EngineConfig，用户配置优先。
 *
 * @param base 基础配置
 * @param override 覆盖配置
 * @returns 合并结果
 */
export function mergeConfig(base: EngineConfig, override: Partial<EngineConfig>): EngineConfig {
  const merged = { ...base } as unknown as Record<string, unknown>;
  const baseRec = base as unknown as Record<string, unknown>;
  for (const key of Object.keys(override) as (keyof EngineConfig)[]) {
    const ov = override[key];
    const ba = baseRec[key];
    if (
      ov !== null &&
      ov !== undefined &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      ba !== null &&
      ba !== undefined &&
      typeof ba === "object" &&
      !Array.isArray(ba)
    ) {
      merged[key] = {
        ...(ba as Record<string, unknown>),
        ...(ov as Record<string, unknown>),
      };
    } else if (ov !== undefined) {
      merged[key] = ov;
    }
  }
  return merged as unknown as EngineConfig;
}
