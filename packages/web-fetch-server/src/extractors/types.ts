/**
 * Readability 解析后的中间结果，供后续 Turndown 或 HTTP 响应组装使用。
 * 字段语义与 `docs/adr/decisions/0003b-web-fetch-types.md` 中 `ReadabilityArticle` 对齐（server 侧精简视图）。
 */
export interface ReadableArticle {
  title: string;
  byline?: string;
  excerpt?: string;
  lang?: string;
  /** Readability 清洗后的 HTML 片段（`script` / `style` 等已被移除）。 */
  contentHtml: string;
  textContent: string;
}
