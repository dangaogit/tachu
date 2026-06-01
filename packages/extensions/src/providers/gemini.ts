import { GoogleGenAI } from "@google/genai";
import {
  ProviderError,
  TimeoutError,
  type AdapterCallContext,
  type ChatFinishReason,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type ChatUsage,
  type EmbeddingContent,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type GeneratedImage,
  type GeneratedMedia,
  type Message,
  type MessageContentPart,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderMetadata,
  type RerankRequest,
  type RerankResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "@tachu/core";
import { withAbortTimeout } from "../common/net";

export interface GeminiProviderOptions {
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  baseURL?: string;
  apiVersion?: string;
  timeoutMs?: number;
  extra?: Record<string, unknown>;
  modelListCacheTtlMs?: number;
  client?: GeminiClientLike;
}

export interface GeminiClientLike {
  models: {
    generateContent(params: Record<string, unknown>): Promise<GeminiGenerateContentResponse>;
    generateContentStream(
      params: Record<string, unknown>,
    ): Promise<AsyncIterable<GeminiGenerateContentResponse>>;
    embedContent(params: Record<string, unknown>): Promise<GeminiEmbedContentResponse>;
    countTokens?(
      params: Record<string, unknown>,
    ): Promise<{ totalTokens?: number; cachedContentTokenCount?: number }>;
    list?(params?: Record<string, unknown>): Promise<GeminiModelPager | { page?: GeminiModel[] }>;
  };
}

export type GeminiChatRequest = ChatRequest & {
  topP?: number;
  topK?: number;
  stop?: string[];
};

interface GeminiPart {
  text?: string | undefined;
  inlineData?: { mimeType?: string | undefined; data?: string | undefined } | undefined;
  fileData?:
    | { mimeType?: string | undefined; fileUri?: string | undefined; displayName?: string | undefined }
    | undefined;
  functionCall?:
    | { id?: string | undefined; name?: string | undefined; args?: Record<string, unknown> | undefined }
    | undefined;
  functionResponse?:
    | {
        id?: string | undefined;
        name?: string | undefined;
        response?: Record<string, unknown> | undefined;
      }
    | undefined;
  thought?: boolean | undefined;
  thoughtSignature?: string | undefined;
  partMetadata?: Record<string, unknown> | undefined;
}

interface GeminiContent {
  role?: "user" | "model" | string | undefined;
  parts?: GeminiPart[] | undefined;
}

interface GeminiCandidate {
  content?: GeminiContent | undefined;
  finishReason?: string | undefined;
  finishMessage?: string | undefined;
  index?: number | undefined;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[] | undefined;
  usageMetadata?:
    | {
        promptTokenCount?: number | undefined;
        candidatesTokenCount?: number | undefined;
        thoughtsTokenCount?: number | undefined;
        toolUsePromptTokenCount?: number | undefined;
        totalTokenCount?: number | undefined;
        cachedContentTokenCount?: number | undefined;
      }
    | undefined;
  responseId?: string | undefined;
  modelVersion?: string | undefined;
  text?: string | undefined;
}

interface GeminiEmbedContentResponse {
  embeddings?: Array<{ values?: number[] | undefined }> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface GeminiModel {
  name?: string | undefined;
  displayName?: string | undefined;
  inputTokenLimit?: number | undefined;
  supportedActions?: string[] | undefined;
  thinking?: boolean | undefined;
}

interface GeminiModelPager extends AsyncIterable<GeminiModel> {
  page?: GeminiModel[] | undefined;
}

interface GeminiRequestPayload {
  systemInstruction?: GeminiContent | undefined;
  contents: GeminiContent[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

const FALLBACK_MODELS: ModelInfo[] = [
  {
    modelName: "gemini-3-pro-preview",
    capabilities: {
      supportedModalities: ["text", "image", "audio", "video", "file"],
      supportedOutputModalities: ["text"],
      maxContextTokens: 1_000_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsStructuredOutput: true,
    },
  },
  {
    modelName: "gemini-2.5-pro",
    capabilities: {
      supportedModalities: ["text", "image", "audio", "video", "file"],
      supportedOutputModalities: ["text"],
      maxContextTokens: 1_000_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsStructuredOutput: true,
    },
  },
  {
    modelName: "gemini-2.5-flash",
    capabilities: {
      supportedModalities: ["text", "image", "audio", "video", "file"],
      supportedOutputModalities: ["text"],
      maxContextTokens: 1_000_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsStructuredOutput: true,
    },
  },
  {
    modelName: "gemini-2.5-flash-image",
    capabilities: {
      supportedModalities: ["text", "image", "file"],
      supportedOutputModalities: ["text", "image"],
      maxContextTokens: 128_000,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsStructuredOutput: true,
    },
  },
  {
    modelName: "text-embedding-004",
    capabilities: {
      supportedModalities: ["text"],
      maxContextTokens: 8_192,
      supportsStreaming: false,
      supportsFunctionCalling: false,
      supportsEmbeddings: true,
      supportsRerank: true,
    },
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeModelName = (name: string): string =>
  name.startsWith("models/") ? name.slice("models/".length) : name;

const inferMediaType = (mimeType: string): GeneratedMedia["type"] => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
};

const inferImageMimeTypeFromUrl = (url: string): string => {
  const lowered = url.toLowerCase();
  if (lowered.startsWith("data:")) {
    const match = /^data:([^;,]+)[;,]/.exec(lowered);
    return match?.[1] ?? "image/png";
  }
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".gif")) return "image/gif";
  return "image/png";
};

const parseDataUrl = (value: string): { mimeType: string; data: string } | null => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) {
    return null;
  }
  const mimeType = match[1];
  const data = match[2];
  if (!mimeType || !data) {
    return null;
  }
  return { mimeType, data };
};

const toTextContent = (content: Message["content"]): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return `[image:${part.image_url.url}]`;
      return `[file:${part.file.mimeType}:${part.file.name ?? part.file.uri ?? "inline"}]`;
    })
    .join("");
};

