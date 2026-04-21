/// <reference lib="dom" />
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import type { ReadableArticle } from './types';

/**
 * 使用 Mozilla Readability 从 HTML 字符串抽取可读正文。
 *
 * @param html 原始 HTML
 * @param baseUrl 文档 URL，用于解析相对路径及 `&lt;base href&gt;`
 * @returns 抽取成功返回 {@link ReadableArticle}；无正文或 DOM 解析失败时返回 `null`（不抛错）
 */
export function extractReadable(html: string, baseUrl: string): ReadableArticle | null {
  let document: Document;
  try {
    const win = parseHTML(html);
    document = win.document as unknown as Document;
  } catch {
    return null;
  }

  const effectiveBase = resolveDocumentBaseUrl(document, baseUrl);
  try {
    Object.defineProperty(document, 'URL', { value: effectiveBase, configurable: true });
    Object.defineProperty(document, 'documentURI', { value: effectiveBase, configurable: true });
    Object.defineProperty(document, 'baseURI', { value: effectiveBase, configurable: true });
  } catch {
    // linkedom 可能对部分属性只读；Readability 仍可在无 base 场景工作
  }

  let parsed: ReturnType<Readability['parse']>;
  try {
    const reader = new Readability(document, { charThreshold: 250 });
    parsed = reader.parse();
  } catch {
    return null;
  }

  if (!parsed) {
    return null;
  }

  const contentHtml = parsed.content;
  if (typeof contentHtml !== 'string' || contentHtml.trim().length === 0) {
    return null;
  }

  const textContent = typeof parsed.textContent === 'string' ? parsed.textContent : '';
  if (textContent.trim().length === 0) {
    return null;
  }

  return buildReadableArticle(parsed, contentHtml, textContent);
}

function resolveDocumentBaseUrl(document: Document, baseUrl: string): string {
  const href = document.querySelector('base')?.getAttribute('href')?.trim();
  if (!href) {
    return baseUrl;
  }
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

function buildReadableArticle(
  parsed: NonNullable<ReturnType<Readability['parse']>>,
  contentHtml: string,
  textContent: string,
): ReadableArticle {
  const title = parsed.title?.trim() ?? '';
  const out: ReadableArticle = {
    title,
    contentHtml,
    textContent,
  };

  const byline = parsed.byline?.trim();
  if (byline) {
    out.byline = byline;
  }

  const excerpt = parsed.excerpt?.trim();
  if (excerpt) {
    out.excerpt = excerpt;
  }

  const lang = parsed.lang?.trim();
  if (lang) {
    out.lang = lang;
  }

  return out;
}
