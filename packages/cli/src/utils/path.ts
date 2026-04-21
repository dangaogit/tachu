import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 从指定目录向上查找 git 根目录（含 `.git` 文件夹的目录）。
 *
 * @param startDir 起始目录，默认为 `process.cwd()`
 * @returns git 根目录路径，找不到时返回 `startDir`
 */
export function findGitRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

/**
 * 从指定目录向上查找 `tachu.config.ts`（或 `.js` / `.mjs`）。
 *
 * @param startDir 起始目录，默认为 `process.cwd()`
 * @returns 配置文件绝对路径，找不到时返回 `null`
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  const candidates = ["tachu.config.ts", "tachu.config.js", "tachu.config.mjs"];
  let current = resolve(startDir);
  const gitRoot = findGitRoot(startDir);
  while (true) {
    for (const candidate of candidates) {
      const p = join(current, candidate);
      if (existsSync(p)) {
        return p;
      }
    }
    if (current === gitRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * 规范化路径（解析 `~` 和相对路径）。
 *
 * @param p 待规范化路径
 * @returns 绝对路径
 */
export function normalizePath(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
    return resolve(join(home, p.slice(1)));
  }
  return resolve(p);
}
