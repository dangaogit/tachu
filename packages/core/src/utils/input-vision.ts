import type { InputEnvelope } from "../types/io";
import type { Message } from "../types/message";

/**
 * 判断输入信封是否含图像等多模态内容，应优先使用 `capabilityMapping.vision` 路由。
 */
export function envelopeNeedsVision(input: InputEnvelope): boolean {
  if (input.metadata?.modality === "image") {
    return true;
  }
  const raw = input.content;
  if (Array.isArray(raw)) {
    return raw.some(
      (p) =>
        p &&
        typeof p === "object" &&
        (p as { type?: string }).type === "image_url",
    );
  }
  return false;
}

/**
 * 是否为文生图请求（`metadata.textToImage === true` 且无读图多模态）。
 * 读图与文生图冲突时以读图为准。
 */
export function envelopeNeedsTextToImage(input: InputEnvelope): boolean {
  if (input.metadata?.textToImage !== true) {
    return false;
  }
  if (envelopeNeedsVision(input)) {
    return false;
  }
  return true;
}

/**
 * 判断消息列表是否包含需要视觉能力的 user/assistant 多模态内容。
 */
export function messagesNeedVision(messages: Message[]): boolean {
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    if (typeof m.content === "string") {
      continue;
    }
    if (
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url")
    ) {
      return true;
    }
  }
  return false;
}
