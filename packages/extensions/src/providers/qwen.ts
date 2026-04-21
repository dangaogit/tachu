import {
  ProviderError,
  TimeoutError,
  type ChatFinishReason,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type GeneratedImage,
  type Message,
  type MessageContentPart,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
} from "@tachu/core";
import { withAbortTimeout } from "../common/net";
import { OpenAIProviderAdapter } from "./openai";

/**
 * 从构造器级 `defaultHeaders` 去掉 `X-DashScope-SSE`，避免全局 `enable` 与非流式 `stream=false` 冲突；
 * 具体取值由 {@link OpenAIProviderAdapter} 按请求类型（chat / chatStream）单独设置。
 */
const stripDashScopeSseFromHeaders = (
  h: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!h) return h;
  const out = { ...h };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === "x-dashscope-sse") {
      delete out[k];
    }
  }
  return out;
};

const mergeOpenAiExtra = (
  extra: Record<string, unknown> | undefined,
  workspaceId: string | undefined,
): Record<string, unknown> | undefined => {
  const prevRaw =
    extra && typeof extra.defaultHeaders === "object" && extra.defaultHeaders !== null
      ? (extra.defaultHeaders as Record<string, string>)
      : {};
  const prevHeaders = stripDashScopeSseFromHeaders(prevRaw);
  if (!workspaceId) {
    if (prevRaw === prevHeaders) {
      return extra;
    }
    return { ...(extra ?? {}), defaultHeaders: prevHeaders };
  }
  return {
    ...(extra ?? {}),
    defaultHeaders: {
      ...prevHeaders,
      "X-DashScope-WorkSpace": workspaceId,
    },
  };
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DASHSCOPE_ORIGIN = "https://dashscope.aliyuncs.com";

/**
 * 万相 / 通义千问图像系列扩展参数（通过 {@link ChatRequest} 运行时强转传入）。
 *
 * 典型：
 * ```ts
 * const res = await adapter.chat(
 *   { ...request, qwenImage: { size: "2048*2048", n: 1, watermark: false } } as QwenChatRequest,
 * );
 * ```
 *
 * 三条生图路径共享本结构，按模型归属各取所需：
 *   1. `wanx-*`（异步 `text2image/image-synthesis`）—— 仅使用基础参数 + `refImage*`
 *   2. `wan2.x-image*`（同步 `multimodal-generation/generation`）—— 支持 `watermark` /
 *      `promptExtend` / `seed` / 2K `size` / `refImages[]` 等
 *   3. `qwen-image-*`（OpenAI 兼容 chat）—— 走 `messages.content = text[]` 格式
 */
export interface QwenImageParameters {
  negativePrompt?: string;
  size?: string;
  n?: number;
  style?: string;
  seed?: number;
  /** 参考图 URL（与消息内 `image_url` 二选一，显式字段优先） */
  refImage?: string;
  refStrength?: number;
  refMode?: "repaint" | "refonly";
  /** 多参考图（wan2.x-image 同步端点支持；为空时回退到 refImage / 消息内 image） */
  refImages?: string[];
  /** wan2.x-image：是否叠加 DashScope 水印。默认由服务端决定 */
  watermark?: boolean;
  /** wan2.x-image：开启 LLM 深度思考再生图 */
  thinkingMode?: boolean;
  /** wan2.x-image：是否用 LLM 重写 / 扩展 prompt */
  promptExtend?: boolean;
  /** wan2.x-image：开启分镜连贯生成（同一批多图剧情一致） */
  enableSequential?: boolean;
  /** wan2.x-image：布局约束框（相对 0..1） */
  bboxList?: Array<{ x: number; y: number; width: number; height: number }>;
  /** wan2.x-image：目标色板（hex）。超出 8 个服务端可能截断 */
  colorPalette?: string[];
  /** wan2.x-image：输出格式，默认服务端选 png */
  outputFormat?: "png" | "jpeg" | "webp";
}

export type QwenChatRequest = ChatRequest & { qwenImage?: QwenImageParameters };

interface QwenProviderOptions {
  apiKey?: string;
  /**
   * DashScope OpenAI 兼容接口根路径（不含尾部 `/`）。
   * 默认：`https://dashscope.aliyuncs.com/compatible-mode/v1`
   */
  compatibleBaseUrl?: string;
  /**
   * DashScope 网关根（不含路径），用于文生图异步 API 与任务查询。
   * 北京：`https://dashscope.aliyuncs.com`
   * 国际：`https://dashscope-intl.aliyuncs.com`
   */
  dashScopeOrigin?: string;
  /** RAM 子账号等场景下的百炼业务空间 ID，映射请求头 `X-DashScope-WorkSpace` */
  workspaceId?: string;
  timeoutMs?: number;
  /** 文生图任务轮询间隔（ms） */
  imageTaskPollIntervalMs?: number;
  modelListCacheTtlMs?: number;
  /**
   * 透传给内部 {@link OpenAI} 客户端构造器（与 OpenAI Provider 一致）。
   */
  extra?: Record<string, unknown>;
}

interface DashScopeTaskOutput {
  task_id?: string;
  task_status?: string;
  results?: Array<{ url?: string; code?: string; message?: string }>;
  code?: string;
  message?: string;
}

interface DashScopeEnvelope {
  request_id?: string;
  code?: string;
  message?: string;
  output?: DashScopeTaskOutput;
  usage?: { image_count?: number };
}

interface DashScopeMultimodalContentPart {
  text?: string;
  image?: string;
}

interface DashScopeMultimodalChoice {
  finish_reason?: string;
  message?: {
    role?: string;
    content?: DashScopeMultimodalContentPart[];
  };
}

interface DashScopeMultimodalEnvelope {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    choices?: DashScopeMultimodalChoice[];
  };
  usage?: {
    image_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

const isWanxImageModel = (model: string): boolean => /wanx/i.test(model);

/**
 * 判定走同步 `multimodal-generation/generation` 端点的生图模型。
 *
 * 目前覆盖：
 *   - `wan2.x-image` 系列（wan2.1-image、wan2.5-image、wan2.7-image、wan2.7-image-pro ...）
 *
 * 与 {@link isWanxImageModel} 互斥。`qwen-image-*` 系列目前仍走 OpenAI 兼容 chat，
 * 行为由 {@link isDashScopeImageChatModelRequiringListContent} 继续覆盖，以避免对
 * 已有用户的行为变更。
 */
const isDashScopeMultimodalImageGenerationModel = (model: string): boolean => {
  if (isWanxImageModel(model)) {
    return false;
  }
  return /^wan2\.\d+-image/i.test(model);
};

/**
 * 万相 `wanx-*` 走原生异步 `image-synthesis`；其余在兼容 chat 里走的生图模型（如
 * `qwen-image-*`、`wan2.x-image` 等）百炼常要求 `content` 为 list，不能为纯 string。
 * 用模型名含 `image` 且非 `wanx` 作启发式（与控制台 id 对齐）。
 *
 * 注意：`wan2.x-image*` 在当前实现下会被路由到专属 multimodal-generation 端点，
 * 不再经过 OpenAI 兼容 chat；因此此处判定结果虽然为 true 也不会触发，保留语义兼容。
 */
const isDashScopeImageChatModelRequiringListContent = (model: string): boolean => {
  if (isWanxImageModel(model)) {
    return false;
  }
  return /image/i.test(model);
};

/**
 * 将 string 形式的 `content` 转为 `[{ type: "text", text }]`，满足 DashScope 对生图类 chat 的校验。
 */
export const coerceStringContentToTextPartsForDashScopeQwenImage = (
  model: string,
  messages: Message[],
): Message[] => {
  if (!isDashScopeImageChatModelRequiringListContent(model)) {
    return messages;
  }
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { ...m, content: [{ type: "text" as const, text: m.content }] };
    }
    return m;
  });
};

