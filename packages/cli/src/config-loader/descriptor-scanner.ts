import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import {
  DescriptorRegistry,
  discoverSkillResources,
  isSkillDirectoryForm,
  requireValidDescriptorNameFormat,
  warnOnDescriptorIdentityMismatch,
  type AnyDescriptor,
  type RuleActivation,
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
 * "跳过无效描述符文件" 噪声 warning（见 ）。
 */
const SCAFFOLDING_FILE_NAMES = new Set(["readme.md", ".gitkeep"]);

/**
 * 技能资源子目录名——递归找描述符文件时必须跳过，否则 `references/*.md`
 * 这类技能资源文件会被误当成候选描述符扫描到：因为没有 name/description，
 * 解析后会被判定为"无效描述符"，每次启动都打印一条误导性的
 * "跳过无效描述符文件" 噪声 warning。与
 * `packages/core/src/registry/loader.ts` 的 `SKILL_RESOURCE_DIR_NAMES` 保持一致。
 */
const SKILL_RESOURCE_DIR_NAMES = new Set(["scripts", "references", "assets"]);

/**
 * 递归列举目录下所有 .md 文件。
 */
async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKILL_RESOURCE_DIR_NAMES.has(entry.name)) {
      continue;
    }
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

type DescriptorKind = "rule" | "skill" | "tool" | "agent";

/**
 * 与 parseDescriptor 内部四类分支条件保持一致，仅用于在分支前先确定 kind，
 * 以便统一做 name 格式校验 / identity 一致性提示。
 */
function resolveDescriptorKind(data: Record<string, unknown>): DescriptorKind {
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const type = typeof data.type === "string" ? data.type : undefined;
  if (kind === "rule" || type === "rule" || type === "preference") {
    return "rule";
  }
  if (kind === "tool" || "execute" in data || "inputSchema" in data) {
    return "tool";
  }
  if (kind === "agent" || "instructions" in data || "maxDepth" in data) {
    return "agent";
  }
  return "skill";
}

function parseRuleActivation(raw: unknown): RuleActivation {
  if (!raw || typeof raw !== "object") {
    return { mode: "always" };
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "always" || mode === "manual" || mode === "semantic") {
    return { mode };
  }
  if (mode === "path") {
    const globs = (raw as { globs?: unknown }).globs;
    if (
      Array.isArray(globs) &&
      globs.length > 0 &&
      globs.every((glob): glob is string => typeof glob === "string" && glob.length > 0)
    ) {
      return { mode: "path", globs: [...globs] };
    }
  }
  return { mode: "always" };
}

/**
 * 解析 `allowed-tools` frontmatter 字段。值可能是：
 * - 空格分隔的字符串（模式内部可能带括号内的空格，如 `run-shell(python3 *)`，
 *   按括号深度分词，不能简单按空白切分）
 * - YAML 字符串数组
 *
 * 两者都不存在（或结果为空）时返回 undefined，不设置该字段。
 */
function parseAllowedTools(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const filtered = raw.filter((item): item is string => typeof item === "string");
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof raw === "string") {
    const tokens: string[] = [];
    let current = "";
    let depth = 0;
    for (const ch of raw) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (/\s/.test(ch) && depth === 0) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += ch;
    }
    if (current.length > 0) {
      tokens.push(current);
    }
    return tokens.length > 0 ? tokens : undefined;
  }
  return undefined;
}

/**
 * 解析 `metadata` frontmatter 字段，过滤掉非字符串 value。
 */
function parseMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => typeof value === "string",
  ) as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * 将 gray-matter 解析结果转换为 AnyDescriptor。
 *
 * `sourceFile` 是描述符文件的绝对路径，用于：
 * - name 格式硬校验（`requireValidDescriptorNameFormat`，不合规抛 `ValidationError`）
 * - name 与目录名/文件名一致性软提示（`warnOnDescriptorIdentityMismatch`，只 warn）
 * - skill 分支判断是否为 `SKILL.md` 目录形态（`isSkillDirectoryForm`），
 *   若是则扫描同目录下的 `scripts/` `references/` `assets/` 生成 `resources`；
 *   扁平命名的技能文件（如 `foo.md`）不做目录扫描——那样会扫到 `.tachu/skills/`
 *   这个所有技能共享的父目录，语义是错的。
 */
async function parseDescriptor(
  data: Record<string, unknown>,
  content: string,
  sourceFile: string,
): Promise<AnyDescriptor | null> {
  const name = typeof data.name === "string" && data.name.length > 0 ? data.name : null;
  const description = typeof data.description === "string" && data.description.length > 0
    ? data.description
    : null;
  if (!name || !description) {
    return null;
  }

  const resolvedKind = resolveDescriptorKind(data);
  requireValidDescriptorNameFormat(name, sourceFile);
  warnOnDescriptorIdentityMismatch(resolvedKind, name, sourceFile);

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

  if (resolvedKind === "rule") {
    const type = typeof data.type === "string" ? data.type : undefined;
    const descriptor: RuleDescriptor = {
      ...base,
      kind: "rule",
      type: type === "preference" ? "preference" : "rule",
      activation: parseRuleActivation(data.activation),
      content,
    };
    return descriptor;
  }

  if (resolvedKind === "tool") {
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

  if (resolvedKind === "agent") {
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

  const resources = isSkillDirectoryForm(sourceFile)
    ? await discoverSkillResources(dirname(sourceFile))
    : undefined;

  const descriptor: SkillDescriptor = {
    ...base,
    kind: "skill",
    instructions: content,
    resources,
    license: typeof data.license === "string" ? data.license : undefined,
    compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
    metadata: parseMetadata(data.metadata),
    allowedTools: parseAllowedTools(data["allowed-tools"]),
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
  const registry = new DescriptorRegistry();

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
          const descriptor = await parseDescriptor(
            parsed.data as Record<string, unknown>,
            parsed.content.trim(),
            file,
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
            const descriptor = await parseDescriptor(
              parsed.data as Record<string, unknown>,
              parsed.content.trim(),
              file,
            );
            if (descriptor) {
              await registerOne(descriptor, `builtin:rules`);
            } else {
              console.warn(`[tachu] 跳过无效内置描述符文件：${file}`);
            }
          } catch (err) {
 // 内置描述符校验失败（如 name 格式不合法）只 warn 并跳过该条：
 // 内置描述符不受用户控制，不应因为单条历史遗留问题让整个启动流程崩溃，
 // 也不应吞掉用户描述符的加载（用户目录的扫描在此之前已经独立完成）。
            console.warn(`[tachu] 跳过无效内置描述符文件 ${file}：${err}`);
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
