/**
 * 解析 `/image <path> [optional prompt...]`。
 *
 * - 支持无空格路径：`/image ./a.png 描述`
 * - 支持引号路径：`/image "./a b.png" 描述`
 */
export function tryParseImageSlashCommand(line: string): { rawPath: string; prompt: string } | null {
  const t = line.trim();
  // 区分 `/image` 与 `/images` 等：命令名后须为空白或行尾
  if (!/^\/image(?:\s|$)/i.test(t)) {
    return null;
  }
  let rest = t.slice("/image".length).trim();
  if (!rest) {
    return null;
  }

  let rawPath: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) {
      return null;
    }
    rawPath = rest.slice(1, end);
    rest = rest.slice(end + 1).trim();
  } else if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1) {
      return null;
    }
    rawPath = rest.slice(1, end);
    rest = rest.slice(end + 1).trim();
  } else {
    const sp = rest.search(/\s+/);
    if (sp === -1) {
      rawPath = rest;
      rest = "";
    } else {
      rawPath = rest.slice(0, sp);
      rest = rest.slice(sp).trim();
    }
  }

  if (!rawPath) {
    return null;
  }
  return { rawPath, prompt: rest };
}

export const DEFAULT_IMAGE_CHAT_PROMPT = "请描述这张图片的主要内容。";
