import { patchMarkdown } from "./patch-markdown";

/**
 * 累积 LLM 流式字符并生成用于渲染的「补全后」Markdown 源。
 */
export class StreamingMarkdownState {
  private raw = "";

  append(chunk: string): void {
    this.raw += chunk;
  }

  getRaw(): string {
    return this.raw;
  }

  /**
   * 供 `marked` / ANSI 渲染使用的展示源（含 patch）。
   */
  getDisplaySource(): string {
    return patchMarkdown(this.raw);
  }

  clear(): void {
    this.raw = "";
  }
}
