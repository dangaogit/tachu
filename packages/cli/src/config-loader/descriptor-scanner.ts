import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import {
  DescriptorRegistry,
  InMemoryVectorStore,
  type AnyDescriptor,
  type RuleDescriptor,
  type ToolDescriptor,
  type AgentDescriptor,
  type SkillDescriptor,
} from "@tachu/core";
import { BUILTIN_RULE_DESCRIPTOR_PATHS, toolDescriptors } from "@tachu/extensions";
import { DescriptorScanError } from "../errors";

/**
 * init 会在每个子目录写入一个占位 README.md 与 sessions 目录下的 .gitkeep；
 * 这些文件不包含 YAML front-matter，必须在扫描阶段直接排除，否则每次启动都会打印
 * "跳过无效描述符文件" 噪声 warning（见 D1-LOW-16）。
 */
const SCAFFOLDING_FILE_NAMES = new Set(["readme.md", ".gitkeep"]);

/**
 * 递归列举目录下所有 .md 文件。
 */
async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".md") &&
      !SCAFFOLDING_FILE_NAMES.has(entry.name.toLowerCase())
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * 将 gray-matter 解析结果转换为 AnyDescriptor。
 */
function parseDescriptor(data: Record<string, unknown>, content: string): AnyDescriptor | null {
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const type = typeof data.type === "string" ? data.type : undefined;

  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : null;
  const description = typeof data.description === "string" && data.description.length > 0
    ? data.description
    : null;
  if (!name || !description) {
    return null;
  }

  const base = {
    name,
    description,
    tags: Array.isArray(data.tags)
      ? data.tags.filter((t): t is string => typeof t === "string")
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
      type: type === "preference" ? "preference" : "rule",
      scope: Array.isArray(data.scope)
        ? data.scope.filter((s): s is RuleDescriptor["scope"][number] => typeof s === "string")
        : ["*"],
      content,
    };
    return descriptor;
  }

  if (kind === "tool" || "execute" in data || "inputSchema" in data) {
    const execute = typeof data.execute === "string" ? data.execute : name;
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
      execute,
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
        ? data.availableTools.filter((t): t is string => typeof t === "string")
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
}

/**
 * 扫描 .tachu/ 目录并返回已注册的 DescriptorRegistry。
 *
 * 扫描顺序：
 * 1. .tachu/rules/** /*.md -> RuleDescriptor
 * 2. .tachu/skills/** /SKILL.md -> SkillDescriptor
 * 3. .tachu/tools/** /*.md -> ToolDescriptor
 * 4. .tachu/agents/** /*.md -> AgentDescriptor
 * 5. extensions 内置 rules 和 tools（默认挂载）
 *
 * 优先级：**用户优先**。
 * - 已有用户定义，再来内置（同名）：内置静默跳过，用户定义保留
 * - 已有内置，再来用户定义（同名）：用户覆盖内置，静默（这是预期行为）
 * - 同类冲突（用户-用户 / 内置-内置）：打印 warning 并后覆盖前
 *
 * @param tachyRoot .tachu/ 目录绝对路径
 * @param mountBuiltins 是否挂载 extensions 内置描述符（默认 true）
 * @returns 已填充的 DescriptorRegistry
 */
export async function scanDescriptors(
  tachyRoot: string,
  mountBuiltins = true,
): Promise<DescriptorRegistry> {
  const vectorStore = new InMemoryVectorStore({ indexLimit: 10_000 });
  const registry = new DescriptorRegistry(vectorStore);

  // seen: kind:name -> source（用于去重 / 冲突判断）
  // 约定：`builtin:` 前缀代表内置；其余视为用户定义（一般是绝对路径）。
  const seen = new Map<string, string>();
  const isBuiltinSource = (s: string): boolean => s.startsWith("builtin:");

  const registerOne = async (descriptor: AnyDescriptor, source: string): Promise<void> => {
    const key = `${descriptor.kind}:${descriptor.name}`;
    const existing = seen.get(key);
    if (existing) {
      const newIsBuiltin = isBuiltinSource(source);
      const existingIsBuiltin = isBuiltinSource(existing);
      if (newIsBuiltin && !existingIsBuiltin) {
        // 用户优先：保留用户定义，静默跳过内置
        return;
      }
      if (!newIsBuiltin && existingIsBuiltin) {
        // 用户覆盖内置：预期行为，静默
        await registry.unregister(
          descriptor.kind as Parameters<typeof registry.unregister>[0],
          descriptor.name,
        );
      } else {
        // 同类冲突：打印 warning，后覆盖前
        console.warn(
          `[tachu] 描述符重名 "${descriptor.name}"（${descriptor.kind}），来源 ${source} 覆盖 ${existing}`,
        );
        await registry.unregister(
          descriptor.kind as Parameters<typeof registry.unregister>[0],
          descriptor.name,
        );
      }
    }
    seen.set(key, source);
    await registry.register(descriptor);
  };

  const subDirs = ["rules", "skills", "tools", "agents"];

  for (const sub of subDirs) {
    const dir = join(tachyRoot, sub);
    if (!existsSync(dir)) {
      continue;
    }
    try {
      const files = await listMarkdownFiles(dir);
      for (const file of files) {
        try {
          const raw = await readFile(file, "utf8");
          const parsed = matter(raw);
          const descriptor = parseDescriptor(
            parsed.data as Record<string, unknown>,
            parsed.content.trim(),
          );
          if (descriptor) {
            await registerOne(descriptor, file);
          } else {
            console.warn(`[tachu] 跳过无效描述符文件：${file}`);
          }
        } catch (err) {
          console.warn(`[tachu] 解析描述符文件出错 ${file}：${err}`);
        }
      }
    } catch (err) {
      throw new DescriptorScanError(`扫描目录失败：${dir}`, err);
    }
  }

  if (mountBuiltins) {
    // 挂载 extensions 内置 rules（通过路径找到目录，扫描其 .md 文件）
    const firstBuiltinPath = Object.values(BUILTIN_RULE_DESCRIPTOR_PATHS)[0];
    if (firstBuiltinPath) {
      const builtinRulesDir = dirname(firstBuiltinPath);
      try {
        const files = await listMarkdownFiles(builtinRulesDir);
        for (const file of files) {
          try {
            const raw = await readFile(file, "utf8");
            const parsed = matter(raw);
            const descriptor = parseDescriptor(
              parsed.data as Record<string, unknown>,
              parsed.content.trim(),
            );
            if (descriptor) {
              await registerOne(descriptor, `builtin:rules`);
            }
          } catch {
            // 忽略单个内置 rule 解析失败
          }
        }
      } catch (err) {
        console.warn(`[tachu] 加载内置 rules 失败：${err}`);
      }
    }

    // 挂载 extensions 内置 tools
    for (const toolDescriptor of toolDescriptors) {
      await registerOne(toolDescriptor, "builtin:tools");
    }
  }

  return registry;
}
