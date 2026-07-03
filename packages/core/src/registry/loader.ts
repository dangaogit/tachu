import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { ValidationError } from "../errors";
import type {
  Activation,
  AgentDescriptor,
  AnyDescriptor,
  RuleActivation,
  RuleDescriptor,
  SkillDescriptor,
  ToolDescriptor,
} from "../types";
import {
  isSkillDirectoryForm,
  requireValidDescriptorNameFormat,
  warnOnDescriptorIdentityMismatch,
} from "./descriptor-naming";
import { discoverSkillResources } from "./skill-resources";
import type { DescriptorRegistry } from "./registry";

/**
 * agentskills.io 资源子目录名——递归找描述符文件时必须跳过，否则
 * `references/*.md` 这类技能资源会被误当成独立描述符加载（缺 frontmatter
 * 的 name/description 会直接报错，导致技能目录多带一个 references 文档就
 * 炸掉整个加载）。
 */
const SKILL_RESOURCE_DIR_NAMES = new Set(["scripts", "references", "assets"]);

const listMarkdownFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKILL_RESOURCE_DIR_NAMES.has(entry.name)) {
        continue;
      }
      const fullPath = join(root, entry.name);
      files.push(...(await listMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(join(root, entry.name));
    }
  }
  return files;
};

/**
 * 解析并 **fail-closed** 校验激活条件(activation)——四类描述符共用。
 *
 * - 未声明 → `{ mode: defaultMode }`。
 * - `always` / `manual` / `semantic` → 原样返回。
 * - `path` → 必须带非空字符串数组 `globs`,否则报错。
 * - 其它一律报错(旧的 `turnStart`/`preLLM`/`turnStop`/`*` 生命周期式 scope
 *   已废弃;误用会在加载期显式失败,而非静默丢弃)。
 */
const normalizeActivation = (
  raw: unknown,
  name: string,
  where: string,
  defaultMode: Extract<Activation["mode"], "always" | "semantic">,
): Activation => {
  if (raw === undefined || raw === null) {
    return { mode: defaultMode };
  }
  if (typeof raw !== "object") {
    throw ValidationError.invalidConfig(
      `"${name}" (${where}): activation 必须是对象（形如 { mode: "always" }）`,
    );
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "always" || mode === "manual" || mode === "semantic") {
    return { mode };
  }
  if (mode === "path") {
    const globs = (raw as { globs?: unknown }).globs;
    if (
      !Array.isArray(globs) ||
      globs.length === 0 ||
      !globs.every((g): g is string => typeof g === "string" && g.length > 0)
    ) {
      throw ValidationError.invalidConfig(
        `"${name}" (${where}): activation.mode="path" 必须带非空字符串数组 globs`,
      );
    }
    return { mode: "path", globs: [...globs] };
  }
  throw ValidationError.invalidConfig(
    `"${name}" (${where}): 未知 activation.mode "${String(mode)}"（合法值：always/manual/semantic/path）`,
  );
};

/**
 * Rule 激活：未声明默认 `always`（未限定的规则默认总是注入）。
 */
const normalizeRuleActivation = (
  raw: unknown,
  ruleName: string,
  filePath?: string,
): RuleActivation => normalizeActivation(raw, ruleName, filePath ?? "?", "always");

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw ValidationError.invalidConfig(`frontmatter 字段 ${field} 必须是非空字符串`);
  }
  return value;
};

const normalizeSideEffect = (
  raw: unknown,
  descriptorKind: "tool" | "agent",
  descriptorName: string,
  filePath?: string,
): "readonly" | "write" | "irreversible" => {
  if (raw === undefined) {
    return "readonly";
  }
  if (raw === "readonly" || raw === "write" || raw === "irreversible") {
    return raw;
  }
  throw ValidationError.invalidConfig(
    `${descriptorKind} "${descriptorName}" (${filePath ?? "?"}): sideEffect 必须是 readonly/write/irreversible`,
  );
};