const normalizeMessagesForDashScopeOpenAi = (model: string, messages: Message[]): Message[] => {
  const merged = mergeSystemIntoLastUserForDashScope(messages);
  return coerceStringContentToTextPartsForDashScopeQwenImage(model, merged);
};

/**
 * 百炼 OpenAI 兼容接口对部分模型不接受独立 `system` 行，且要求 `messages[0].role` 为 `user`、
 * 多模态时 `content` 为合法 list，典型 400：`Input should be 'user': input.messages.0.role`。
 *
 * 将 system 前缀合并进**最后一条 user**（引擎里即本轮当前输入；含多模态块时并入其文本前缀），
 * 与 Intent / direct-answer / tool-use 组装顺序一致：`[system, ...history, lastUser]`。
 *
 * @see https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope
 */
export const mergeSystemIntoLastUserForDashScope = (messages: Message[]): Message[] => {
  const systemTexts: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") {
        systemTexts.push(m.content);
      } else {
        systemTexts.push(
          m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"),
        );
      }
    } else {
      rest.push(m);
    }
  }
  if (systemTexts.length === 0) {
    return messages;
  }
  const prefix = systemTexts.join("\n\n").trim();
  if (prefix.length === 0) {
    return rest;
  }
  const prefixBlock = `${prefix}\n\n`;

  let idx = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i]!.role === "user") {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    return [{ role: "user", content: prefixBlock.trim() }, ...rest];
  }
  const target = rest[idx]!;
  const mergedContent = prependTextToUserContent(target.content, prefixBlock);
  const out = [...rest];
  out[idx] = { ...target, content: mergedContent };
  return out;
};

