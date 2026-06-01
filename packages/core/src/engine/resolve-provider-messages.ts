import type { ProviderAdapter } from "../modules/provider";
import type { ChatRequest, ChatResponse, ChatStreamChunk } from "../modules/provider";
import type { Message } from "../types/message";
import type { MultimodalResolver } from "../types/multimodal-resolver";
import type {
  ResourceDemand,
  ResourceDemandUnit,
  ResourceKind,
} from "../types/resource";
import type { ToolDescriptor } from "../types/descriptor";
import type { AdapterCallContext } from "../types/context";
import type { ObservabilityEmitter } from "../modules/observability";
import { engineEventFromAdapterContext } from "./turn-outcome";
import {
  expandDemandSelector,
  materializeMessages,
  type MaterializeDegradation,
} from "../utils/resource-pool";

export interface ProviderMessageMaterialization {
  messages: Message[];
  degradations: MaterializeDegradation[];
}

/**
 * router 调用上下文。必带路由模型与其能力，避免 required 资源在不支持
 * 的模型上为时已晚才降级。
 */
export interface ResourceDemandContext {
  unit: ResourceDemandUnit;
  phase: string;
  messages: readonly Message[];
  route: { provider: string; model: string };
  supportedKinds?: ReadonlySet<ResourceKind> | undefined;
  candidateTools?: readonly ToolDescriptor[] | undefined;
}

/**
 * host 注入的 token 级需求路由。返回高层 `ResourceDemandSelector`，
 * 由 core 经 `expandDemandSelector` 展开为底层 key-only `ResourceDemand`。
 */
export type ResourceDemandRouter = (
  ctx: ResourceDemandContext,
) =>
  | import("../types/resource").ResourceDemandSelector
  | Promise<import("../types/resource").ResourceDemandSelector>;

/**
 * 把物化降级 surface 为可观测 `degrade` 事件。
 *
 * 流式与非流式共用：`unit` 标注消费单元，便于下游/host 据此分域处理（推理步重试/重路由、
 * 终答续行等）。core 仅 surface，不在此处决定 required 失败的具体动作。
 */
export const emitResourceDegradations = (
  observability: ObservabilityEmitter | undefined,
  ctx: AdapterCallContext,
  unit: ResourceDemandUnit,
  phase: string,
  degradations: readonly MaterializeDegradation[],
): void => {
  if (observability === undefined || degradations.length === 0) {
    return;
  }
  observability.emit(
    engineEventFromAdapterContext(ctx, {
      timestamp: Date.now(),
      phase,
      type: "degrade",
      payload: {
        unit,
        count: degradations.length,
        requiredCount: degradations.filter((d) => d.required).length,
        degradations: degradations.map((d) => ({
          kind: d.kind,
          displayLabel: d.displayLabel,
          reason: d.reason,
          required: d.required,
        })),
      },
    }),
  );
};

/** Provider 能力缓存：按 adapter → (model → 支持的 modality/kind 集合)。 */
const capabilityCache = new WeakMap<
  ProviderAdapter,
  Promise<Map<string, Set<string>>>
>();

export const supportedKindsForModel = async (
  adapter: ProviderAdapter,
  model: string,
): Promise<ReadonlySet<string> | undefined> => {
  let pending = capabilityCache.get(adapter);
  if (pending === undefined) {
    pending = adapter
      .listAvailableModels()
      .then((models) => {
        const map = new Map<string, Set<string>>();
        for (const info of models) {
          map.set(info.modelName, new Set(info.capabilities.supportedModalities));
        }
        return map;
      })
      .catch(() => new Map<string, Set<string>>());
    capabilityCache.set(adapter, pending);
  }
  const map = await pending;
  const modalities = map.get(model);
  if (modalities === undefined) {
    return undefined; // 未知模型：不做能力裁剪，走保真物化
  }
  return new Set<string>(["text", ...modalities]);
};

export const inputContentToMessageContent = (content: unknown): Message["content"] => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content as Message["content"];
  }
  return String(content ?? "");
};

