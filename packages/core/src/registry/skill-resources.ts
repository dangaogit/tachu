import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillResource } from "../types";

/**
 * agentskills.io 目录约定：技能资源按所在子目录表达类型，不用 frontmatter 字段。
 */
const RESOURCE_SUBDIRS = ["scripts", "references", "assets"] as const;

/**
 * 扫描技能目录下的 `scripts/` `references/` `assets/` 子目录，生成 `resources`
 * 列表。只扫一层（不递归子目录内部的更深层级），`path` 带子目录前缀并统一用
 * POSIX 分隔符 `/`，跨平台可比较、可作为 `read_skill_resource` 白名单键。
 *
 * 子目录不存在时静默跳过（技能可以没有任何资源）；返回结果按 path 排序，
 * 保证同一目录多次扫描结果确定。
 */
export const discoverSkillResources = async (skillDir: string): Promise<SkillResource[]> => {
  const resources: SkillResource[] = [];
  for (const sub of RESOURCE_SUBDIRS) {
    const subDir = join(skillDir, sub);
    let entries: Dirent[];
    try {
      entries = await readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        resources.push({ path: `${sub}/${entry.name}` });
      }
    }
  }
  resources.sort((a, b) => a.path.localeCompare(b.path));
  return resources;
};
