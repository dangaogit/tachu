/**
 * 从 HTML 中提取 JSON-LD、Open Graph、Twitter Card 与 meta description。
 * JSON-LD 仅使用 {@link JSON.parse}；解析失败的片段静默跳过。
 */

const LD_JSON_SCRIPT =
  /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)\s*[^>]*>([\s\S]*?)<\/script>/gi;

const META_TAG = /<meta\b([^>]+)>/gi;

/** 与 {@link extractStructured} 返回值一致的结构化载荷类型。 */
export interface StructuredData {
  /** 每个 `application/ld+json` 脚本解析结果各占一项；无则为 `[]`。 */
  jsonLd: unknown[];
  /** `property="og:*"` 的键为去掉 `og:` 前缀后的片段（如 `og:title` → `title`）。 */
  openGraph: Record<string, string>;
  /** `name="twitter:*"` 的键为去掉 `twitter:` 前缀后的片段。 */
  twitter: Record<string, string>;
  /** 来自 `<meta name="description">` 的纯文本。 */
  description?: string;
}

/**
 * 从 HTML 字符串中提取结构化元数据。
 *
 * @param html - 完整 HTML 文档或片段
 * @returns JSON-LD 数组、OG/Twitter 键值表与可选的 meta description
 */
export function extractStructured(html: string): StructuredData {
  const jsonLd: unknown[] = [];
  for (const raw of matchAllScripts(html)) {
    const text = raw.trim();
    if (text.length === 0) {
      continue;
    }
    try {
      jsonLd.push(JSON.parse(text) as unknown);
    } catch {
      /* 损坏的 JSON-LD 跳过 */
    }
  }

  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let description: string | undefined;

  for (const attrBlock of matchAllMetaAttrBlocks(html)) {
    const property = getAttrValue(attrBlock, "property");
    const name = getAttrValue(attrBlock, "name");
    const content = getAttrValue(attrBlock, "content");
    if (content === undefined) {
      continue;
    }

    if (property !== undefined && property.toLowerCase().startsWith("og:")) {
      const key = property.slice(3);
      if (key.length > 0) {
        openGraph[key] = content;
      }
    } else if (name !== undefined && name.toLowerCase().startsWith("twitter:")) {
      const key = name.slice(8);
      if (key.length > 0) {
        twitter[key] = content;
      }
    } else if (name !== undefined && name.toLowerCase() === "description") {
      description = content;
    }
  }

  const base: StructuredData = {
    jsonLd,
    openGraph,
    twitter,
  };
  if (description !== undefined) {
    return { ...base, description };
  }
  return base;
}

function* matchAllScripts(html: string): Generator<string, void, unknown> {
  LD_JSON_SCRIPT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LD_JSON_SCRIPT.exec(html)) !== null) {
    const inner = m[1];
    if (inner !== undefined) {
      yield inner;
    }
  }
}

function* matchAllMetaAttrBlocks(html: string): Generator<string, void, unknown> {
  META_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_TAG.exec(html)) !== null) {
    const block = m[1];
    if (block !== undefined) {
      yield block;
    }
  }
}

function getAttrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = re.exec(attrs);
  if (match === null) {
    return undefined;
  }
  if (match[1] !== undefined) {
    return match[1];
  }
  if (match[2] !== undefined) {
    return match[2];
  }
  if (match[3] !== undefined) {
    return match[3];
  }
  return undefined;
}