const prependTextToUserContent = (
  content: Message["content"],
  prefix: string,
): Message["content"] => {
  if (typeof content === "string") {
    return prefix + content;
  }
  const parts = [...content] as MessageContentPart[];
  const tIdx = parts.findIndex((p) => p.type === "text");
  if (tIdx >= 0) {
    const t = parts[tIdx] as { type: "text"; text: string };
    const next = [...parts];
    next[tIdx] = { type: "text", text: prefix + t.text };
    return next;
  }
  return [{ type: "text", text: prefix.trimEnd() }, ...parts];
};

const inferTextModelCapabilities = (modelName: string): ModelInfo["capabilities"] => {
  const lowered = modelName.toLowerCase();
  const vision = lowered.includes("vl") || lowered.includes("vision");
  const longContext =
    lowered.includes("max") || lowered.includes("72b") || lowered.includes("32k") || lowered.includes("128k");
  return {
    supportedModalities: vision ? ["text", "image"] : ["text"],
    maxContextTokens: longContext ? 128_000 : 32_000,
    supportsStreaming: true,
    supportsFunctionCalling: true,
  };
};

const wanxCapabilities = (): ModelCapabilities => ({
  supportedModalities: ["text", "image"],
  maxContextTokens: 2_000,
  supportsStreaming: false,
  supportsFunctionCalling: false,
});

const FALLBACK_MODELS: ModelInfo[] = [
  { modelName: "qwen-turbo", capabilities: inferTextModelCapabilities("qwen-turbo") },
  { modelName: "qwen-plus", capabilities: inferTextModelCapabilities("qwen-plus") },
  { modelName: "qwen-max", capabilities: inferTextModelCapabilities("qwen-max") },
  { modelName: "qwen-vl-plus", capabilities: inferTextModelCapabilities("qwen-vl-plus") },
  { modelName: "qwen-vl-max", capabilities: inferTextModelCapabilities("qwen-vl-max") },
  { modelName: "wanx-v1", capabilities: wanxCapabilities() },
];