const toDescriptor = async (
  data: Record<string, unknown>,
  content: string,
  sourceFile?: string,
): Promise<AnyDescriptor> => {
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const type = typeof data.type === "string" ? data.type : undefined;
  const knownFields = new Set([
    "name",
    "description",
    "version",
    "displayName",
    "deprecated",
    "deprecatedMessage",
    "tags",
    "requires",
    "kind",
    "type",
    "activation",
    "sideEffect",
    "idempotent",
    "requiresApproval",
    "timeout",
    "inputSchema",
    "outputSchema",
    "execute",
    "instructions",
    "resources",
    "maxDepth",
    "availableTools",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);
  const extraFields = Object.fromEntries(
    Object.entries(data).filter(([field]) => !knownFields.has(field)),
  );
  const name = requireString(data.name, "name");
  if (
    kind !== undefined &&
    kind !== "rule" &&
    kind !== "skill" &&
    kind !== "tool" &&
    kind !== "agent"
  ) {
    throw ValidationError.invalidConfig(
      `descriptor "${name}" (${sourceFile ?? "?"}): 未知 kind "${kind}"（合法值：rule/skill/tool/agent）`,
    );
  }
  if (kind === undefined) {
    const signatureKinds: string[] = [];
    if (type === "rule" || type === "preference") signatureKinds.push("rule");
    if ("execute" in data || "inputSchema" in data) signatureKinds.push("tool");
    if ("instructions" in data || "maxDepth" in data) signatureKinds.push("agent");
    if (signatureKinds.length > 1) {
      throw ValidationError.invalidConfig(
        `descriptor "${name}" (${sourceFile ?? "?"}): 无法确定 kind——字段特征同时匹配 ${signatureKinds.join(
          "/",
        )}；请显式声明 kind（rule/skill/tool/agent），避免被静默归类`,
      );
    }
  }
  requireValidDescriptorNameFormat(name, sourceFile);
  const base = {
    ...extraFields,
    name,
    description: requireString(data.description, "description"),
    version: typeof data.version === "string" ? data.version : undefined,
    displayName: typeof data.displayName === "string" ? data.displayName : undefined,
    deprecated: data.deprecated === true,
    deprecatedMessage:
      typeof data.deprecatedMessage === "string" ? data.deprecatedMessage : undefined,
    tags: Array.isArray(data.tags)
      ? data.tags.filter((item): item is string => typeof item === "string")
      : undefined,
    requires: Array.isArray(data.requires)
      ? (data.requires as AnyDescriptor["requires"])
      : undefined,
  };

  if (kind === "rule" || type === "rule" || type === "preference") {
    const descriptor: RuleDescriptor = {
      ...base,
      kind: "rule",
      type: (type === "preference" ? "preference" : "rule") as "rule" | "preference",
      activation: normalizeRuleActivation(data.activation, name, sourceFile),
      content,
    };
    warnOnDescriptorIdentityMismatch("rule", descriptor.name, sourceFile);
    return descriptor;
  }

  if (kind === "tool" || "execute" in data || "inputSchema" in data) {
    const descriptor: ToolDescriptor = {
      ...base,
      kind: "tool",
      sideEffect: normalizeSideEffect(data.sideEffect, "tool", name, sourceFile),
      idempotent: data.idempotent !== false,
      requiresApproval: data.requiresApproval === true,
      timeout: typeof data.timeout === "number" ? data.timeout : 30_000,
      inputSchema:
        data.inputSchema && typeof data.inputSchema === "object"
          ? (data.inputSchema as Record<string, unknown>)
          : {},
      outputSchema:
        data.outputSchema && typeof data.outputSchema === "object"
          ? (data.outputSchema as Record<string, unknown>)
          : undefined,
      execute: requireString(data.execute, "execute"),
    };
    warnOnDescriptorIdentityMismatch("tool", descriptor.name, sourceFile);
    return descriptor;
  }

  if (kind === "agent" || "instructions" in data || "maxDepth" in data) {
    const descriptor: AgentDescriptor = {
      ...base,
      kind: "agent",
      sideEffect: normalizeSideEffect(data.sideEffect, "agent", name, sourceFile),
      idempotent: data.idempotent !== false,
      requiresApproval: data.requiresApproval === true,
      timeout: typeof data.timeout === "number" ? data.timeout : 120_000,
      maxDepth: typeof data.maxDepth === "number" ? data.maxDepth : 1,
      availableTools: Array.isArray(data.availableTools)
        ? data.availableTools.filter((item): item is string => typeof item === "string")
        : undefined,
      instructions: typeof data.instructions === "string" ? data.instructions : content,
    };
    warnOnDescriptorIdentityMismatch("agent", descriptor.name, sourceFile);
    return descriptor;
  }

  const skillName = base.name;
  const sourceDir = sourceFile !== undefined ? dirname(sourceFile) : undefined;
  const resources =
    sourceFile !== undefined && sourceDir !== undefined && isSkillDirectoryForm(sourceFile)
      ? await discoverSkillResources(sourceDir)
      : undefined;
  const descriptor: SkillDescriptor = {
    ...base,
    kind: "skill",
    activation: normalizeActivation(data.activation, skillName, sourceFile ?? skillName, "semantic"),
    instructions: content,
    resources,
    ...(sourceDir !== undefined ? { sourceDir } : {}),
    ...parseSkillFrontmatterExtras(data),
  };
  warnOnDescriptorIdentityMismatch("skill", descriptor.name, sourceFile);
  return descriptor;
};

/**
 * 把 `allowed-tools` 的空格分隔字符串写法切分成 token。
 *
 * 不能用朴素的 `.split(/\s+/)`：agentskills.io / Claude Code 的写法允许模式内部
 * 带空格，如 `Bash(git commit *)`——必须整体保留为一个 token。用
 * `[^\s()]+(\([^)]*\))?` 逐个匹配：先吃一段不含空白/括号的前缀，再可选吃一对
 * 完整括号（括号内允许任意非右括号字符，包含空格）。
 */
const tokenizeAllowedTools = (raw: string): string[] => raw.match(/[^\s()]+(?:\([^)]*\))?/g) ?? [];

