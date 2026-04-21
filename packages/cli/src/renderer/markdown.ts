import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { shouldDisableColor } from "./color";

/**
 * 是否已将 marked-terminal 扩展挂载到全局 `marked`。单例避免重复 `use()`。
 *
 * marked-terminal v7 通过 `marked.use(markedTerminal())` 的形式挂载 new-renderer
 * 扩展。
 */
let initialized = false;

/**
 * 懒加载挂载 marked-terminal 扩展到全局 marked。
 *
 * - **Parser**: `marked`
 * - **Renderer**: `marked-terminal`（chalk + cli-highlight 代码块高亮）
 *
 * 此函数是幂等的，多次调用仅会挂载一次。
 */
function ensureInit(): void {
  if (initialized) return;
  marked.use(markedTerminal());
  initialized = true;
}

export type RenderMarkdownToAnsiOptions = {
  /**
   * 即使禁色也走 marked 解析（表格/标题等排版）。用于 Ink 等仍需终端表格渲染的场景；
   * 默认 false 以保持管道/重定向下字节级原文可预期。
   */
  force?: boolean;
};

/**
 * 把 Markdown 源文渲染成 ANSI 着色的终端字符串。
 *
 * 规则：
 * - **禁色环境**（`NO_COLOR` / non-TTY / 显式 `--no-color`）默认直接返回原文，**不经过 marked 解析**，
 *   以保证纯管道 / 文件重定向场景的输出幂等、字节级可控。
 * - 传 `{ force: true }` 时在禁色下仍解析 Markdown（如 Ink UI 需 GFM 表格等）。
 * - 末尾多余空白行会被归一化为单个 `\n`，由 caller 决定是否再拼接换行。
 *
 * @param src 原始 Markdown 字符串
 * @returns ANSI 着色后的字符串（或禁色环境下的原文）
 *
 * @example
 * ```ts
 * const ansi = renderMarkdownToAnsi("# Hello\n\n**bold** text");
 * process.stdout.write(ansi);
 * ```
 */
export function renderMarkdownToAnsi(
  src: string,
  options?: RenderMarkdownToAnsiOptions,
): string {
  if (src.length === 0) return src;
  if (shouldDisableColor() && !options?.force) {
    return src;
  }

  ensureInit();
  const out = marked.parse(src, { async: false });
  if (typeof out !== "string") {
    // marked 的同步 parse 在 `async: false` 下恒返回 string；做 defensive 兜底。
    return src;
  }
  return out.replace(/\n+$/, "\n");
}
