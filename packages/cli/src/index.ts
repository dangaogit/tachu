import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { chatCommand } from "./commands/chat";
import { initCommand } from "./commands/init";
import { runCommand } from "./commands/run";
import { sessionCommand } from "./commands/session";

const resolveVersion = (): string => {
  // 运行期从上级目录的 package.json 读版本号，确保 CLI 输出始终与发布版本一致。
  // 兼容从 src/ 运行（开发）与从 dist/ 运行（发布制品）两种场景。
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "..", "package.json"),
    resolve(moduleDir, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@tachu/cli" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
};

/**
 * Tachu CLI 主入口。
 *
 * 提供三个子命令：
 * - `tachu init` — 初始化项目配置
 * - `tachu run <prompt>` — 单次执行 prompt
 * - `tachu chat` — 进入交互式对话
 *
 * @example
 * ```bash
 * tachu init --template minimal --provider mock
 * tachu run "你好"
 * tachu chat
 * ```
 */
const main = defineCommand({
  meta: {
    name: "tachu",
    version: resolveVersion(),
    description: "Tachu（太初）- Agentic Engine CLI（alpha）",
  },
  subCommands: {
    init: initCommand,
    run: runCommand,
    chat: chatCommand,
    session: sessionCommand,
  },
});

runMain(main);
