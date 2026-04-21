/**
 * 仅保留末尾若干行，用于大文本时避免 Ink 全量重绘卡死。
 */
export function takeTailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) {
    return "";
  }
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return lines.slice(-maxLines).join("\n");
}
