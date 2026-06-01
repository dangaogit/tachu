import { isTTY } from "../utils/tty";

/**
 * ANSI 颜色名称。
 */
export type Color = "gray" | "yellow" | "cyan" | "green" | "blue" | "red" | "reset" | "white" | "bold";

const ANSI_CODES: Record<Color, string> = {
  gray: "\x1b[90m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let _noColor: boolean | undefined;

/**
 * 判断是否应禁用颜色输出。
 *
 * 禁用条件（任一满足）：
 * - `--no-color` 参数（调用 `setNoColor(true)` 后生效）
 * - 环境变量 `NO_COLOR` 存在
 * - stdout 非 TTY
 *
 * @returns `true` 表示禁用颜色
 */
export function shouldDisableColor(): boolean {
  if (_noColor !== undefined) {
    return _noColor;
  }
  if ("NO_COLOR" in process.env && process.env.NO_COLOR !== undefined) {
    return true;
  }
  if (!isTTY()) {
    return true;
  }
  return false;
}

/**
 * 设置 `--no-color` 标志。
 *
 * @param value 是否禁用颜色
 */
export function setNoColor(value: boolean): void {
  _noColor = value;
}

/**
 * 重置颜色状态（主要用于测试）。
 */
export function resetColorState(): void {
  _noColor = undefined;
}

/**
 * 给文本添加 ANSI 颜色，在禁色环境下返回裸文本。
 *
 * @param text 待着色文本
 * @param color 颜色名
 * @returns 着色后的字符串
 *
 * @example
 * ```ts
 * process.stdout.write(colorize("hello", "green"));
 * ```
 */
export function colorize(text: string, color: Color): string {
  if (shouldDisableColor()) {
    return text;
  }
  return `${ANSI_CODES[color]}${text}${ANSI_CODES.reset}`;
}
