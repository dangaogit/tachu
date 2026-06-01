/**
 * CLI 展示用：token 以 k 为单位，最多保留小数点后 3 位，并去掉末尾多余 0。
 */
export function formatTokensK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0k";
  }
  const k = tokens / 1000;
  const trimmed = k.toFixed(3).replace(/\.?0+$/, "") || "0";
  return `${trimmed}k`;
}
