import { isTTY } from "../utils/tty";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;
const CLEAR_LINE = "\r\x1b[K";

/**
 * 终端旋转加载指示器。
 *
 * - 非 TTY 时自动禁用（不输出任何字符）
 * - verbose 模式下也不展示（由调用方控制是否启动）
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private active = false;
  private currentText = "";

  /**
   * 启动 spinner。非 TTY 环境下为 no-op。
   *
   * @param text 初始提示文本
   */
  start(text = ""): void {
    if (!isTTY()) {
      return;
    }
    this.currentText = text;
    this.active = true;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  /**
   * 更新 spinner 提示文本。
   *
   * @param text 新提示文本
   */
  update(text: string): void {
    this.currentText = text;
    if (this.active) {
      this.render();
    }
  }

  /**
   * 停止 spinner 并清除行。
   */
  stop(): void {
    if (!this.active) {
      return;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.active = false;
    if (isTTY()) {
      process.stdout.write(CLEAR_LINE);
    }
  }

  /**
   * 停止 spinner 并在原位置输出成功消息。
   *
   * @param text 成功文本
   */
  succeed(text: string): void {
    this.stop();
    if (isTTY()) {
      process.stdout.write(`✓ ${text}\n`);
    }
  }

  /**
   * 停止 spinner 并在原位置输出失败消息。
   *
   * @param text 失败文本
   */
  fail(text: string): void {
    this.stop();
    process.stderr.write(`✗ ${text}\n`);
  }

  private render(): void {
    const frame = FRAMES[this.frame] ?? "⠋";
    process.stdout.write(`${CLEAR_LINE}${frame} ${this.currentText}`);
  }
}