const extractUserPrompt = (
  messages: Message[],
): { prompt: string; refImageFromMessage?: string } => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return { prompt: "" };
  }
  if (typeof lastUser.content === "string") {
    return { prompt: lastUser.content.trim() };
  }
  const text = lastUser.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  const imagePart = lastUser.content.find((p) => p.type === "image_url");
  if (imagePart?.type === "image_url") {
    return { prompt: text, refImageFromMessage: imagePart.image_url.url };
  }
  return { prompt: text };
};

const mapFetchError = (status: number, body: string): ProviderError => {
  if (status === 401) {
    return new ProviderError("PROVIDER_AUTH_FAILED", body || "DashScope 鉴权失败", {
      retryable: false,
    });
  }
  if (status === 429) {
    return new ProviderError("PROVIDER_RATE_LIMITED", body || "DashScope 限流", {
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError("PROVIDER_UPSTREAM_ERROR", body || "DashScope 服务端错误", {
      retryable: true,
    });
  }
  return new ProviderError("PROVIDER_CALL_FAILED", body || `DashScope HTTP ${status}`, {
    retryable: true,
  });
};

const parseDashScopeEnvelope = (raw: string): DashScopeEnvelope => {
  try {
    return JSON.parse(raw) as DashScopeEnvelope;
  } catch {
    return {};
  }
};

const parseDashScopeMultimodalEnvelope = (raw: string): DashScopeMultimodalEnvelope => {
  try {
    return JSON.parse(raw) as DashScopeMultimodalEnvelope;
  } catch {
    return {};
  }
};

const inferImageMimeTypeFromUrl = (url: string): string | undefined => {
  if (url.startsWith("data:")) {
    const semi = url.indexOf(";");
    if (semi > "data:".length) {
      return url.slice("data:".length, semi);
    }
    return undefined;
  }
  const clean = url.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = clean.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return undefined;
  }
};

const collectRefImageUrls = (
  img: QwenImageParameters,
  refFromMessage: string | undefined,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: string | undefined): void => {
    if (!u) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  if (Array.isArray(img.refImages)) {
    for (const u of img.refImages) {
      push(u);
    }
  }
  push(img.refImage);
  push(refFromMessage);
  return out;
};

const buildMultimodalImageParameters = (
  img: QwenImageParameters,
): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  if (img.size) params.size = img.size;
  if (typeof img.n === "number") params.n = img.n;
  if (typeof img.seed === "number") params.seed = img.seed;
  if (typeof img.watermark === "boolean") params.watermark = img.watermark;
  if (typeof img.thinkingMode === "boolean") params.thinking_mode = img.thinkingMode;
  if (typeof img.promptExtend === "boolean") params.prompt_extend = img.promptExtend;
  if (typeof img.enableSequential === "boolean") {
    params.enable_sequential = img.enableSequential;
  }
  if (img.negativePrompt) params.negative_prompt = img.negativePrompt;
  if (Array.isArray(img.bboxList) && img.bboxList.length > 0) {
    params.bbox_list = img.bboxList;
  }
  if (Array.isArray(img.colorPalette) && img.colorPalette.length > 0) {
    params.color_palette = img.colorPalette;
  }
  if (img.outputFormat) params.output_format = img.outputFormat;
  if (img.style) params.style = img.style;
  return params;
};

/**
 * 阿里云百炼 Qwen / 万相（DashScope）Provider。
 *
 * - 文本与多模态对话：OpenAI 兼容接口 `compatible-mode/v1`（与官方示例一致）。
 * - 文生图：`wanx-*` 模型走异步 `text2image/image-synthesis` + `tasks` 轮询（HTTP 仅支持异步）。
 *
 * @see https://help.aliyun.com/zh/dashscope/developer-reference/api-details-9
 */
export class QwenProviderAdapter implements ProviderAdapter {
  readonly id = "qwen";
  readonly name = "Qwen (DashScope)";

  private readonly inner: OpenAIProviderAdapter;
  private readonly apiKey: string;
  private readonly dashScopeOrigin: string;
  private readonly workspaceId: string | undefined;
  private readonly timeoutMs: number;
  private readonly imageTaskPollIntervalMs: number;

