import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@tachu/core";
import { colorize } from "../renderer/color";
import { isStderrTTY, isStdinTTY } from "../utils/tty";
import { getInteractivePrompter, type InteractivePrompter } from "./shared-prompter";

/**
 * CLI 审批交互构建选项。
 */
export interface BuildApprovalPromptOptions {
  /**
   * 非交互模式下的默认决策：
   *   - `"deny"`（默认）：stdin/stderr 任一非 TTY 或 `NO_TTY` 环境变量存在时一律拒绝
   *   - `"approve"`：无人值守脚本里明确声明"允许一切"时使用；慎用
   */
  nonInteractiveDecision?: "approve" | "deny";
  /**
   * 是否允许通过环境变量 `TACHU_AUTO_APPROVE=1` 跳过所有提示。
   * 典型应用：CI 流水线中可靠的受控环境。默认 `false`。
   */
  respectAutoApproveEnv?: boolean;
  /**
   * 自定义 stdin / stderr 句柄，测试时注入。默认 `process.stdin` / `process.stderr`。
   */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * 自定义 TTY 判断，测试注入。默认读取 `process.stdin.isTTY` / `process.stderr.isTTY`。
   */
  tty?: { stdin: boolean; stderr: boolean };
  /**
   * 超时（毫秒）。无输入超时后按 `nonInteractiveDecision` 处理，默认 `60_000`。
   */
  timeoutMs?: number;
  /**
   * 直接注入一个"读一行"的 prompter，优先级最高。
   *
   * 典型用途：`tachu chat` 主循环把自己的 `readline.Interface.question` 传进来，
   * 避免审批路径在 `process.stdin` 上反复 createInterface/close（Node 的
   * `Interface.close()` 会 pause 输入流，导致主循环后续读不到输入）。
   *
   * 未指定时，会先尝试 {@link getInteractivePrompter} 注册的进程级 prompter；
   * 二者都为空时，才回退到内部创建临时 readline 的兜底逻辑（用于 `tachu run`
   * 等一次性执行场景）。
   */
  ask?: InteractivePrompter;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 构建一个工具审批回调，交互模式下会在 stderr 渲染提示并从 stdin 读取 `y/N`。
 *
 * 非交互模式（stdin/stderr 非 TTY 或 `NO_TTY=1`）下默认拒绝，避免静默批准破坏性操作。
 */
export function buildApprovalPrompt(
  options: BuildApprovalPromptOptions = {},
): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
  const stdinTty = options.tty?.stdin ?? isStdinTTY();
  const stderrTty = options.tty?.stderr ?? isStderrTTY();
  const noTtyEnv = process.env.NO_TTY === "1" || process.env.NO_TTY === "true";
  const autoApproveEnv =
    options.respectAutoApproveEnv === true &&
    (process.env.TACHU_AUTO_APPROVE === "1" || process.env.TACHU_AUTO_APPROVE === "true");
  const defaultNonInteractive: ToolApprovalDecision =
    options.nonInteractiveDecision === "approve"
      ? { type: "approve" }
      : { type: "deny", reason: "非交互环境下默认拒绝工具审批" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  return async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
    if (autoApproveEnv) {
      return { type: "approve" };
    }

    // 共享 prompter（由交互式主循环注册，复用其 readline）路径：
    // 即使 options 没显式传 ask，也尝试全局注册的 prompter，保证 chat 循环不受影响。
    const sharedPrompter = options.ask ?? getInteractivePrompter();
    if (sharedPrompter) {
      return askViaSharedPrompter({ request, output, sharedPrompter });
    }

    const interactive = stdinTty && stderrTty && !noTtyEnv;
    if (!interactive) {
      return defaultNonInteractive;
    }
    return askYesNo({ request, input, output, timeoutMs });
  };
}

interface AskYesNoArgs {
  request: ToolApprovalRequest;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  timeoutMs: number;
}

interface AskViaSharedArgs {
  request: ToolApprovalRequest;
  output: NodeJS.WritableStream;
  sharedPrompter: InteractivePrompter;
}

/**
 * 通过外部注入的 prompter（如主循环的 `rl.question`）读取审批决策。
 *
 * 相较于 {@link askYesNo} 的好处：不会触发 `rl.close()`，不会 pause `process.stdin`，
 * 因此不会拖垮交互式主循环。
 */
