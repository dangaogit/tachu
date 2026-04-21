import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { ValidationError } from "../errors";
import type {
  AgentDescriptor,
  AnyDescriptor,
  RuleDescriptor,
  SkillDescriptor,
  ToolDescriptor,
} from "../types";
import type { DescriptorRegistry } from "./registry";

const listMarkdownFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw ValidationError.invalidConfig(`frontmatter 字段 ${field} 必须是非空字符串`);
  }
  return value;
};

const toDescriptor = (data: Record<string, unknown>, content: string): AnyDescriptor => {
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const type = typeof data.type === "string" ? data.type : undefined;
  const base = {
    name: requireString(data.name, "name"),
    description: requireString(data.description, "description"),
    tags: Array.isArray(data.tags)
      ? data.tags.filter((item): item is string => typeof item === "string")
      : undefined,
    trigger:
      data.trigger && typeof data.trigger === "object"
        ? (data.trigger as AnyDescriptor["trigger"])
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
      scope: Array.isArray(data.scope)
        ? data.scope.filter((item): item is RuleDescriptor["scope"][number] => typeof item === "string")
        : ["*"],
      content,
    };
    return descriptor;
  }

  if (kind === "tool" || "execute" in data || "inputSchema" in data) {
    const descriptor: ToolDescriptor = {
      ...base,
      kind: "tool",
      sideEffect:
        data.sideEffect === "write" || data.sideEffect === "irreversible"
          ? data.sideEffect
          : "readonly",
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
    return descriptor;
  }

  if (kind === "agent" || "instructions" in data || "maxDepth" in data) {
    const descriptor: AgentDescriptor = {
      ...base,
      kind: "agent",
      sideEffect:
        data.sideEffect === "write" || data.sideEffect === "irreversible"
          ? data.sideEffect
          : "readonly",
      idempotent: data.idempotent !== false,
      requiresApproval: data.requiresApproval === true,
      timeout: typeof data.timeout === "number" ? data.timeout : 120_000,
      maxDepth: typeof data.maxDepth === "number" ? data.maxDepth : 1,
      availableTools: Array.isArray(data.availableTools)
        ? data.availableTools.filter((item): item is string => typeof item === "string")
        : undefined,
      instructions: typeof data.instructions === "string" ? data.instructions : content,
    };
    return descriptor;
  }

  const descriptor: SkillDescriptor = {
    ...base,
    kind: "skill",
    instructions: content,
    resources: Array.isArray(data.resources)
      ? (data.resources as SkillDescriptor["resources"])
      : undefined,
  };
  return descriptor;
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
      const descriptor = toDescriptor(parsed.data as Record<string, unknown>, parsed.content.trim());
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

