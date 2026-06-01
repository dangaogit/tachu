import { randomUUID } from "node:crypto";
import { HostError } from "../errors";
import type { AdapterCallContext } from "../types/context";
import type { Message, MessageContentPart } from "../types/message";
import type {
  ResourceDemand,
  ResourceDemandScope,
  ResourceDemandSelector,
  ResourceKind,
  ResourceReference,
} from "../types/resource";
import type { MultimodalResolver } from "../types/multimodal-resolver";
import type { ResourceResolveEntry } from "../types/multimodal-resolver";

/**
 * Reference Placeholder token 文法：`[[ref:<kind>:<key>]]`。
 *
 * - `kind`：仅小写字母，覆盖内置 image/file/video/text。
 * - `key`：core 生成的 UUID（不可猜测、用户不可控）；物化只认它。
 */
const REF_TOKEN_RE =
  /\[\[ref:([a-z]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/g;

/** 生成单条资源的占位 token。 */
export const refToken = (ref: Pick<ResourceReference, "kind" | "key">): string =>
  `[[ref:${ref.kind}:${ref.key}]]`;

const NOUN_BY_KIND: Record<string, string> = {
  image: "Image",
  file: "File",
  video: "Video",
  text: "Text",
};

const labelFor = (kind: ResourceKind, ordinal: number): string => {
  const noun = NOUN_BY_KIND[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return `[${noun} #${ordinal}]`;
};

const isInlineableImageUri = (uri: string): boolean => /^(data:|https?:)/i.test(uri);

interface PartMeta {
  kind: ResourceKind;
  uri: string;
  mimeType?: string | undefined;
  name?: string | undefined;
}

const partToMeta = (part: MessageContentPart): PartMeta | null => {
  if (part.type === "image_url") {
    const url = part.image_url.url?.trim();
    if (!url) {
      return null;
    }
    return { kind: "image", uri: url };
  }
  if (part.type === "file") {
    const mime = part.file.mimeType;
    const uri =
      part.file.uri?.trim() ||
      (part.file.data ? `data:${mime};base64,${part.file.data}` : undefined);
    if (!uri) {
      return null;
    }
    const kind: ResourceKind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : "file";
    return {
      kind,
      uri,
      mimeType: mime,
      ...(part.file.name ? { name: part.file.name } : {}),
    };
  }
  return null;
};

export interface AssembledContent {
  content: Message["content"];
  resources: ResourceReference[];
}

/**
 * 装配：把 `content` 里的重内容 part 抽离为 Resource Pool，正文只保留
 * 文本并在**末尾换行追加**占位 token；显示编号由 core 按 kind + 出现顺序生成。
 *
 * 纯文本 / 字符串 content 原样返回（无资源）。
 */
export const assembleResources = (content: Message["content"]): AssembledContent => {
  if (typeof content === "string") {
    return { content, resources: [] };
  }
  const texts: string[] = [];
  const resources: ResourceReference[] = [];
  const tokens: string[] = [];
  const ordinals = new Map<string, number>();
  for (const part of content) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    const meta = partToMeta(part);
    if (meta === null) {
      continue;
    }
    const ordinal = (ordinals.get(meta.kind) ?? 0) + 1;
    ordinals.set(meta.kind, ordinal);
    const ref: ResourceReference = {
      key: randomUUID(),
      kind: meta.kind,
      uri: meta.uri,
      displayLabel: labelFor(meta.kind, ordinal),
      ...(meta.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
      ...(meta.name !== undefined ? { name: meta.name } : {}),
    };
    resources.push(ref);
    tokens.push(refToken(ref));
  }
  const body = texts.join("\n");
  if (resources.length === 0) {
    return { content: body, resources: [] };
  }
  const tail = tokens.join("\n");
  return { content: body.length > 0 ? `${body}\n${tail}` : tail, resources };
};

/** 解析正文中出现的合法占位 token，返回去重后的 key 顺序列表。 */
export const tokenKeysInContent = (content: Message["content"]): string[] => {  if (typeof content !== "string") {
    return [];
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of content.matchAll(REF_TOKEN_RE)) {
    const key = match[2];
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
};

/**
 * 把正文里的占位 token 渲染为人类可读的 `displayLabel`（intent 等零物化阶段）。
 *
 * 仅替换在本条 `pool` 中存在合法 `key` 的 token；用户手打 / 跨轮粘贴的伪 token 因无
 * 合法 key 原样保留为普通文本。
 */
export const renderTokensToDisplay = (
  content: Message["content"],
  pool: readonly ResourceReference[] | undefined,
): Message["content"] => {
  if (typeof content !== "string") {
    return content;
  }
  const byKey = new Map((pool ?? []).map((r) => [r.key, r]));
  return content.replace(REF_TOKEN_RE, (whole, _kind: string, key: string) => {
    const ref = byKey.get(key);
    return ref ? ref.displayLabel : whole;
  });
};

/**
 * 把 `scope` 限定的消息子集取出。
 *
 * - `current-turn`：从最后一个 `user` 消息起到末尾（当前用户轮次）。
 * - `prompt` / `all`：本次调用的全部消息（seam 处只可见整个 prompt，二者等价）。
 */
const messagesInScope = (
  messages: readonly Message[],
  scope: ResourceDemandScope,
): readonly Message[] => {
  if (scope !== "current-turn") {
    return messages;
  }
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      start = i;
      break;
    }
  }
  return messages.slice(start);
};

/**
 * 把高层 {@link ResourceDemandSelector} 展开为底层 key-only {@link ResourceDemand}。
 *
 * - `all` → `{ mode: "all" }`；`none` → `{ mode: "keys", keys: ∅ }`。
 * - `select` → 在 `scope`（默认 `current-turn`）限定的消息内，对每条消息求
 * `正文 token 中的 key ∩ 本条 pool ∩ (kinds 命中 ∪ 显式 keys)`；`kinds`/`keys` 皆省略
 * 时选中作用域内全部被引用资源。`required` 与选中结果取交后透传。
 *
 * 不变式：返回的 `keys` 恒是「正文 token ∩ pool」的子集——**绝不**包含池中未被正文
 * 引用的资源，也绝不"池中全部该 kind"。
 */
export const expandDemandSelector = (
  selector: ResourceDemandSelector,
  messages: readonly Message[],
): ResourceDemand => {
  if (selector.mode === "all") {
    return { mode: "all" };
  }
  if (selector.mode === "none") {
    return { mode: "keys", keys: new Set<string>() };
  }
  const scope = selector.scope ?? "current-turn";
  const wantKinds = selector.kinds;
  const wantKeys = selector.keys;
  const hasFilter = wantKinds !== undefined || wantKeys !== undefined;
  const keys = new Set<string>();
  for (const message of messagesInScope(messages, scope)) {
    const pool = message.resources;
    if (pool === undefined || pool.length === 0) {
      continue;
    }
    const byKey = new Map(pool.map((r) => [r.key, r]));
    for (const key of tokenKeysInContent(message.content)) {
      const ref = byKey.get(key);
      if (ref === undefined) {
        continue; // token∩pool：伪 token / 不在本条池
      }
      const kindMatch = wantKinds !== undefined && wantKinds.has(ref.kind);
      const keyMatch = wantKeys !== undefined && wantKeys.has(key);
      if (!hasFilter || kindMatch || keyMatch) {
        keys.add(key);
      }
    }
  }
  if (selector.required !== undefined && selector.required.size > 0) {
    const required = new Set<string>();
    for (const key of selector.required) {
      if (keys.has(key)) {
        required.add(key);
      }
    }
    if (required.size > 0) {
      return { mode: "keys", keys, required };
    }
  }
  return { mode: "keys", keys };
};

export interface MaterializeOptions {
 /** 下游 token 级需求；缺省为 `{ mode: "all" }`（物化保真）。 */
  demand?: ResourceDemand | undefined;
 /** 路由模型支持的 kind 集合；`undefined` 视为全部支持（不做能力裁剪）。 */
  supportedKinds?: ReadonlySet<string> | undefined;
}

export interface MaterializeDegradation {
  key: string;
  kind: ResourceKind;
  displayLabel: string;
  reason: string;
  userVisibleReason: string;
  required: boolean;
}

export interface MaterializeResult {
  messages: Message[];
  degradations: MaterializeDegradation[];
}

interface SelectedRef {
  ref: ResourceReference;
  required: boolean;
}

const selectRefs = (message: Message, demand: ResourceDemand): SelectedRef[] => {
  const pool = message.resources;
  if (pool === undefined || pool.length === 0) {
    return [];
  }
  const bodyKeys = new Set(tokenKeysInContent(message.content));
  if (bodyKeys.size === 0) {
    return [];
  }
  const byKey = new Map(pool.map((r) => [r.key, r]));
  const selected: SelectedRef[] = [];
 // 保持正文 token 出现顺序。
  for (const key of bodyKeys) {
    const ref = byKey.get(key);
    if (ref === undefined) {
      continue; // token∩pool：正文有 token 但池里没有合法 key → 跳过（伪 token）
    }
    if (demand.mode === "keys" && !demand.keys.has(key)) {
      continue;
    }
    const required = demand.mode === "keys" && (demand.required?.has(key) ?? false);
    selected.push({ ref, required });
  }
  return selected;
};

const REFS_BLOCK_HEADER = "\n\n--- References ---";

/**
 * Reference Materialization。
 *
 * 对每条消息按「正文 token ∩ 本条 resources ∩ demand ∩ supportedKinds」选出待物化资源，
 * 正文 token **原位保留**，在消息末尾追加统一的 refs 块逐条绑定 `token → 载体`：图片用
 * Provider Image Carrier（`image_url`），文本类用 text。
 *
 * 降级：
 * - 运行时取不到 / 能力不匹配 → 该条以「[unavailable: …]」降级说明替代载体，其余照常（部分降级）。
 * - host 未注册 resolver 但存在需 resolver 物化的引用 → 抛 `HostError`（集成缺陷 fail-fast）。
 */
export const materializeMessages = async (
  messages: readonly Message[],
  resolver: MultimodalResolver | undefined,
  ctx: AdapterCallContext,
  options?: MaterializeOptions,
): Promise<MaterializeResult> => {
  const demand: ResourceDemand = options?.demand ?? { mode: "all" };
  const supportedKinds = options?.supportedKinds;

  const perMessage = messages.map((m) => selectRefs(m, demand));
  const needsResolver: ResourceReference[] = [];
  const seenResolverKeys = new Set<string>();
  for (const selected of perMessage) {
    for (const { ref } of selected) {
      const capable = supportedKinds === undefined || supportedKinds.has(ref.kind);
      if (!capable) {
        continue;
      }
      const inlineImage = ref.kind === "image" && isInlineableImageUri(ref.uri);
      if (!inlineImage && !seenResolverKeys.has(ref.key)) {
        seenResolverKeys.add(ref.key);
        needsResolver.push(ref);
      }
    }
  }

  if (needsResolver.length > 0 && resolver === undefined) {
    throw new HostError(
      "INTEGRATION_MULTIMODAL_RESOLVER_MISSING",
      "MultimodalResolver is required to materialize non-inline resource references",
      { context: { refCount: needsResolver.length } },
    );
  }

  const resolved: Map<string, ResourceResolveEntry> =
    needsResolver.length > 0 && resolver !== undefined
      ? await resolver.resolveResources(needsResolver, ctx)
      : new Map<string, ResourceResolveEntry>();

  const degradations: MaterializeDegradation[] = [];
  const out: Message[] = [];

  messages.forEach((message, idx) => {
    const selected = perMessage[idx] ?? [];
    if (selected.length === 0 || typeof message.content !== "string") {
      out.push(message);
      return;
    }
    const parts: MessageContentPart[] = [
      { type: "text", text: `${message.content}${REFS_BLOCK_HEADER}` },
    ];
    for (const { ref, required } of selected) {
      const header = `\n${ref.displayLabel} (${refToken(ref)}):`;
      const capable = supportedKinds === undefined || supportedKinds.has(ref.kind);
      if (!capable) {
        const reason = `model does not support resource kind "${ref.kind}"`;
        const userVisibleReason = `（${ref.displayLabel} 无法处理：当前模型不支持该类型）`;
        degradations.push({
          key: ref.key,
          kind: ref.kind,
          displayLabel: ref.displayLabel,
          reason,
          userVisibleReason,
          required,
        });
        parts.push({ type: "text", text: `${header} [unavailable: ${reason}]` });
        continue;
      }
      if (ref.kind === "image" && isInlineableImageUri(ref.uri)) {
        parts.push({ type: "text", text: header });
        parts.push({ type: "image_url", image_url: { url: ref.uri } });
        continue;
      }
      const entry = resolved.get(ref.key);
      if (entry === undefined || entry.ok !== true) {
        const reason = entry?.reason ?? "resource could not be resolved";
        const userVisibleReason =
          entry?.userVisibleReason ?? `（${ref.displayLabel} 暂时无法获取）`;
        degradations.push({
          key: ref.key,
          kind: ref.kind,
          displayLabel: ref.displayLabel,
          reason,
          userVisibleReason,
          required,
        });
        parts.push({ type: "text", text: `${header} [unavailable: ${reason}]` });
        continue;
      }
      parts.push({ type: "text", text: header });
      parts.push(entry.part);
    }
    out.push({ ...message, content: parts });
  });

  return { messages: out, degradations };
};