/**
 * 解析 agentskills.io 规范的 Skill 可选 frontmatter 超集字段：
 * `license` / `compatibility` / `metadata` / `allowed-tools`。
 *
 * `allowed-tools` 支持规范里的两种写法：空格分隔字符串，或 YAML 列表。
 */
const parseSkillFrontmatterExtras = (
  data: Record<string, unknown>,
): Pick<SkillDescriptor, "license" | "compatibility" | "metadata" | "allowedTools"> => {
  const allowedToolsRaw = data["allowed-tools"];
  const allowedTools =
    typeof allowedToolsRaw === "string"
      ? tokenizeAllowedTools(allowedToolsRaw)
      : Array.isArray(allowedToolsRaw)
        ? allowedToolsRaw.filter((item): item is string => typeof item === "string")
        : undefined;

  const metadataRaw = data.metadata;
  const metadata =
    metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
      ? Object.fromEntries(
          Object.entries(metadataRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;

  return {
    license: typeof data.license === "string" ? data.license : undefined,
    compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
    metadata,
    allowedTools,
  };
};

/**
 * 从目录读取并注册描述符。
 */
export class RegistryLoader {
  constructor(private readonly registry: DescriptorRegistry) {}

 /**
 * 递归扫描目录并加载 Markdown 描述符。
 *
 * @param root 描述符目录
 * @returns 成功注册的描述符列表
 */
  async loadFromDirectory(root: string): Promise<AnyDescriptor[]> {
    const markdownFiles = await listMarkdownFiles(root);
    const loaded: AnyDescriptor[] = [];
    for (const file of markdownFiles) {
      const raw = await readFile(file, "utf8");
      const parsed = matter(raw);
      const descriptor = await toDescriptor(
        parsed.data as Record<string, unknown>,
        parsed.content.trim(),
        file,
      );
      await this.registry.register(descriptor);
      loaded.push(descriptor);
    }
    this.registry.validateDependencies();
    return loaded;
  }

 /**
 * 清空现有注册并重新加载目录。
 *
 * @param root 描述符目录
 * @returns 重载后的描述符列表
 */
  async reload(root: string): Promise<AnyDescriptor[]> {
    await this.registry.clear();
    return this.loadFromDirectory(root);
  }
}

