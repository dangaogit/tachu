import type {
  ChatRequest,
  InputEnvelope,
  InputMetadata,
  InputTransformer,
  MessageContentPart,
  ModelCapabilities,
  ProviderAdapter,
} from "@tachu/core";
import { DEFAULT_ADAPTER_CALL_CONTEXT, ProviderError } from "@tachu/core";

interface ImageToTextTransformerOptions {
  provider: ProviderAdapter;
  model?: string;
  promptTemplate?: string;
}

interface ImageContent {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
}

const DEFAULT_PROMPT = "请描述图片的主要内容、关键信息和可见文本。";

/**
 * 图像转文本转换器（基于 Provider Vision 能力）。
 */
export class ImageToTextTransformer implements InputTransformer {
  readonly modality = "image";

  private readonly provider: ProviderAdapter;
  private readonly model: string;
  private readonly promptTemplate: string;

  /**
   * 创建图像转换器。
   *
   * @param options 配置项
   */
  constructor(options: ImageToTextTransformerOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "gpt-4o";
    this.promptTemplate = options.promptTemplate ?? DEFAULT_PROMPT;
  }

  /**
   * 判断是否需要执行降级转换。
   *
   * @param metadata 输入元信息
   * @param modelCapabilities 模型能力
   * @returns true 表示需要转换
   */
  canHandle(metadata: InputMetadata, modelCapabilities: ModelCapabilities): boolean {
    return (
      metadata.modality === "image" &&
      !modelCapabilities.supportedModalities.includes("image")
    );
  }

  /**
   * 将图像输入转换为文本信封。
   *
   * @param envelope 输入信封
   * @returns 转换后的文本信封
   */
  async transform(envelope: InputEnvelope): Promise<InputEnvelope> {
    const content = envelope.content as ImageContent;
    const imageUrl =
      content.imageUrl ??
      (content.imageBase64
        ? `data:${content.mimeType ?? "image/png"};base64,${content.imageBase64}`
        : undefined);
    if (!imageUrl) {
      throw new ProviderError("PROVIDER_INVALID_INPUT", "缺少 imageUrl 或 imageBase64");
    }

    try {
      const parts: MessageContentPart[] = [
        { type: "text", text: this.promptTemplate },
        { type: "image_url", image_url: { url: imageUrl } },
      ];
      const request: ChatRequest = {
        model: this.model,
        messages: [
          {
            role: "user",
            content: parts,
          },
        ],
      };
      const response = await this.provider.chat(request, DEFAULT_ADAPTER_CALL_CONTEXT);
      return {
        content: response.content,
        metadata: {
          ...envelope.metadata,
          modality: "text",
          mimeType: "text/plain",
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", "图像转文本失败", {
        cause: error,
        retryable: true,
      });
    }
  }
}
