import { ValidationError } from "../errors";
import type { InputEnvelope } from "../types/io";
import type { Message, MessageContentPart } from "../types/message";

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface MultimodalImagePartInput {
  /** 必须以 `image/` 开头的 MIME，如 `image/png` */
  mimeType: string;
  /** 原始字节的 base64（不含 data: 前缀） */
  base64: string;
}

export interface BuildMultimodalUserContentOptions {
  /** 与图片一并提交的文字提示；可空（仅图） */
  text: string;
  images: MultimodalImagePartInput[];
}

function assertMime(mime: string): void {
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new ValidationError(
      "VALIDATION_INVALID_CONFIG",
      `不支持的图片 MIME：${mime}，允许：${[...ALLOWED_IMAGE_MIMES].join(", ")}`,
      { context: { mime } },
    );
  }
}

/**
 * 构造符合 Provider 多模态协议的 `Message.content`（文本 + 若干 `data:` 内联图）。
 */
export function buildMultimodalUserContent(options: BuildMultimodalUserContentOptions): Message["content"] {
  const { text, images } = options;
  if (images.length === 0) {
    const t = text.trim();
    if (t.length === 0) {
      throw new ValidationError(
        "VALIDATION_INVALID_CONFIG",
        "多模态消息至少需要一段文本或一张图片",
        {},
      );
    }
    return t;
  }

  for (const img of images) {
    assertMime(img.mimeType);
    if (img.base64.trim().length === 0) {
      throw new ValidationError("VALIDATION_INVALID_CONFIG", "图片 base64 不能为空", {});
    }
  }

  const parts: MessageContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    parts.push({ type: "text", text: trimmed });
  }
  for (const img of images) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
      },
    });
  }

  const only = parts[0];
  if (parts.length === 1 && only?.type === "text") {
    return only.text;
  }
  return parts;
}

export interface BuildMultimodalInputEnvelopeOptions extends BuildMultimodalUserContentOptions {
  /** 覆盖默认 metadata.source */
  source?: string;
}

/**
 * 构造送入 `Engine.run` / `runStream` 的 {@link InputEnvelope}（含 `metadata.modality`）。
 */
export function buildMultimodalInputEnvelope(
  options: BuildMultimodalInputEnvelopeOptions,
): InputEnvelope {
  const content = buildMultimodalUserContent(options);
  const hasImage =
    Array.isArray(content) && content.some((p) => p.type === "image_url");
  return {
    content,
    metadata: {
      modality: hasImage ? "image" : "text",
      source: options.source ?? "multimodal-envelope",
    },
  };
}

/**
 * 构造文生图用的 {@link InputEnvelope}（纯文本提示词，`metadata.textToImage=true`）。
 */
export function buildTextToImageInputEnvelope(
  prompt: string,
  source = "text-to-image-envelope",
): InputEnvelope {
  const t = typeof prompt === "string" ? prompt.trim() : "";
  return {
    content: t,
    metadata: {
      modality: "text",
      source,
      size: t.length,
      textToImage: true,
      explicitTextToImage: true,
    },
  };
}
