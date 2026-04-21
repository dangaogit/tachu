import { assertPublicUrl, readResponseBodyWithLimit, withAbortTimeout } from "../../common/net";
import type { ToolExecutor } from "../shared";
import { assertNotAborted } from "../shared";

interface FetchUrlInput {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FetchUrlOutput {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  contentType?: string;
}

/**
 * 响应体字节数上限（保护网络与内存层）。超过会走 {@link readResponseBodyWithLimit} 的尾部截断。
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * 返回给 LLM 的字符数上限。经验值：32KB 字符 ≈ 8k~10k tokens，足以容纳一个文档页面的正文，
 * 又不至于把下一轮 Agentic Loop 的 context 吹爆。超过会在末尾追加可见的截断提示。
 */
const MAX_BODY_CHARS = 32 * 1024;

/**
 * 从 `Content-Type` 头提取主 MIME 类型（小写、去掉 `charset=` 等参数）。
 */
const parseContentType = (raw: string | null): string | undefined => {
  if (!raw) return undefined;
  const main = raw.split(";")[0]?.trim().toLowerCase();
  return main && main.length > 0 ? main : undefined;
};

/**
 * HTML → 纯文本的极简清洗（不引入第三方解析器）：
 *   1. 剥 `<!-- ... -->` 注释
 *   2. 剥 `<script>` / `<style>` / `<noscript>` / `<svg>` / `<canvas>` 块（含内容）
 *   3. 剥剩余标签
 *   4. 解码常见 HTML 实体
 *   5. 归一化空白（多空格 / 多空行合并）
 *
 * 目的不是 100% 还原原文结构，而是让 LLM 拿到一段信噪比尚可的正文。
 */
const stripHtmlForLlm = (html: string): string => {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * 按字符数截断，超出时在末尾追加可见的截断提示（让 LLM 知道自己只拿到部分内容）。
 */
const clipToChars = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= MAX_BODY_CHARS) return { text, truncated: false };
  const clipped = text.slice(0, MAX_BODY_CHARS);
  return {
    text: `${clipped}\n\n... [内容已截断，完整长度 ${text.length} 字符]`,
    truncated: true,
  };
};

const isHtmlLike = (contentType?: string): boolean => {
  if (!contentType) return false;
  return contentType === "text/html" || contentType === "application/xhtml+xml";
};

/**
 * URL 抓取 Tool 执行器。
 *
 * 返回给 LLM 的 body 经过两道处理：
 *   1. 若 `Content-Type: text/html` / `application/xhtml+xml` → HTML → 纯文本清洗
 *   2. 无论什么类型 → 按字符数截断到 {@link MAX_BODY_CHARS}，尾部追加截断提示
 *
 * `truncated` 为 true 时表示**字节层或字符层任一**发生了截断；`contentType` 归一化为小写主
 * MIME（例如 `text/html` / `application/json`），供上层调用方做进一步判断。
 */
export const fetchUrlExecutor: ToolExecutor<FetchUrlInput, FetchUrlOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);
  const parsed = await assertPublicUrl(input.url);
  const timeout = withAbortTimeout(
    context.abortSignal,
    input.timeoutMs ?? 15_000,
    "TIMEOUT_FETCH_URL",
  );
  try {
    const response = await fetch(parsed, {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
      signal: timeout.signal,
    });
    const bodyResult = await readResponseBodyWithLimit(response, MAX_BODY_BYTES);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const contentType = parseContentType(response.headers.get("content-type"));

    let body = bodyResult.body;
    let truncated = bodyResult.truncated;
    if (isHtmlLike(contentType)) {
      body = stripHtmlForLlm(body);
    }
    const clipped = clipToChars(body);
    body = clipped.text;
    if (clipped.truncated) truncated = true;

    return {
      status: response.status,
      headers,
      body,
      truncated,
      ...(contentType ? { contentType } : {}),
    };
  } finally {
    timeout.cleanup();
  }
};
