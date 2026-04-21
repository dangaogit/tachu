import TurndownService from 'turndown';
import { tables, taskListItems } from 'turndown-plugin-gfm';

/**
 * 控制 HTML → Markdown 转换时链接与图片在正文中的呈现方式，
 * 与 `docs/adr/decisions/0003b-web-fetch-types.md` 中请求选项语义对齐（`links` / `images` 数组由路由层单独组装）。
 */
export interface HtmlToMarkdownOptions {
  includeLinks: boolean;
  includeImages: boolean;
}

/**
 * 将 Readability 等模块产出的 HTML 片段转为 GFM Markdown（含表格、任务列表）。
 *
 * 使用 Turndown + `turndown-plugin-gfm` 的 `tables` 与 `taskListItems`；
 * `includeLinks === false` 时保留锚点内文本并去掉超链接；`includeImages === false` 时移除 `img` 节点。
 *
 * @param html 输入 HTML 字符串
 * @param opts 链接与图片开关
 * @returns Markdown 正文
 */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });

  turndownService.use(tables);
  turndownService.use(taskListItems);

  if (!opts.includeImages) {
    turndownService.addRule('webFetchOmitImages', {
      filter: 'img',
      replacement: () => '',
    });
  }

  if (!opts.includeLinks) {
    turndownService.addRule('webFetchPlainAnchors', {
      filter: (node: HTMLElement) => node.nodeName === 'A',
      replacement: (content: string) => content,
    });
  }

  return turndownService.turndown(html);
}