async function askViaSharedPrompter(args: AskViaSharedArgs): Promise<ToolApprovalDecision> {
  const { request, output, sharedPrompter } = args;
  // 先把"工具/副作用/触发原因/参数"等多行静态信息写到 stderr（避免 readline
  // 自动刷新 line 时覆盖这些非可编辑内容），最后把单行的 "是否执行? [y/N] "
  // 交给 prompter 作为 prompt —— 它负责渲染光标、回显用户输入。
  const { info, question } = formatApprovalPrompt(request);
  output.write(info);

  let answer: string;
  try {
    answer = await sharedPrompter(question);
  } catch (err) {
    return {
      type: "deny",
      reason: `审批读取失败：${(err as Error)?.message ?? String(err)}`,
    };
  }
  return parseAnswer(answer);
}

/**
 * 输出一条 approval 提示（stderr），从 stdin 读取单行；仅接受 `y`/`yes` 为批准，其它均视为拒绝。
 *
 * ⚠️ 只在没有共享 prompter 的一次性执行场景（`tachu run`）下使用。对于交互式主循环，
 * 使用 {@link askViaSharedPrompter}，否则 `rl.close()` 会 pause 主循环的 stdin。
 */
async function askYesNo(args: AskYesNoArgs): Promise<ToolApprovalDecision> {
  const { request, input, output, timeoutMs } = args;
  const { info, question } = formatApprovalPrompt(request);
  output.write(info + question);

  const rl: ReadlineInterface = createInterface({
    input: input as NodeJS.ReadableStream,
    output: process.stderr,
    terminal: false,
  });

  return new Promise<ToolApprovalDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ToolApprovalDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.off("line", onLine);
      rl.off("close", onClose);
      rl.close();
      // Node `Interface.close()` 会调用 `this.pause()` → `input.pause()`，
      // 对 `tachu run` 的一次性流程没有副作用；但如果用户换成了共享 prompter
      // 外层循环，请改走 askViaSharedPrompter 路径，而不是在这里 resume 试图补救。
      resolve(decision);
    };
    const onLine = (line: string): void => {
      finish(parseAnswer(line));
    };
    const onClose = (): void => {
      finish({ type: "deny", reason: "审批输入流已关闭" });
    };
    const timer = setTimeout(() => {
      finish({ type: "deny", reason: `审批超时（${timeoutMs}ms），默认拒绝` });
    }, timeoutMs);
    rl.on("line", onLine);
    rl.once("close", onClose);
  });
}

/**
 * 把 ToolApprovalRequest 渲染成 "静态信息 + 单行问询" 两段文本。
 */
function formatApprovalPrompt(request: ToolApprovalRequest): { info: string; question: string } {
  const header = colorize("需要工具审批", "yellow");
  const tool = colorize(request.tool, "cyan");
  const sideEffect = formatSideEffect(request.sideEffect);
  const trigger = formatTrigger(request.triggeredBy);
  const argsLine = request.argumentsPreview
    ? `  参数: ${request.argumentsPreview}\n`
    : "";
  const info =
    `\n${header}\n` +
    `  工具: ${tool}\n` +
    `  副作用: ${sideEffect}\n` +
    `  触发原因: ${trigger}\n` +
    argsLine;
  const question = `  是否执行? [y/N] `;
  return { info, question };
}

function parseAnswer(line: string): ToolApprovalDecision {
  const answer = line.trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    return { type: "approve" };
  }
  return { type: "deny", reason: "用户在审批提示中选择拒绝" };
}

function formatSideEffect(side: ToolApprovalRequest["sideEffect"]): string {
  switch (side) {
    case "readonly":
      return colorize("只读", "gray");
    case "write":
      return colorize("写入", "yellow");
    case "irreversible":
      return colorize("不可逆", "red");
    default:
      return side;
  }
}

function formatTrigger(trigger: ToolApprovalRequest["triggeredBy"]): string {
  switch (trigger) {
    case "descriptor":
      return "工具声明 requiresApproval";
    case "global":
      return "配置 runtime.toolLoop.requireApprovalGlobal";
    default:
      return trigger;
  }
}