const normalizeToolResponse = (content: Message["content"]): Record<string, unknown> => {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        /* plain text tool result */
      }
    }
    return { output: content };
  }
  const text = toTextContent(content);
  return { output: text };
};

const toGeminiUserParts = (content: Message["content"]): GeminiPart[] => {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      const dataUrl = parseDataUrl(part.image_url.url);
      if (dataUrl) {
        parts.push({ inlineData: { mimeType: dataUrl.mimeType, data: dataUrl.data } });
      } else {
        parts.push({
          fileData: {
            mimeType: inferImageMimeTypeFromUrl(part.image_url.url),
            fileUri: part.image_url.url,
          },
        });
      }
    } else if (part.file.data) {
      parts.push({
        inlineData: {
          mimeType: part.file.mimeType,
          data: part.file.data,
        },
      });
    } else if (part.file.uri) {
      parts.push({
        fileData: {
          mimeType: part.file.mimeType,
          fileUri: part.file.uri,
          ...(part.file.name ? { displayName: part.file.name } : {}),
        },
      });
    } else {
      parts.push({ text: `[file:${part.file.mimeType}:${part.file.name ?? "inline"}]` });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
};

const safeGeminiPart = (value: unknown): GeminiPart | null => {
  if (!isRecord(value)) {
    return null;
  }
  const part: GeminiPart = {};
  if (typeof value.text === "string") {
    part.text = value.text;
  }
  if (value.thought === true) {
    part.thought = true;
  }
  if (typeof value.thoughtSignature === "string") {
    part.thoughtSignature = value.thoughtSignature;
  }
  if (isRecord(value.partMetadata)) {
    part.partMetadata = value.partMetadata;
  }
  return Object.keys(part).length > 0 ? part : null;
};

const getThoughtPartsFromMetadata = (
  metadata: ProviderMetadata | undefined,
): GeminiPart[] => {
  const raw = metadata?.geminiThoughtParts;
  if (Array.isArray(raw)) {
    return raw.map(safeGeminiPart).filter((part): part is GeminiPart => part !== null);
  }
  const nested = metadata?.gemini;
  if (isRecord(nested) && Array.isArray(nested.thoughtParts)) {
    return nested.thoughtParts
      .map(safeGeminiPart)
      .filter((part): part is GeminiPart => part !== null);
  }
  return [];
};

