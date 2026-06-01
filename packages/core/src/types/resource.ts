/**
 * 资源引用模型
 *
 * 重内容（image/file/video/大文本…）一律抽离为 {@link ResourceReference}，
 * 经旁路 **Resource Pool**（挂在 {@link InputEnvelope.resources} 与同条目
 * `MemoryEntry.resources`）承载；消息正文只保留不透明的 **Reference Placeholder**
 * token（形如 `[[ref:image:<key>]]`，`key` 不可猜测、用户不可控）。
 */

/**
 * 资源种类。`image` / `file` / `video` / `text` 为内置；允许宿主扩展其它字符串。
 *
 * 注意：只有匹配 token 文法 `[a-z]+` 的 kind 才会生成可被回查的占位 token。
 */
export type ResourceKind = "image" | "file" | "video" | "text" | (string & {});

/**
 * 单条资源引用。
 *
 * - `key`：core 生成的不可猜测标识（128-bit），占位 token 内嵌之、物化时按它回查。
 * - `uri`：opaque 宿主标识（可能是 `data:` / `http(s):` 内联载体，或宿主文件 id）；
 * core 不解释其语义，亦不引入 `fileId` 领域词。
 * - `displayLabel`：core 按 kind + 出现顺序生成的人类可读编号（`[Image #1]`），
 * 仅用于展示/尾部 refs 块绑定，**绝不**作为物化匹配依据。
 */
export interface ResourceReference {
  key: string;
  kind: ResourceKind;
  uri: string;
  mimeType?: string | undefined;
  size?: number | undefined;
  name?: string | undefined;
  displayLabel: string;
}

/**
 * 下游单元（一次模型调用 / 一次工具调用 / 一个 sub-task）对资源的 token 级需求。
 *
 * - `{ mode: "all" }`：未指定去向时的默认——物化保真，尽量展开当前消息引用到的全部资源，
 * 兜底 LLM 误判。
 * - `{ mode: "keys"; keys; required? }`：仅展开 `keys` 子集；`required` 子集若物化失败，
 * 应由调用方以**可重试错误**失败该步（第二层），而非静默丢内容。
 */
export type ResourceDemand =
  | { mode: "all" }
  | {
      mode: "keys";
      keys: ReadonlySet<string>;
      required?: ReadonlySet<string> | undefined;
    };

/**
 * 消费该次物化的下游单元。区分**推理/函数调用**（tool-use）、
 * 直答（direct-answer）与终答合成（candidate-answer），用于 degradation 分域处理。
 */
export type ResourceDemandUnit =
  | "direct-answer"
  | "tool-use"
  | "candidate-answer";

/**
 * kind→key 展开的消息作用域。
 *
 * - `current-turn`（默认）：仅当前（最后一个 `user`）轮次起的消息引用到的资源。
 * - `prompt`：本次 LLM 调用 request 中的全部消息。
 * - `all`：语义上含历史/memory；在 Provider 边界 seam 处其可见范围即整个 prompt，
 * 故当前与 `prompt` 等价，保留以备未来跨 prompt 的池级展开。
 */
export type ResourceDemandScope = "current-turn" | "prompt" | "all";

/**
 * 高层 Resource Demand 选择器。
 *
 * host 经 `EngineDependencies.resourceDemandRouter` 产出本类型；core 在 Provider 边界
 * seam **调用前**经 `expandDemandSelector` 展开为底层 key-only {@link ResourceDemand}。
 * 底层 materializer 始终只认 key，kind/scope 等高层意图仅存在于本类型。
 *
 * - `{ mode: "all" }`：全保真（与缺省一致）。
 * - `{ mode: "none" }`：不物化任何资源——不调 resolver、不为未物化 ref 记降级，
 * 正文 token 原位保留、展示渲染不变。
 * - `{ mode: "select"; ... }`：在 `scope` 限定的消息内，按 `kinds`/`keys` 求
 * `正文 token ∩ pool ∩ (kinds ∪ keys)`；两者皆省略时选中作用域内全部被引用资源。
 * `required` 子集（与选中结果取交）若物化失败，应由调用方按单元分域处理。
 */
export type ResourceDemandSelector =
  | { mode: "all" }
  | { mode: "none" }
  | {
      mode: "select";
      scope?: ResourceDemandScope | undefined;
      kinds?: ReadonlySet<ResourceKind> | undefined;
      keys?: ReadonlySet<string> | undefined;
      required?: ReadonlySet<string> | undefined;
    };
