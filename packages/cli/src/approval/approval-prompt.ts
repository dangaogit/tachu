import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@tachu/core";
import { colorize } from "../renderer/color";
import { isStderrTTY, isStdinTTY } from "../utils/tty";
import { getInteractivePrompter, type InteractivePrompter } from "./shared-prompter";
import { ApprovalStore } from "./approval-store";
import type { ApprovalRecord } from "./approval-store";

/**
 * CLI 审批交互构建选项。
 */
export interface BuildApprovalPromptOptions {
 /**
 * 非交互模式下的默认决策：
 * - `"deny"`（默认）：stdin/stderr 任一非 TTY 或 `NO_TTY` 环境变量存在时一律拒绝
 * - `"approve"`：无人值守脚本里明确声明"允许一切"时使用；慎用
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
 /**
 * 持久化授权 store，用于查询和写入 approved 记录。
 * 未指定时惰性创建 `new ApprovalStore(process.cwd())`。
 */
  store?: ApprovalStore;
 /**
 * 当前 session ID，用于 session 级授权匹配。
 */
  currentSessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 构建一个工具审批回调，交互模式下会在 stderr 渲染提示并从 stdin 读取选项。
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
  const store = options.store ?? new ApprovalStore(process.cwd());
  const currentSessionId = options.currentSessionId;

  return async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
    if (autoApproveEnv) {
      return { type: "approve" };
    }

 // 先查持久化授权 store
    const storedRecord = await store.find(
      request.tool,
      request.arguments as Record<string, unknown>,
      currentSessionId,
    );
    if (storedRecord !== null) {
      return { type: "approve" };
    }

 // 共享 prompter（由交互式主循环注册，复用其 readline）路径：
    const sharedPrompter = options.ask ?? getInteractivePrompter();
    if (sharedPrompter) {
      return askViaSharedPrompter({ request, output, sharedPrompter, store, currentSessionId });
    }

    const interactive = stdinTty && stderrTty && !noTtyEnv;
    if (!interactive) {
      return defaultNonInteractive;
    }
    return askYesNo({ request, input, output, timeoutMs, store, currentSessionId });
  };
}

interface AskYesNoArgs {
  request: ToolApprovalRequest;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  timeoutMs: number;
  store: ApprovalStore;
  currentSessionId: string | undefined;
}

interface AskViaSharedArgs {
  request: ToolApprovalRequest;
  output: NodeJS.WritableStream;
  sharedPrompter: InteractivePrompter;
  store: ApprovalStore;
  currentSessionId: string | undefined;
}

/**
 * 通过外部注入的 prompter（如主循环的 `rl.question`）读取审批决策。
 */
async function askViaSharedPrompter(args: AskViaSharedArgs): Promise<ToolApprovalDecision> {
  const { request, output, sharedPrompter, store, currentSessionId } = args;
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
  return parseAndPersist(answer, request, store, currentSessionId);
}

/**
 * 输出一条 approval 提示（stderr），从 stdin 读取单行。
 *
 * ⚠️ 只在没有共享 prompter 的一次性执行场景（`tachu run`）下使用。
 */
async function askYesNo(args: AskYesNoArgs): Promise<ToolApprovalDecision> {
  const { request, input, output, timeoutMs, store, currentSessionId } = args;
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
      resolve(decision);
    };
    const onLine = (line: string): void => {
      void parseAndPersist(line, request, store, currentSessionId).then(finish);
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
  const question =
    `是否执行?\n` +
    `  [y] 仅本次\n` +
    `  [a] 始终允许此工具（项目级）\n` +
    `  [p] 允许此路径模式（项目级，仅适用于有 path 参数的工具）\n` +
    `  [s] 仅本 session 内允许\n` +
    `  [N] 拒绝\n` +
    `请输入 y/a/p/s/N: `;
  return { info, question };
}

async function parseAndPersist(
  line: string,
  request: ToolApprovalRequest,
  store: ApprovalStore,
  currentSessionId: string | undefined,
): Promise<ToolApprovalDecision> {
  const answer = line.trim().toLowerCase();

  if (answer === "y" || answer === "yes") {
    return { type: "approve" };
  }

  if (answer === "a") {
    const record: ApprovalRecord = {
      id: randomUUID(),
      scope: "project",
      tool: request.tool,
      match: { kind: "any" },
      createdAt: Date.now(),
    };
    await store.append(record);
    return { type: "approve" };
  }

  if (answer === "p") {
    const args = request.arguments as Record<string, unknown>;
    const pathValue = typeof args.path === "string" ? args.path : undefined;
    let match: ApprovalRecord["match"];
    if (pathValue !== undefined) {
      const dir = dirname(pathValue);
      match = { kind: "argPattern", field: "path", pattern: `${dir}/**` };
    } else {
      match = { kind: "any" };
    }
    const record: ApprovalRecord = {
      id: randomUUID(),
      scope: "project",
      tool: request.tool,
      match,
      createdAt: Date.now(),
    };
    await store.append(record);
    return { type: "approve" };
  }

  if (answer === "s") {
    const record: ApprovalRecord = {
      id: randomUUID(),
      scope: "project",
      tool: request.tool,
      match: { kind: "any" },
      createdAt: Date.now(),
      ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
    };
    await store.append(record);
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
