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
  | { type: "keyword"; keywords: string[] }
  | { type: "semantic"; threshold: number }
  | { type: "explicit" }
  | { type: "custom"; handler: string };

/**
 * 四类描述符共享的最小公共元信息。
 */
export interface BaseDescriptor {
  name: string;
  description: string;
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
}

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

