/**
 * 流式 Markdown **展示用**补全：闭合未完成的 fence 与常见行内标记，
 * 便于下游 `marked` / 终端高亮在传输中途保持稳定。非完整 CommonMark 语义。
 */

function balanceInlineMarkers(segment: string): string {
  let s = segment;
  const doubleStar = (s.match(/\*\*/g) ?? []).length;
  if (doubleStar % 2 === 1) {
    s += "**";
  }
  const doubleUnder = (s.match(/__/g) ?? []).length;
  if (doubleUnder % 2 === 1) {
    s += "__";
  }
  const withoutDoubleStar = s.replace(/\*\*/g, "");
  if ((withoutDoubleStar.match(/\*/g) ?? []).length % 2 === 1) {
    s += "*";
  }
  const withoutDoubleUnder = s.replace(/__/g, "");
  if ((withoutDoubleUnder.match(/_/g) ?? []).length % 2 === 1) {
    s += "_";
  }
  return s;
}

/**
 * 对不完整缓冲区补全 fence 与 fence 外行内标记。
 *
 * - 奇数个 ``` → 追加换行 + 闭合 fence
 * - 仅在 fence **外**平衡 `**` / `__` / 单 `*` / 单 `_`
 */
export function patchMarkdown(raw: string): string {
  if (raw.length === 0) {
    return raw;
  }
  const fenceCount = (raw.match(/```/g) ?? []).length;
  let out = raw;
  if (fenceCount % 2 === 1) {
    out += "\n```\n";
  }
  const parts = out.split("```");
  const rebuilt: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i] ?? "";
    if (i % 2 === 0) {
      rebuilt.push(balanceInlineMarkers(segment));
    } else {
      rebuilt.push(segment);
    }
  }
  return rebuilt.join("```");
}