  constructor(options: QwenProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        "PROVIDER_MISSING_CREDENTIALS",
        "缺少 DASHSCOPE_API_KEY 或 options.apiKey",
      );
    }
    this.apiKey = apiKey;
    this.dashScopeOrigin = (options.dashScopeOrigin ?? DEFAULT_DASHSCOPE_ORIGIN).replace(/\/$/, "");
    this.workspaceId = options.workspaceId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.imageTaskPollIntervalMs = options.imageTaskPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const compatibleBaseUrl =
      options.compatibleBaseUrl ?? `${this.dashScopeOrigin}/compatible-mode/v1`;

    const mergedExtra = mergeOpenAiExtra(options.extra, this.workspaceId);
    this.inner = new OpenAIProviderAdapter({
      apiKey,
      baseURL: compatibleBaseUrl,
      timeoutMs: this.timeoutMs,
      ...(options.modelListCacheTtlMs !== undefined
        ? { modelListCacheTtlMs: options.modelListCacheTtlMs }
        : {}),
      ...(mergedExtra ? { extra: mergedExtra } : {}),
    });
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    try {
      const raw = await this.inner.listAvailableModels();
      return raw.map((m) =>
        isWanxImageModel(m.modelName)
          ? { modelName: m.modelName, capabilities: wanxCapabilities() }
          : { modelName: m.modelName, capabilities: inferTextModelCapabilities(m.modelName) },
      );
    } catch {
      return FALLBACK_MODELS;
    }
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (isWanxImageModel(request.model)) {
      return this.chatImageSynthesis(request as QwenChatRequest, signal);
    }
    if (isDashScopeMultimodalImageGenerationModel(request.model)) {
      return this.chatMultimodalGeneration(request as QwenChatRequest, signal);
    }
    const normalized: ChatRequest = {
      ...request,
      messages: normalizeMessagesForDashScopeOpenAi(request.model, request.messages),
    };
    return this.inner.chat(normalized, signal);
  }

  async *chatStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    if (
      isWanxImageModel(request.model) ||
      isDashScopeMultimodalImageGenerationModel(request.model)
    ) {
      const res = isWanxImageModel(request.model)
        ? await this.chatImageSynthesis(request as QwenChatRequest, signal)
        : await this.chatMultimodalGeneration(request as QwenChatRequest, signal);
      for (const char of res.content) {
        if (signal?.aborted) {
          throw new ProviderError("PROVIDER_CALL_FAILED", "请求已取消", { cause: signal.reason });
        }
        yield { type: "text-delta", delta: char };
      }
      yield {
        type: "finish",
        finishReason: "stop" satisfies ChatFinishReason,
        usage: res.usage,
      };
      return;
    }
    const normalized: ChatRequest = {
      ...request,
      messages: normalizeMessagesForDashScopeOpenAi(request.model, request.messages),
    };
    yield* this.inner.chatStream(normalized, signal);
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    if (isWanxImageModel(model) || isDashScopeMultimodalImageGenerationModel(model)) {
      const { prompt } = extractUserPrompt(messages);
      return Math.ceil(prompt.length / 4);
    }
    return this.inner.countTokens!(
      normalizeMessagesForDashScopeOpenAi(model, messages),
      model,
    );
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }

  private async chatImageSynthesis(
    request: QwenChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const { prompt, refImageFromMessage } = extractUserPrompt(request.messages);
    if (!prompt) {
      throw new ProviderError(
        "PROVIDER_INVALID_INPUT",
        "万相文生图需要最后一条 user 消息包含非空文本提示词",
      );
    }
    const img = request.qwenImage ?? {};
    const ref_img = img.refImage ?? refImageFromMessage;

    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const taskId = await this.createImageTask(request.model, prompt, img, ref_img, timeout.signal);
      const out = await this.pollTaskUntilDone(taskId, timeout.signal);
      const lines: string[] = [];
      const images: GeneratedImage[] = [];
      const results = out.output?.results ?? [];
      let idx = 0;
      for (const r of results) {
        if (typeof r.url === "string" && r.url.length > 0) {
          lines.push(`![generated-${idx + 1}](${r.url})\n\n${r.url}`);
          images.push({
            url: r.url,
            index: idx,
            mimeType: inferImageMimeTypeFromUrl(r.url),
            ...(img.size ? { size: img.size } : {}),
            providerMetadata: {
              provider: this.id,
              model: request.model,
              taskId: out.output?.task_id ?? taskId,
              ...(out.request_id ? { requestId: out.request_id } : {}),
            },
          });
          idx += 1;
        } else if (r.message || r.code) {
          lines.push(`[图片 ${idx + 1} 失败] ${r.code ?? ""} ${r.message ?? ""}`.trim());
          idx += 1;
        }
      }
      const content =
        lines.length > 0
          ? lines.join("\n\n")
          : `任务已完成，但未解析到图片 URL（task_id=${out.output?.task_id ?? taskId}）`;
      const imageCount = out.usage?.image_count ?? images.length;
      return {
        content,
        finishReason: "stop",
        usage: {
          promptTokens: Math.ceil(prompt.length / 4),
          completionTokens: imageCount,
          totalTokens: Math.ceil(prompt.length / 4) + imageCount,
        },
        ...(images.length > 0 ? { images } : {}),
      };
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * 同步调用 DashScope `POST /api/v1/services/aigc/multimodal-generation/generation`
   * 为 `wan2.x-image*` 系列提供文生图能力。
   *
   * 请求结构：
   * ```json
   * {
   *   "model": "wan2.7-image",
   *   "input": {
   *     "messages": [
   *       {"role": "user", "content": [{"text": "..."}, {"image": "https://..."}]}
   *     ]
   *   },
   *   "parameters": {"size": "2048*2048", "n": 1, "watermark": false}
   * }
   * ```
   *
   * 响应结构：
   * ```json
   * {"output": {"choices": [{"message": {"content": [{"image": "https://..."}]}}]}}
   * ```
   *
   * @see https://help.aliyun.com/zh/model-studio/text-to-image-api-reference
   */
  private async chatMultimodalGeneration(
    request: QwenChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const { prompt, refImageFromMessage } = extractUserPrompt(request.messages);
    if (!prompt) {
      throw new ProviderError(
        "PROVIDER_INVALID_INPUT",
        `${request.model} 需要最后一条 user 消息包含非空文本提示词`,
      );
    }
    const img = request.qwenImage ?? {};
    const refImageUrls = collectRefImageUrls(img, refImageFromMessage);

    const contentParts: DashScopeMultimodalContentPart[] = [{ text: prompt }];
    for (const url of refImageUrls) {
      contentParts.push({ image: url });
    }
    const body: Record<string, unknown> = {
      model: request.model,
      input: {
        messages: [{ role: "user", content: contentParts }],
      },
      parameters: buildMultimodalImageParameters(img),
    };

    const url = `${this.dashScopeOrigin}/api/v1/services/aigc/multimodal-generation/generation`;
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(false),
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw mapFetchError(res.status, text);
      }
      const env = parseDashScopeMultimodalEnvelope(text);
      if (env.code != null && String(env.code).length > 0) {
        throw new ProviderError(
          "PROVIDER_UPSTREAM_ERROR",
          env.message ?? String(env.code),
          { retryable: false },
        );
      }
      const choices = env.output?.choices ?? [];
      const lines: string[] = [];
      const images: GeneratedImage[] = [];
      let idx = 0;
      for (const choice of choices) {
        const parts = choice.message?.content ?? [];
        for (const p of parts) {
          if (typeof p.image === "string" && p.image.length > 0) {
            lines.push(`![generated-${idx + 1}](${p.image})\n\n${p.image}`);
            images.push({
              url: p.image,
              index: idx,
              mimeType: inferImageMimeTypeFromUrl(p.image),
              ...(img.size ? { size: img.size } : {}),
              providerMetadata: {
                provider: this.id,
                model: request.model,
                endpoint: "multimodal-generation",
                ...(env.request_id ? { requestId: env.request_id } : {}),
                ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
              },
            });
            idx += 1;
          } else if (typeof p.text === "string" && p.text.length > 0) {
            lines.push(p.text);
          }
        }
      }
      const content =
        lines.length > 0
          ? lines.join("\n\n")
          : `${request.model} 已返回，但未解析到图片结果（request_id=${env.request_id ?? "n/a"}）`;
      const promptTokens = env.usage?.input_tokens ?? Math.ceil(prompt.length / 4);
      const completionTokens =
        env.usage?.output_tokens ?? env.usage?.image_count ?? images.length;
      return {
        content,
        finishReason: "stop",
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: env.usage?.total_tokens ?? promptTokens + completionTokens,
        },
        ...(images.length > 0 ? { images } : {}),
      };
    } finally {
      timeout.cleanup();
    }
  }

  private buildHeaders(asyncEnable: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (asyncEnable) {
      h["X-DashScope-Async"] = "enable";
    }
    if (this.workspaceId) {
      h["X-DashScope-WorkSpace"] = this.workspaceId;
    }
    return h;
  }

  private async createImageTask(
    model: string,
    prompt: string,
    img: QwenImageParameters,
    ref_img: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const input: Record<string, unknown> = { prompt };
    if (img.negativePrompt) {
      input.negative_prompt = img.negativePrompt;
    }
    if (ref_img) {
      input.ref_img = ref_img;
    }
    const parameters: Record<string, unknown> = {
      style: img.style ?? "<auto>",
      size: img.size ?? "1024*1024",
      n: img.n ?? 1,
    };
    if (img.seed !== undefined) {
      parameters.seed = img.seed;
    }
    if (ref_img) {
      if (img.refStrength !== undefined) {
        parameters.ref_strength = img.refStrength;
      }
      if (img.refMode) {
        parameters.ref_mode = img.refMode;
      }
    }

    const url = `${this.dashScopeOrigin}/api/v1/services/aigc/text2image/image-synthesis`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify({ model, input, parameters }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw mapFetchError(res.status, text);
    }
    const env = parseDashScopeEnvelope(text);
    if (env.code != null && String(env.code).length > 0) {
      throw new ProviderError("PROVIDER_UPSTREAM_ERROR", env.message ?? String(env.code), {
        retryable: false,
      });
    }
    const taskId = env.output?.task_id;
    if (!taskId) {
      throw new ProviderError("PROVIDER_CALL_FAILED", "文生图创建任务未返回 task_id", { retryable: true });
    }
    return taskId;
  }

  private async pollTaskUntilDone(taskId: string, signal: AbortSignal): Promise<DashScopeEnvelope> {
    const url = `${this.dashScopeOrigin}/api/v1/tasks/${encodeURIComponent(taskId)}`;
    const start = Date.now();
    while (true) {
      if (signal.aborted) {
        throw new ProviderError("PROVIDER_CALL_FAILED", "请求已取消", { cause: signal.reason });
      }
      const res = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(false),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw mapFetchError(res.status, text);
      }
      const env = parseDashScopeEnvelope(text);
      const status = env.output?.task_status;
      if (status === "SUCCEEDED") {
        return env;
      }
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        const msg = env.output?.message ?? env.message ?? env.output?.code ?? status;
        throw new ProviderError("PROVIDER_UPSTREAM_ERROR", `文生图任务失败: ${msg}`, {
          retryable: false,
        });
      }
      if (Date.now() - start > this.timeoutMs) {
        throw new TimeoutError("TIMEOUT_PROVIDER_REQUEST", "文生图任务等待超时", { retryable: true });
      }
      await new Promise((r) => setTimeout(r, this.imageTaskPollIntervalMs));
    }
  }
}
