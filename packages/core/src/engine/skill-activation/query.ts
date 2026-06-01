import type { ContextWindow } from "../../modules/memory";
import { stripTrailingCurrentTurn } from "../../prompt/turn-tail";
import type { InputEnvelope } from "../../types";
import { inputContentToMessageContent } from "../resolve-provider-messages";

const RECALL_WINDOW_TURNS = 3;
const RECALL_QUERY_MAX_CHARS = 8_000;

export const stringifyActivationContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

/** 从最近用户轮次 + 当前输入构建激活 query。 */
export const buildActivationQuery = (
  currentInput: InputEnvelope,
  history: ContextWindow,
  recentTurns = RECALL_WINDOW_TURNS,
): string => {
  const userContent = inputContentToMessageContent(currentInput.content);
  const currentText = stringifyActivationContent(userContent);
  const trimmedEntries = stripTrailingCurrentTurn(history.entries, userContent);
  const recentUserMessages = trimmedEntries
    .filter((entry) => entry.role === "user")
    .slice(-recentTurns)
    .map((entry) => stringifyActivationContent(entry.content));
  return [...recentUserMessages, currentText].join("\n\n").slice(0, RECALL_QUERY_MAX_CHARS);
};
