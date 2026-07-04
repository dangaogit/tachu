import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ObservabilityEmitter } from "../../modules/observability";
import type { SessionManager } from "../../modules/session";
import type { Registry } from "../../registry";
import type { AdapterCallContext, SkillDescriptor, ToolDefinition } from "../../types";
import type { StickyManager } from "../skill-activation/sticky";
import { engineEventFromAdapterContext } from "../turn-outcome";

export const INTERNAL_TOOL_NAMES = ["load_skill", "read_skill_resource"] as const;
export const OPTIONAL_INTERNAL_TOOL_NAMES = ["search_skills"] as const;

export type InternalToolName = (typeof INTERNAL_TOOL_NAMES)[number];

export const isInternalToolName = (name: string): name is InternalToolName =>
  (INTERNAL_TOOL_NAMES as readonly string[]).includes(name);

export const getInternalToolDefinitions = (): ToolDefinition[] => [
  {
    name: "load_skill",
    description:
      "Load a skill by name into the active session context. Returns the skill instructions and persists it as sticky for this session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
  {
    name: "read_skill_resource",
    description:
      "Read a resource file bundled with a skill (discovered under the skill's scripts/, references/, or assets/ directory). Returns text only; does not execute scripts.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
        path: { type: "string", description: "Resource path relative to skill directory" },
      },
      required: ["name", "path"],
    },
  },
];

export const getSearchSkillsToolDefinition = (): ToolDefinition => ({
  name: "search_skills",
  description: "Search available skills by query and return top metadata matches.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      topK: { type: "number", description: "Maximum number of results" },
    },
    required: ["query"],
  },
});

export interface InternalToolContext {
  registry: Registry;
  sessionManager: SessionManager;
  stickyManager: StickyManager;
  observability: ObservabilityEmitter;
  adapterContext: AdapterCallContext;
  searchSkills?: (query: string, topK?: number) => Promise<Array<{ name: string; score: number; description: string }>>;
 /**
  * 宿主提供的按需技能正文解析入口（来自 `SessionScope.skillDiscovery.load`）。
  * `load_skill` / `read_skill_resource` 在进程 `registry` 未命中某技能时回落到它，
  * 使 registry 之外（如宿主「我的技能」）的技能也能取回正文/资源。缺省时行为不变。
  */
  loadSkill?: (name: string) => Promise<SkillDescriptor | null>;
}

/** 先查进程 registry，未命中再回落宿主 `loadSkill`（discovery.load）。 */
const resolveSkill = async (
  ctx: InternalToolContext,
  name: string,
): Promise<SkillDescriptor | null> => {
  const fromRegistry = ctx.registry.get("skill", name);
  if (fromRegistry) {
    return fromRegistry;
  }
  if (ctx.loadSkill) {
    return ctx.loadSkill(name);
  }
  return null;
};

const resolveSkillResourcePath = (
  skill: SkillDescriptor,
  resourcePath: string,
): { ok: true; fullPath: string } | { ok: false; error: string } => {
  const allowed = (skill.resources ?? []).some((resource) => resource.path === resourcePath);
  if (!allowed) {
    return {
      ok: false,
      error: `path "${resourcePath}" is not in skill "${skill.name}" resources whitelist`,
    };
  }
  if (!skill.sourceDir) {
    return {
      ok: false,
      error: `skill "${skill.name}" has no sourceDir; cannot resolve resource path`,
    };
  }
  const skillDir = resolve(skill.sourceDir);
  const fullPath = resolve(skillDir, resourcePath);
  if (!fullPath.startsWith(skillDir)) {
    return { ok: false, error: "path traversal denied" };
  }
  return { ok: true, fullPath };
};

export const executeInternalTool = async (
  toolName: InternalToolName | "search_skills",
  args: Record<string, unknown>,
  ctx: InternalToolContext,
): Promise<Record<string, unknown>> => {
  if (toolName === "load_skill") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return { ok: false, error: "name is required" };
    }
    const skill = await resolveSkill(ctx, name);
    if (!skill) {
      return { ok: false, error: `skill "${name}" not found` };
    }
    const sessionId = ctx.adapterContext.correlation.sessionId;
    const currentTurn = await ctx.sessionManager.getCurrentTurn(sessionId);
    const markResult = await ctx.stickyManager.mark({
      sessionId,
      skillName: name,
      source: "load_skill_tool",
      currentTurn,
    });
    if (markResult.evicted) {
      ctx.observability.emit(
        engineEventFromAdapterContext(ctx.adapterContext, {
          timestamp: Date.now(),
          phase: "tool-use",
          type: "skill_sticky_change",
          payload: {
            skill: markResult.evicted.skillName,
            action: "evict",
            source: markResult.evicted.source,
            ttlRemaining: 0,
            reason: "slot-lru",
          },
        }),
      );
    }
    ctx.observability.emit(
      engineEventFromAdapterContext(ctx.adapterContext, {
        timestamp: Date.now(),
        phase: "tool-use",
        type: "skill_sticky_change",
        payload: {
          skill: name,
          action: markResult.action === "refresh" ? "refresh" : "add",
          source: "load_skill_tool",
          ttlRemaining: markResult.entry.ttlRemaining,
          reason: "load_skill",
        },
      }),
    );
    return { ok: true, name, instructions: skill.instructions };
  }

  if (toolName === "search_skills") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, error: "query is required" };
    }
    if (!ctx.searchSkills) {
      return { ok: false, error: "search_skills is not enabled for this engine instance" };
    }
    const topK = typeof args.topK === "number" ? args.topK : undefined;
    const results = await ctx.searchSkills(query, topK);
    return { ok: true, query, results };
  }

  const skillName = typeof args.name === "string" ? args.name.trim() : "";
  const resourcePath = typeof args.path === "string" ? args.path.trim() : "";
  if (!skillName || !resourcePath) {
    return { ok: false, error: "name and path are required" };
  }
  const skill = await resolveSkill(ctx, skillName);
  if (!skill) {
    return { ok: false, error: `skill "${skillName}" not found` };
  }
  const resolved = resolveSkillResourcePath(skill, resourcePath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  try {
    const content = await readFile(resolved.fullPath, "utf8");
    return { ok: true, name: skillName, path: resourcePath, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to read resource: ${message}` };
  }
};

/** 合并内置 tool 定义（去重：业务 tool 优先）。 */
export const mergeInternalToolDefinitions = (
  tools: ToolDefinition[],
  options?: { enableSearchSkills?: boolean },
): ToolDefinition[] => {
  const names = new Set(tools.map((tool) => tool.name));
  const internal = getInternalToolDefinitions().filter((tool) => !names.has(tool.name));
  const optional =
    options?.enableSearchSkills === true && !names.has("search_skills")
      ? [getSearchSkillsToolDefinition()]
      : [];
  return [...tools, ...internal, ...optional];
};
