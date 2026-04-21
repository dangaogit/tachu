/**
 * 本地类型声明：marked-terminal v7（官方无 TS types，社区 @types 只到 v6）。
 *
 * 仅声明我们实际使用到的 `markedTerminal` 扩展工厂签名。
 * 详见 packages/cli/src/renderer/markdown.ts 的使用方式。
 */
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  /** marked-terminal 的样式与行为选项。键为各 block/inline 渲染钩子的 chalk 样式函数，值保留为 unknown 以避免锁定。 */
  export type MarkedTerminalOptions = Record<string, unknown>;

  /** cli-highlight 传入的附加选项（主题、语言映射等）。 */
  export type HighlightOptions = Record<string, unknown>;

  /**
   * 生成一个可挂载到 `marked.use()` 的 terminal 渲染扩展。
   *
   * @param options marked-terminal 样式/行为选项
   * @param highlightOptions cli-highlight 选项
   */
  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: HighlightOptions,
  ): MarkedExtension;

  const Renderer: unknown;
  export default Renderer;
}
