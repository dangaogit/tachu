/**
 * TTY 检测与终端宽度工具。
 */

/**
 * 判断当前 stdout 是否为 TTY。
 *
 * @returns `true` 表示 stdout 是 TTY 终端
 */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * 判断当前 stderr 是否为 TTY。
 *
 * @returns `true` 表示 stderr 是 TTY 终端
 */
export function isStderrTTY(): boolean {
  return Boolean(process.stderr.isTTY);
}

/**
 * 获取终端列数（宽度）。非 TTY 时返回 80。
 *
 * @returns 终端列数
 */
export function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * 判断当前 stdin 是否为 TTY（即是否有管道输入）。
 *
 * @returns `true` 表示 stdin 是 TTY（非管道）
 */
export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}
