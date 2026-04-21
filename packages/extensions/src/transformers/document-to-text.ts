import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type { InputEnvelope, InputMetadata, InputTransformer, ModelCapabilities } from "@tachu/core";
import { ValidationError } from "@tachu/core";

interface DocumentContent {
  path: string;
  mimeType?: string;
}

const MAX_TEXT_CHARS = 500_000;

const truncateIfNeeded = (text: string): string => {
  if (text.length <= MAX_TEXT_CHARS) {
    return text;
  }
  const trimmed = text.slice(0, MAX_TEXT_CHARS);
  return `${trimmed}\n\n[TRUNCATED:${text.length - MAX_TEXT_CHARS}]`;
};

/**
 * 文档转文本转换器（PDF / DOCX）。
 */
export class DocumentToTextTransformer implements InputTransformer {
  readonly modality = "document";

  /**
   * 判断是否需要文档降级。
   *
   * @param metadata 输入元信息
   * @param modelCapabilities 模型能力
   * @returns true 表示需要转换
   */
  canHandle(metadata: InputMetadata, modelCapabilities: ModelCapabilities): boolean {
    const modality = metadata.modality ?? "";
    const isDocument = modality === "document" || modality === "file";
    return isDocument && !modelCapabilities.supportedModalities.includes("file");
  }

  /**
   * 将文档转换为文本信封。
   *
   * @param envelope 输入信封
   * @returns 文本信封
   */
  async transform(envelope: InputEnvelope): Promise<InputEnvelope> {
    const content = envelope.content as DocumentContent;
    if (!content.path) {
      throw new ValidationError("VALIDATION_DOCUMENT_PATH", "文档输入缺少 path");
    }
    const mimeType = content.mimeType ?? envelope.metadata.mimeType ?? "";

    let text = "";
    if (mimeType.includes("pdf") || content.path.toLowerCase().endsWith(".pdf")) {
      const buffer = await readFile(content.path);
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      text = parsed.text;
      await parser.destroy();
    } else if (
      mimeType.includes("word") ||
      mimeType.includes("officedocument") ||
      content.path.toLowerCase().endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({ path: content.path });
      text = result.value;
    } else {
      text = await readFile(content.path, "utf8");
    }

    return {
      content: truncateIfNeeded(text),
      metadata: {
        ...envelope.metadata,
        modality: "text",
        mimeType: "text/plain",
      },
    };
  }
}
