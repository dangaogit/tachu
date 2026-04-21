/**
 * 进程级的交互式 prompt 提供者。
 *
 * `tachu chat` 的主循环持有一个 readline 实例，并在启动时把"读取一行"的能力
 * 通过 {@link setInteractivePrompter} 注册进来。工具审批流程（{@link buildApprovalPrompt}）
 * 会优先复用这个共享 prompter，而不是在 `process.stdin` 上创建新的 readline。
 *
 * 这样做的原因：Node.js 的 `readline.Interface.close()` 会内部调用 `this.pause()`，
 * 从而把 `process.stdin` 暂停。如果审批流程每次创建/销毁 readline，会让主循环
 * 的外层 readline 在审批结束后读不到后续用户输入（表现为 `you>` 提示符卡死）。
 *
 * 非交互路径（如 `tachu run`、CI 模式）不会注册 prompter，此时审批会走
 * 原有的"创建内部 readline"兜底逻辑 —— 因为是一次性执行，不存在外层循环被
 * 暂停 stdin 拖垮的问题。
 */

/**
 * `prompter` 签名：把单行 prompt 文本写到终端，并解析为用户输入的一整行。
 */
export type InteractivePrompter = (query: string) => Promise<string>;

let currentPrompter: InteractivePrompter | null = null;

/**
 * 注册当前进程的交互式 prompter（通常是主循环的 `rl.question`）。
 * 传入 `null` 可清除。
 */
export function setInteractivePrompter(prompter: InteractivePrompter | null): void {
  currentPrompter = prompter;
}

/**
 * 获取已注册的交互式 prompter；未注册时返回 `null`。
 */
export function getInteractivePrompter(): InteractivePrompter | null {
  return currentPrompter;
}