/**
 * 在 Provider 边界把请求消息按需物化。
 *
 * 按路由模型能力做 kind 裁剪；缺省 demand 为 `{ mode: "all" }`（保真）。
 * 缺 resolver 但存在需物化引用 → `materializeMessages` 抛 `HostError`（fail-fast）。
 */
export const materializeProviderMessages = async (
  adapter: ProviderAdapter,
  request: ChatRequest,
  ctx: AdapterCallContext,
  resolver: MultimodalResolver | undefined,
  demand?: ResourceDemand,
): Promise<ProviderMessageMaterialization> => {
  const supportedKinds = await supportedKindsForModel(adapter, request.model);
  return materializeMessages(request.messages, resolver, ctx, {
    ...(demand !== undefined ? { demand } : {}),
    supportedKinds,
  });
};

/**
 * 在 seam 调用前解析 token 级 demand。
 *
 * 未注入 router → 返回 `undefined`，seam 走缺省 `{ mode: "all" }`（全保真、行为不变）。
 * 注入时：补齐路由模型能力 `supportedKinds` → 调 router 取高层 selector → 展开为底层
 * key-only `ResourceDemand`。
 */
export const resolveProviderDemand = async (
  router: ResourceDemandRouter | undefined,
  params: {
    adapter: ProviderAdapter;
    model: string;
    unit: ResourceDemandUnit;
    phase: string;
    messages: readonly Message[];
    candidateTools?: readonly ToolDescriptor[] | undefined;
  },
): Promise<ResourceDemand | undefined> => {
  if (router === undefined) {
    return undefined;
  }
  const supportedKinds = (await supportedKindsForModel(
    params.adapter,
    params.model,
  )) as ReadonlySet<ResourceKind> | undefined;
  const selector = await router({
    unit: params.unit,
    phase: params.phase,
    messages: params.messages,
    route: { provider: params.adapter.id, model: params.model },
    supportedKinds,
    candidateTools: params.candidateTools,
  });
  return expandDemandSelector(selector, params.messages);
};

/**
 * R1：物化后 `Provider.chat`。运行时物化失败按第一层做对话内降级（注入消息），
 * 不再整轮短路；缺 resolver 时由底层抛 `HostError`。
 */
export const chatWithResolvedMessages = async (
  adapter: ProviderAdapter,
  request: ChatRequest,
  ctx: AdapterCallContext,
  resolver: MultimodalResolver | undefined,
  signal?: AbortSignal,
  demand?: ResourceDemand,
): Promise<
  | { ok: true; response: ChatResponse; messages: Message[]; degradations: MaterializeDegradation[] }
  | { ok: false; reason: string; userVisibleReason: string }
> => {
  const { messages, degradations } = await materializeProviderMessages(
    adapter,
    request,
    ctx,
    resolver,
    demand,
  );
  const response = await adapter.chat({ ...request, messages }, ctx, signal);
  return { ok: true, response, messages, degradations };
};

/**
 * R1 流式：物化后 `adapter.chatStream`。
 *
 * 流式不经返回值传递 degradations：物化后、产流前若有降级，经可选
 * `onDegradations` 回调 surface，使流式路径也能观测降级。
 */
export async function* streamChatWithResolvedMessages(
  adapter: ProviderAdapter,
  request: ChatRequest,
  ctx: AdapterCallContext,
  resolver: MultimodalResolver | undefined,
  signal?: AbortSignal,
  demand?: ResourceDemand,
  onDegradations?: (degradations: MaterializeDegradation[]) => void,
): AsyncGenerator<ChatStreamChunk> {
  const { messages, degradations } = await materializeProviderMessages(
    adapter,
    request,
    ctx,
    resolver,
    demand,
  );
  if (degradations.length > 0 && onDegradations !== undefined) {
    onDegradations(degradations);
  }
  yield* adapter.chatStream({ ...request, messages }, ctx, signal);
}
