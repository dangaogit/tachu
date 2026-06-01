/**
 * 是否启用 Ink 主界面（`tachu run`，TTY 下默认开启，可用 `--no-ink` 或 `TACHU_INK=0` 关闭）。
 */
export function shouldUseInkCli(opts: {
  ink?: boolean | undefined;
  noColor: boolean;
  planMode: boolean;
}): boolean {
  if (opts.noColor) {
    return false;
  }
  if (opts.planMode) {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  if (opts.ink === false) {
    return false;
  }
  const env = process.env.TACHU_INK?.trim().toLowerCase();
  if (
    env === "0" ||
    env === "false" ||
    env === "no" ||
    env === "off"
  ) {
    return false;
  }
  return true;
}

/**
 * 交互式 `tachu chat`：TTY 下默认使用 Ink；显式 `--readline` 或禁色 / plan-mode / 非 TTY / `TACHU_INK=0` 时退回 readline。
 */
export function shouldUseInkForChat(opts: {
  readline?: boolean | undefined;
  noColor: boolean;
  planMode: boolean;
}): boolean {
  if (opts.readline === true) {
    return false;
  }
  if (opts.noColor) {
    return false;
  }
  if (opts.planMode) {
    return false;
  }
  if (!process.stdout.isTTY) {
    return false;
  }
  const env = process.env.TACHU_INK?.trim().toLowerCase();
  if (
    env === "0" ||
    env === "false" ||
    env === "no" ||
    env === "off"
  ) {
    return false;
  }
  return true;
}