const getToolThoughtSignature = (
  metadata: ProviderMetadata | undefined,
): string | undefined => {
  if (!metadata) return undefined;
  if (typeof metadata.thoughtSignature === "string") {
    return metadata.thoughtSignature;
  }
  const nested = metadata.gemini;
  if (isRecord(nested) && typeof nested.thoughtSignature === "string") {
    return nested.thoughtSignature;
  }
  return undefined;
};

const toGeminiAssistantParts = (message: Message): GeminiPart[] => {
  const parts: GeminiPart[] = [];
  parts.push(...getThoughtPartsFromMetadata(message.providerMetadata));

  const content = message.content;
  if (typeof content === "string") {
    if (content.length > 0) {
      parts.push({ text: content });
    }
  } else {
    for (const part of content) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      }
    }
  }

  for (const call of message.toolCalls ?? []) {
    const thoughtSignature = getToolThoughtSignature(call.providerMetadata);
    parts.push({
      functionCall: {
        id: call.id,
        name: call.name,
        args: call.arguments,
      },
      ...(thoughtSignature ? { thoughtSignature } : {}),
    });
  }

  return parts.length > 0 ? parts : [{ text: "" }];
};

const toGeminiMessages = (messages: Message[]): GeminiRequestPayload => {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(...toGeminiUserParts(message.content));
      continue;
    }
    if (message.role === "assistant") {
      contents.push({ role: "model", parts: toGeminiAssistantParts(message) });
      continue;
    }
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              ...(message.toolCallId ? { id: message.toolCallId } : {}),
              name: message.name ?? message.toolCallId ?? "tool",
              response: normalizeToolResponse(message.content),
            },
          },
        ],
      });
      continue;
    }
    contents.push({ role: "user", parts: toGeminiUserParts(message.content) });
  }

  return {
    ...(systemParts.length > 0
      ? { systemInstruction: { role: "user", parts: systemParts } }
      : {}),
    contents,
  };
};

const toGeminiTools = (tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    },
  ];
};

const applyProviderConfig = (
  config: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
): void => {
  const geminiConfig = providerOptions?.geminiConfig;
  if (isRecord(geminiConfig)) {
    Object.assign(config, geminiConfig);
  }
};

const buildGenerateConfig = (request: ChatRequest): Record<string, unknown> => {
  const extended = request as GeminiChatRequest;
  const config: Record<string, unknown> = {};
  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    config.maxOutputTokens = request.maxTokens;
  }
  if (extended.topP !== undefined) {
    config.topP = extended.topP;
  }
  if (extended.topK !== undefined) {
    config.topK = extended.topK;
  }
  if (extended.stop && extended.stop.length > 0) {
    config.stopSequences = extended.stop;
  }
  if (request.responseModalities && request.responseModalities.length > 0) {
    config.responseModalities = request.responseModalities;
  }
  if (request.structuredOutput) {
    config.responseMimeType = request.structuredOutput.mimeType ?? "application/json";
    config.responseJsonSchema = request.structuredOutput.schema;
  }
  const tools = toGeminiTools(request.tools);
  if (tools) {
    config.tools = tools;
    config.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  applyProviderConfig(config, request.providerOptions);
  return config;
};

const mapGeminiFinishReason = (
  raw: unknown,
  hasToolCalls: boolean,
): ChatFinishReason => {
  if (hasToolCalls) return "tool_calls";
  if (raw === "STOP") return "stop";
  if (raw === "MAX_TOKENS") return "length";
  if (
    raw === "SAFETY" ||
    raw === "RECITATION" ||
    raw === "BLOCKLIST" ||
    raw === "PROHIBITED_CONTENT" ||
    raw === "SPII"
  ) {
    return "content_filter";
  }
  if (raw === undefined || raw === null || raw === "FINISH_REASON_UNSPECIFIED") {
    return "unknown";
  }
  return "unknown";
};

const mapUsage = (response: GeminiGenerateContentResponse): ChatUsage => {
  const usage = response.usageMetadata;
  const promptTokens = usage?.promptTokenCount ?? 0;
  const completionTokens =
    (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      usage?.totalTokenCount ??
      promptTokens + completionTokens + (usage?.toolUsePromptTokenCount ?? 0),
    ...(typeof usage?.cachedContentTokenCount === "number" && usage.cachedContentTokenCount > 0
      ? { cachedPromptTokens: usage.cachedContentTokenCount }
      : {}),
  };
};

