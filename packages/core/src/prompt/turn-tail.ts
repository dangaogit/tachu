import type { Message, MessageContentPart } from "../types/message";

/**
 * 判断两份 user 消息 content 是否等价。私有给 `stripTrailingCurrentTurn` 用，
 * 不对外导出，避免成为同义但语义微妙不一致的 utility（语义统一靠"只有一个出口"）。
 *
 * 覆盖以下等价：
 * 1. 双方都是 string → 严格相等
 * 2. 双方都是 `MessageContentPart[]` → 逐 part 深比较
 *
 * 其他形态（null / 对象 / 不匹配类型）一律视为不等。
 */
const userContentEquals = (a: unknown, b: Message["content"]): boolean => {
  if (a === b) {
    return true;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return contentPartsEqual(a as MessageContentPart[], b);
  }
  return false;
};

const contentPartsEqual = (a: MessageContentPart[], b: MessageContentPart[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!partEqual(a[i]!, b[i]!)) {
      return false;
    }
  }
  return true;
};

const partEqual = (a: MessageContentPart, b: MessageContentPart): boolean => {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === "text" && b.type === "text") {
    return a.text === b.text;
  }
  if (a.type === "image_url" && b.type === "image_url") {
    return (
      a.image_url.url === b.image_url.url &&
      a.image_url.detail === b.image_url.detail
    );
  }
  if (a.type === "file" && b.type === "file") {
    return (
      a.file.mimeType === b.file.mimeType &&
      a.file.uri === b.file.uri &&
      a.file.data === b.file.data &&
      a.file.name === b.file.name
    );
  }
  return false;
};

/**
 * 若 `history` 末尾恰好是一条 `role === "user"`、且其 `content` 与 `currentContent`
 * 等价的条目，返回去掉末尾该条的新数组；否则返回原数组**同引用**。
 *
 * ## 契约（load-bearing）
 *
 * 1. **只看 `history[length - 1]`**。绝不向前回溯。
 * 2. **至多剥 1 条**。即使倒数第二条也等于 `currentContent`，也只剥最后一条。
 *
 * 这两条不变式保证：用户连续多轮发同样字面（例如两次 "hello"），历史中那些
 * "重复"内容不会被误吞 —— 我们只剥本轮 `session.append` 写入 memory 的那一条
 * 影像（avoid double-emit），其他历史保持原状。
 *
 * ## 为什么需要这个
 *
 * `Session` 阶段会在 `assembler` 与下游 `intent` / `direct-answer` / `tool-use`
 * 读取 memory **之前**，把本轮 user 写入 memory（崩溃恢复语义）。这导致 memory
 * load 出来的 `history` 末尾已经带着本轮 user，下游再 push 一次 `currentInput`
 * 就会产生**双发**。该函数把"剥尾"这条不变式收敛到唯一一处，三个调用点统一行为。
 */
export function stripTrailingCurrentTurn<
  T extends { role: string; content: unknown },
>(history: readonly T[], currentContent: Message["content"]): readonly T[] {
  if (history.length === 0) {
    return history;
  }
  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    return history;
  }
  if (!userContentEquals(last.content, currentContent)) {
    return history;
  }
  return history.slice(0, -1);
}
