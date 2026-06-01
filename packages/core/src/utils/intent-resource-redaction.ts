import type { Message, MessageContentPart } from "../types/message";
import { renderTokensToDisplay } from "./resource-pool";

const isImagePart = (part: MessageContentPart): boolean => {
  if (part.type === "image_url") {
    return true;
  }
  return part.type === "file" && part.file.mimeType.startsWith("image/");
};

/** 旧式 `MessageContentPart[]` content 的降级（兜底，未经 core 装配的裸 part）。 */
const redactParts = (content: MessageContentPart[]): string => {
  let imageOrdinal = 0;
  let fileOrdinal = 0;
  const segments: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      segments.push(part.text);
      continue;
    }
    if (isImagePart(part)) {
      imageOrdinal += 1;
      segments.push(`[Image #${imageOrdinal}]`);
      continue;
    }
    if (part.type === "file") {
      fileOrdinal += 1;
      segments.push(`[File #${fileOrdinal}]`);
    }
  }
  return segments.join("\n");
};

/**
 * Intent 零物化：让意图分析 LLM 只看到轻量占位文本，绝不喂入
 * base64/二进制。
 *
 * - 已装配的 token 文本（`[[ref:kind:key]]`）→ 按本条 `resources` 渲染为 `[Image #N]`。
 * - 兜底：未经 core 装配的裸资源 part → 同样降级为 `[Image #N]` / `[File #N]` 占位。
 */
export const redactResourcesForIntent = (messages: readonly Message[]): Message[] =>
  messages.map((message) => {
    if (typeof message.content === "string") {
      return { ...message, content: renderTokensToDisplay(message.content, message.resources) };
    }
    return { ...message, content: redactParts(message.content) };
  });
