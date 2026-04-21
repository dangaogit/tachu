/**
 * 将毫秒格式化为简短耗时文案（用于底部详情条等）。
 *
 * - &lt; 1000ms：整数 ms
 * - ≥ 1000ms 且 &lt; 60s：秒，2 位小数（与 60s 边界衔接处用 clamp，避免出现 60.00s）
 * - ≥ 60s 且 &lt; 60min：`{分}m{秒}s`
 * - ≥ 60min：`{时}h{分}m`
 */
export function formatWallDisplay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0ms";
  }
  if (ms < 1000) {
    return `${Math.floor(ms)}ms`;
  }
  if (ms < 60_000) {
    const s = Math.min(ms / 1000, 59.99);
    return `${s.toFixed(2)}s`;
  }
  const hourBoundaryMs = 60 * 60_000;
  if (ms < hourBoundaryMs) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m${seconds}s`;
  }
  const hours = Math.floor(ms / 3600_000);
  const minutes = Math.floor((ms % 3600_000) / 60_000);
  return `${hours}h${minutes}m`;
}
