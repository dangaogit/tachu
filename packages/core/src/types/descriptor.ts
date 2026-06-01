/**
 * 表示可注册实体的显式依赖。
 */
export interface DependencyRef {
  kind: "rule" | "skill" | "tool" | "agent";
  name: string;
}

/**
 * 描述符触发条件。
 */
export type TriggerCondition =
  | { type: "always" }
  | { type: "semantic" }
  | { type: "explicit" };

/**
 * 四类描述符共享的最小公共元信息。
 */
export interface BaseDescriptor {
  name: string;
  description: string;
  version?: string | undefined;
  displayName?: string | undefined;
  deprecated?: boolean | undefined;
  deprecatedMessage?: string | undefined;
  tags?: string[] | undefined;
  trigger?: TriggerCondition | undefined;
  requires?: DependencyRef[] | undefined;
}

/**
 * Rule 的作用阶段。
 */
export type RuleScope =
  | "safety"
  | "intent"
  | "precheck"
  | "planning"
  | "execution"
  | "validation"
  | "output"
  | "*";

/**
 * Rule 描述符。
 */
export interface RuleDescriptor extends BaseDescriptor {
  kind: "rule";
  type: "rule" | "preference";
  scope: RuleScope[];
  content: string;
}

/**
 * Skill 资源声明。
 */
export interface SkillResource {
  path: string;
  type: "script" | "reference" | "asset";
  loadHint?: string | undefined;
}

/**
 * Skill 描述符。
 */
export interface SkillDescriptor extends BaseDescriptor {
  kind: "skill";
  instructions: string;
  resources?: SkillResource[] | undefined;
 /** Loader 写入的 SKILL.md 所在目录（供 read_skill_resource 解析路径）。 */
  sourceDir?: string | undefined;
}

/**
 * 数据来源分类。用于驱动 `normalizeExternalSourceRefs` 的确定性
 * 归一化路径，避免在 evidence 流水线里再做关键词匹配。
 *
 * - `"internal"`（缺省）：工具/智能体仅读取或修改本地工程内的数据，
 * 不引入外部世界事实（例如 read-file / write-file / run-shell 本地任务）。
 * - `"external"`：工具/智能体会从 *engine 外部* 拉取事实，例如 web-fetch、
 * web-search、第三方 API、远程数据库查询等。`external-fact` claims 的
 * `same-source` 凭据必须来自此类记录。
 */
export type DescriptorDataSource = "internal" | "external";

/**
 * Tool 描述符。
 */
export interface ToolDescriptor extends BaseDescriptor {
  kind: "tool";
  sideEffect: "readonly" | "write" | "irreversible";
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  execute: string;
 /**
 * 是否引入外部事实。缺省为 `"internal"`，与历史行为一致；
 * 设为 `"external"` 后，descriptor-driven evidence normalization 会把
 * 关联 tool observation 升级为 `external-source` 记录。
 */
  dataSource?: DescriptorDataSource | undefined;
 /**
 * 工具**执行**消费的资源声明。
 *
 * 语义是「该工具运行时需要哪些 kind 的正文资源 / 是否必需」，**不等于**「推理 LLM
 * 选择调用该工具时需要看到什么」。core **绝不**据此自动裁剪推理 prompt——它仅作为
 * `EngineDependencies.resourceDemandRouter` 的输入参考（`candidateTools`）。未注入
 * router 时本字段不产生任何行为变化。
 */
  consumes?:
    | {
        kinds?: ReadonlySet<import("./resource").ResourceKind> | undefined;
        required?: boolean | undefined;
      }
    | undefined;
}

/**
 * Agent 描述符。
 */
export interface AgentDescriptor extends BaseDescriptor {
  kind: "agent";
  sideEffect: "readonly" | "write" | "irreversible";
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;
  maxDepth: number;
  availableTools?: string[] | undefined;
  instructions: string;
 /** @see ToolDescriptor.dataSource */
  dataSource?: DescriptorDataSource | undefined;
}

/**
 * 统一描述符联合类型。
 */
export type AnyDescriptor =
  | RuleDescriptor
  | SkillDescriptor
  | ToolDescriptor
  | AgentDescriptor;

/**
 * 描述符类型到实际接口的映射。
 */
export interface DescriptorMap {
  rule: RuleDescriptor;
  skill: SkillDescriptor;
  tool: ToolDescriptor;
  agent: AgentDescriptor;
}

/**
 * 最小描述符形状守卫。
 */
export const isBaseDescriptor = (input: unknown): input is BaseDescriptor => {
  if (!input || typeof input !== "object") {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string"
  );
};

/**
 * 将描述符元信息字段拼成用于语义索引的文本。
 *
 * 拼接 name + displayName + description + tags，不做归一化——embedding 模型
 * 自带 tokenization；keyword caller 自行后置归一化。
 * 结构化签名而非 `SkillDescriptor | ToolDescriptor` 联合，便于 rule/agent 复用。
 */
export function descriptorMetadataText(d: {
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
}): string {
  const parts: string[] = [d.name];
  if (d.displayName) parts.push(d.displayName);
  if (d.description) parts.push(d.description);
  if (d.tags && d.tags.length > 0) parts.push(d.tags.join(" "));
  return parts.join(" ");
}