const extractParts = (response: GeminiGenerateContentResponse): GeminiPart[] =>
  response.candidates?.[0]?.content?.parts ?? [];

const extractTextFromParts = (parts: GeminiPart[], thought: boolean): string =>
  parts
    .filter((part) => (thought ? part.thought === true : part.thought !== true))
    .map((part) => part.text ?? "")
    .join("");

const extractMedia = (parts: GeminiPart[], model: string): GeneratedMedia[] => {
  const media: GeneratedMedia[] = [];
  for (const part of parts) {
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData.mimeType) {
      media.push({
        type: inferMediaType(inlineData.mimeType),
        index: media.length,
        mimeType: inlineData.mimeType,
        data: inlineData.data,
        providerMetadata: { provider: "gemini", model, source: "inlineData" },
      });
    }
    const fileData = part.fileData;
    if (fileData?.fileUri && fileData.mimeType) {
      media.push({
        type: inferMediaType(fileData.mimeType),
        index: media.length,
        mimeType: fileData.mimeType,
        url: fileData.fileUri,
        ...(fileData.displayName ? { name: fileData.displayName } : {}),
        providerMetadata: { provider: "gemini", model, source: "fileData" },
      });
    }
  }
  return media;
};

const mediaToImages = (media: GeneratedMedia[]): GeneratedImage[] => {
  const images: GeneratedImage[] = [];
  for (const item of media) {
    if (item.type !== "image") {
      continue;
    }
    const url = item.url ?? `data:${item.mimeType};base64,${item.data ?? ""}`;
    images.push({
      url,
      index: images.length,
      mimeType: item.mimeType,
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
    });
  }
  return images;
};

