import type { AdapterCallContext } from "./context";
import type { MessageContentPart } from "./message";
import type { ResourceReference } from "./resource";

/**
 * 单条资源的物化结果。
 *
 * - `ok: true`：宿主成功取到内容，返回可直接拼进 Provider 消息的载体 part
 * （图片为 `Provider Image Carrier`，即 `image_url` part；文本类为 text part）。
 * - `ok: false`：运行时取不到（缺失/鉴权/MIME 等），由 core 做对话内降级（第一层）。
 */
export type ResourceResolveEntry =
  | { ok: true; part: MessageContentPart }
  | { ok: false; reason: string; userVisibleReason: string };

/**
 * Host-injected seam：按 `key` 把不透明的 {@link ResourceReference} 物化为
 * Provider 可消费的载体 part。
 *
 * core 只在 Provider 边界、按「正文 token ∩ 本条 resources ∩ 下游需求 ∩ 模型能力」
 * 选出待物化子集后调用本 seam；返回值按 `ResourceReference.key` 索引。
 * 注意：`data:` / `http(s):` scheme 的图片内联载体由 core 直接拼装，不会进入本 seam。
 */
export interface MultimodalResolver {
  resolveResources(
    refs: readonly ResourceReference[],
    ctx: AdapterCallContext,
  ): Promise<Map<string, ResourceResolveEntry>>;
}
