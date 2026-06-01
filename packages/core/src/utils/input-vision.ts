import type { InputEnvelope } from "../types/io";
import type { Message, MessageContentPart } from "../types/message";
import type { ResourceReference } from "../types/resource";

const VISION_KINDS = new Set(["image", "video"]);

const partNeedsVision = (part: MessageContentPart): boolean => {
  if (part.type === "image_url") {
    return true;
  }
  if (part.type === "file" && part.file.mimeType.startsWith("image/")) {
    return true;
  }
  return false;
};

const contentNeedsVision = (content: unknown): boolean => {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (p) => p && typeof p === "object" && partNeedsVision(p as MessageContentPart),
  );
};

const resourcesNeedVision = (
  resources: readonly ResourceReference[] | undefined,
): boolean => (resources ?? []).some((r) => VISION_KINDS.has(r.kind));

/**
 * 判断输入信封是否含图像等视觉内容，应优先使用 `capabilityMapping.vision` 路由。
 *
 * 起，重内容经旁路 Resource Pool 承载、正文仅 token，故除旧式 part 外，
 * 还需检查 `input.resources`。
 */
export function envelopeNeedsVision(input: InputEnvelope): boolean {
  if (input.metadata?.modality === "image") {
    return true;
  }
  if (resourcesNeedVision(input.resources)) {
    return true;
  }
  return contentNeedsVision(input.content);
}

/**
 * 判断消息列表是否包含需要视觉能力的 user/assistant 内容（含旁路 Resource Pool）。
 */
export function messagesNeedVision(messages: Message[]): boolean {
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    if (resourcesNeedVision(m.resources)) {
      return true;
    }
    if (typeof m.content === "string") {
      continue;
    }
    if (Array.isArray(m.content) && m.content.some(partNeedsVision)) {
      return true;
    }
  }
  return false;
}
