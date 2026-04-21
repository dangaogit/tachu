/**
 * 退出 Ink 或流式渲染后恢复终端默认图形属性，避免 ANSI 状态泄漏到 shell 历史。
 */
export function resetTerminalAnsi(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[0m");
  }
}