const buildResponseMetadata = (
  response: GeminiGenerateContentResponse,
  parts: GeminiPart[],
  finishReason: string | undefined,
): ProviderMetadata | undefined => {
  const thoughtParts = parts
    .filter((part) => part.thought === true || typeof part.thoughtSignature === "string")
    .map((part) => ({
      ...(part.text !== undefined ? { text: part.text } : {}),
      ...(part.thought !== undefined ? { thought: part.thought } : {}),
      ...(part.thoughtSignature !== undefined ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(part.partMetadata !== undefined ? { partMetadata: part.partMetadata } : {}),
    }));
  if (
    thoughtParts.length === 0 &&
    response.responseId === undefined &&
    response.modelVersion === undefined &&
    finishReason === undefined
  ) {
    return undefined;
  }
  return {
    provider: "gemini",
    ...(response.responseId !== undefined ? { responseId: response.responseId } : {}),
    ...(response.modelVersion !== undefined ? { modelVersion: response.modelVersion } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(thoughtParts.length > 0 ? { geminiThoughtParts: thoughtParts } : {}),
  };
};

const parseStructuredOutput = (
  request: ChatRequest,
  content: string,
): unknown | undefined => {
  if (!request.structuredOutput) {
    return undefined;
  }
  if ((request.structuredOutput.mimeType ?? "application/json") === "text/x.enum") {
    return content.trim();
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new ProviderError("PROVIDER_INVALID_INPUT", "Gemini structured output was not valid JSON", {
      cause: error,
      retryable: true,
    });
  }
};

const parseToolCalls = (parts: GeminiPart[]): ToolCallRequest[] | undefined => {
  const calls: ToolCallRequest[] = [];
  for (const part of parts) {
    const functionCall = part.functionCall;
    if (!functionCall?.name) {
      continue;
    }
    calls.push({
      id: functionCall.id ?? `gemini-call-${calls.length}`,
      name: functionCall.name,
      arguments: functionCall.args ?? {},
      providerMetadata: {
        provider: "gemini",
        gemini: {
          functionCall,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        },
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
};

const embeddingContentToGemini = (input: EmbeddingContent): string | GeminiContent => {
  if (typeof input === "string") {
    return input;
  }
  return { role: "user", parts: toGeminiUserParts(input) };
};

const stringifyEmbeddingContent = (input: EmbeddingContent): string => {
  if (typeof input === "string") {
    return input;
  }
  return input
    .map((part: MessageContentPart) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return `[image:${part.image_url.url}]`;
      return `[file:${part.file.mimeType}:${part.file.name ?? part.file.uri ?? "inline"}]`;
    })
    .join("\n");
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  const len = Math.min(left.length, right.length);
  if (len === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < len; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const inferModelCapabilities = (model: GeminiModel | string): ModelInfo["capabilities"] => {
  const name = typeof model === "string" ? model : (model.name ?? model.displayName ?? "");
  const lowered = normalizeModelName(name).toLowerCase();
  const supportedActions =
    typeof model === "string" ? [] : (model.supportedActions ?? []).map((item) => item.toLowerCase());
  const isEmbedding =
    lowered.includes("embedding") || supportedActions.some((action) => action.includes("embed"));
  const imageOut = lowered.includes("image") || lowered.includes("imagen");
  const audioOut = lowered.includes("audio") || lowered.includes("tts");
  const videoOut = lowered.includes("video") || lowered.includes("veo");
  const chatModel = !isEmbedding;
  return {
    supportedModalities: isEmbedding ? ["text"] : ["text", "image", "audio", "video", "file"],
    ...(chatModel
      ? { supportedOutputModalities: ["text", ...(imageOut ? ["image"] : []), ...(audioOut ? ["audio"] : []), ...(videoOut ? ["video"] : [])] }
      : {}),
    maxContextTokens:
      typeof model === "string" ? (lowered.includes("embedding") ? 8_192 : 1_000_000) : (model.inputTokenLimit ?? 1_000_000),
    supportsStreaming: chatModel,
    supportsFunctionCalling: chatModel,
    supportsStructuredOutput: chatModel,
    supportsEmbeddings: isEmbedding,
    supportsRerank: isEmbedding,
  };
};

const mapModel = (model: GeminiModel): ModelInfo | null => {
  const rawName = model.name ?? model.displayName;
  if (!rawName) {
    return null;
  }
  const modelName = normalizeModelName(rawName);
  return {
    modelName,
    capabilities: inferModelCapabilities(model),
  };
};

const mapProviderError = (error: unknown): ProviderError | TimeoutError => {
  if (error instanceof TimeoutError) {
    return error;
  }
  if (error instanceof ProviderError) {
    return error;
  }
  const candidate = error as {
    status?: number;
    code?: string | number;
    message?: string;
    cause?: { status?: number; code?: string | number; message?: string };
  };
  const status = candidate.status ?? candidate.cause?.status;
  const code = candidate.code ?? candidate.cause?.code;
  const message = candidate.message ?? candidate.cause?.message ?? "Gemini 调用失败";
  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_AUTH_FAILED", message, { cause: error });
  }
  if (status === 400 || status === 404) {
    return new ProviderError("PROVIDER_INVALID_INPUT", message, { cause: error });
  }
  if (status === 429) {
    return new ProviderError("PROVIDER_RATE_LIMITED", message, {
      cause: error,
      retryable: true,
    });
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderError("PROVIDER_UPSTREAM_ERROR", message, {
      cause: error,
      retryable: true,
    });
  }
  if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    return new TimeoutError("TIMEOUT_PROVIDER_REQUEST", message, {
      cause: error,
      retryable: true,
    });
  }
  return new ProviderError("PROVIDER_CALL_FAILED", message, {
    cause: error,
    retryable: true,
  });
};

const buildSdkOptions = (
  options: GeminiProviderOptions,
  apiKey: string | undefined,
  timeoutMs: number,
): Record<string, unknown> => {
  const httpOptions: Record<string, unknown> = { timeout: timeoutMs };
  if (options.baseURL) {
    httpOptions.baseUrl = options.baseURL;
  }
  if (options.apiVersion) {
    httpOptions.apiVersion = options.apiVersion;
  }
  const sdkOptions: Record<string, unknown> = { ...(options.extra ?? {}) };
  if (apiKey) {
    sdkOptions.apiKey = apiKey;
  }
  if (options.vertexai !== undefined) {
    sdkOptions.vertexai = options.vertexai;
  }
  if (options.project) {
    sdkOptions.project = options.project;
  }
  if (options.location) {
    sdkOptions.location = options.location;
  }
  if (options.apiVersion) {
    sdkOptions.apiVersion = options.apiVersion;
  }
  sdkOptions.httpOptions = {
    ...(isRecord(sdkOptions.httpOptions) ? sdkOptions.httpOptions : {}),
    ...httpOptions,
  };
  return sdkOptions;
};

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly name = "Gemini";

  private readonly client: GeminiClientLike;
  private readonly timeoutMs: number;
  private readonly modelListCacheTtlMs: number;
  private modelListCache: { at: number; value: ModelInfo[] } | null = null;

  constructor(options: GeminiProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelListCacheTtlMs = options.modelListCacheTtlMs ?? 60_000;
    if (options.client) {
      this.client = options.client;
      return;
    }

    const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    const hasVertexCredentials = options.vertexai === true && Boolean(options.project && options.location);
    if (!apiKey && !hasVertexCredentials) {
      throw new ProviderError(
        "PROVIDER_MISSING_CREDENTIALS",
        "缺少 GEMINI_API_KEY/GOOGLE_API_KEY 或 Vertex AI project/location",
      );
    }
    this.client = new GoogleGenAI(
      buildSdkOptions(options, apiKey, this.timeoutMs) as never,
    ) as unknown as GeminiClientLike;
  }

  async listAvailableModels(): Promise<ModelInfo[]> {
    const ttl = this.modelListCacheTtlMs;
    if (ttl > 0 && this.modelListCache && Date.now() - this.modelListCache.at < ttl) {
      return this.modelListCache.value;
    }
    try {
      if (!this.client.models.list) {
        return FALLBACK_MODELS;
      }
      const pager = await this.client.models.list();
      const source: GeminiModel[] = [];
      const seen = new Set<string>();
      const addModel = (model: GeminiModel): void => {
        const key = model.name ?? model.displayName;
        if (!key || seen.has(key)) {
          return;
        }
        seen.add(key);
        source.push(model);
      };
      if (Array.isArray((pager as { page?: GeminiModel[] }).page)) {
        for (const model of (pager as { page: GeminiModel[] }).page) {
          addModel(model);
        }
      }
      if (Symbol.asyncIterator in Object(pager)) {
        for await (const model of pager as AsyncIterable<GeminiModel>) {
          addModel(model);
        }
      }
      const result = source
        .map(mapModel)
        .filter((model): model is ModelInfo => model !== null);
      const models = result.length > 0 ? result : FALLBACK_MODELS;
      if (ttl > 0) {
        this.modelListCache = { at: Date.now(), value: models };
      }
      return models;
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  async chat(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const mapped = toGeminiMessages(request.messages);
      const config = buildGenerateConfig(request);
      if (mapped.systemInstruction) {
        config.systemInstruction = mapped.systemInstruction;
      }
      const response = await this.client.models.generateContent({
        model: request.model,
        contents: mapped.contents,
        config: {
          ...config,
          abortSignal: timeout.signal,
        },
      });
      const parts = extractParts(response);
      const content = extractTextFromParts(parts, false);
      const reasoningContent = extractTextFromParts(parts, true);
      const toolCalls = parseToolCalls(parts);
      const rawFinish = response.candidates?.[0]?.finishReason;
      const finishReason = mapGeminiFinishReason(rawFinish, (toolCalls?.length ?? 0) > 0);
      const media = extractMedia(parts, request.model);
      const images = mediaToImages(media);
      const structured = parseStructuredOutput(request, content);
      const providerMetadata = buildResponseMetadata(response, parts, rawFinish);
      return {
        content,
        ...(structured !== undefined ? { structured } : {}),
        ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        finishReason,
        usage: mapUsage(response),
        ...(images.length > 0 ? { images } : {}),
        ...(media.length > 0 ? { media } : {}),
      };
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  async *chatStream(
    request: ChatRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const mapped = toGeminiMessages(request.messages);
      const config = buildGenerateConfig(request);
      if (mapped.systemInstruction) {
        config.systemInstruction = mapped.systemInstruction;
      }
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents: mapped.contents,
        config: {
          ...config,
          abortSignal: timeout.signal,
        },
      });

      let finishReason: ChatFinishReason = "unknown";
      let usage: ChatUsage | undefined;
      let responseMetadata: ProviderMetadata | undefined;
      let sawToolCall = false;

      for await (const chunk of stream) {
        if (timeout.signal.aborted) {
          throw timeout.signal.reason ?? new Error("aborted");
        }
        const parts = extractParts(chunk);
        const text = extractTextFromParts(parts, false);
        const reasoning = extractTextFromParts(parts, true);
        if (reasoning.length > 0) {
          yield { type: "reasoning-delta", delta: reasoning };
        }
        if (text.length > 0) {
          yield { type: "text-delta", delta: text };
          if (request.structuredOutput) {
            yield { type: "structured-delta", delta: text };
          }
        }
        for (const item of extractMedia(parts, request.model)) {
          yield { type: "media", media: item };
        }
        const calls = parseToolCalls(parts);
        if (calls) {
          sawToolCall = true;
          for (const call of calls) {
            yield { type: "tool-call-complete", call };
          }
        }
        const rawFinish = chunk.candidates?.[0]?.finishReason;
        if (rawFinish !== undefined) {
          finishReason = mapGeminiFinishReason(rawFinish, sawToolCall);
        }
        usage = mapUsage(chunk);
        responseMetadata = buildResponseMetadata(chunk, parts, rawFinish) ?? responseMetadata;
      }

      yield {
        type: "finish",
        finishReason: sawToolCall ? "tool_calls" : finishReason,
        ...(usage !== undefined ? { usage } : {}),
        ...(responseMetadata !== undefined ? { providerMetadata: responseMetadata } : {}),
      };
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    if (!this.client.models.countTokens) {
      return messages.reduce((sum, message) => sum + toTextContent(message.content).length, 0);
    }
    const timeout = withAbortTimeout(undefined, this.timeoutMs);
    try {
      const mapped = toGeminiMessages(messages);
      const response = await this.client.models.countTokens({
        model,
        contents: mapped.contents,
        config: {
          ...(mapped.systemInstruction ? { systemInstruction: mapped.systemInstruction } : {}),
          abortSignal: timeout.signal,
        },
      });
      return response.totalTokens ?? 0;
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  async embed(
    request: EmbeddingRequest,
    _ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<EmbeddingResponse> {
    const timeout = withAbortTimeout(signal, this.timeoutMs);
    try {
      const config: Record<string, unknown> = {};
      if (request.taskType !== undefined) {
        config.taskType = request.taskType;
      }
      if (request.outputDimensionality !== undefined) {
        config.outputDimensionality = request.outputDimensionality;
      }
      applyProviderConfig(config, request.providerOptions);
      const response = await this.client.models.embedContent({
        model: request.model,
        contents: request.inputs.map(embeddingContentToGemini),
        config: {
          ...config,
          abortSignal: timeout.signal,
        },
      });
      return {
        embeddings: (response.embeddings ?? []).map((item) => item.values ?? []),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        providerMetadata: {
          provider: "gemini",
          ...(response.metadata ? { metadata: response.metadata } : {}),
        },
      };
    } catch (error) {
      throw mapProviderError(error);
    } finally {
      timeout.cleanup();
    }
  }

  async rerank(
    request: RerankRequest,
    ctx: AdapterCallContext,
    signal?: AbortSignal,
  ): Promise<RerankResponse> {
    const query = await this.embed(
      {
        model: request.model,
        inputs: [request.query],
        taskType: "RETRIEVAL_QUERY",
        providerOptions: request.providerOptions,
      },
      ctx,
      signal,
    );
    const documents = await this.embed(
      {
        model: request.model,
        inputs: request.documents.map((doc) => doc.text),
        taskType: "RETRIEVAL_DOCUMENT",
        providerOptions: request.providerOptions,
      },
      ctx,
      signal,
    );
    const queryVector = query.embeddings[0] ?? [];
    const results = request.documents
      .map((document, index) => ({
        index,
        score: cosineSimilarity(queryVector, documents.embeddings[index] ?? []),
        document,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, request.topK ?? request.documents.length);
    return {
      results,
      usage: {
        promptTokens: (query.usage?.promptTokens ?? 0) + (documents.usage?.promptTokens ?? 0),
        completionTokens: 0,
        totalTokens: (query.usage?.totalTokens ?? 0) + (documents.usage?.totalTokens ?? 0),
      },
      providerMetadata: { provider: "gemini", rerankStrategy: "embedding-cosine" },
    };
  }

  embeddingInputToText(input: EmbeddingContent): string {
    return stringifyEmbeddingContent(input);
  }
}
