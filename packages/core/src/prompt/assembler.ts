import { ValidationError } from "../errors";
import type {
  Message,
  MessageContentPart,
  RuleDescriptor,
  SkillDescriptor,
  ToolDefinition,
  ToolDescriptor,
  InputEnvelope,
} from "../types";
import type { ContextWindow } from "../modules/memory";
import type { ModelCapabilities } from "../modules/provider";
import type { Tokenizer } from "./tokenizer";

/**
 * Prompt 组装参数。
 */
export interface AssembleParams {
  phase: RuleDescriptor["scope"][number];
  model: string;
  tokenizer: Tokenizer;
  modelCapabilities: ModelCapabilities;
  currentInput: InputEnvelope;
  activeRules: RuleDescriptor[];
  activeSkills: SkillDescriptor[];
  availableTools: ToolDescriptor[];
  contextWindow: ContextWindow;
  recalledEntries: Array<{ content: string }>;
  currentTaskContext?: Record<string, unknown>;
  toolCallHistory?: string[];
  finalOutputConstraint?: string;
  reserveOutputTokens?: number;
  systemInstruction?: string;
  onCompressContext?: () => Promise<void>;
}

/**
 * Prompt 组装结果。
 */
export interface AssembledPrompt {
  messages: Message[];
  tools: ToolDefinition[];
  tokenCount: number;
  appliedCuts: string[];
}

/**
 * PromptAssembler 接口：把 rules / skills / tools / history / recall / 任务上下文
 * 组装成单条 `AssembledPrompt`（含 system/user/assistant 消息序列与元数据）。
 */
export interface PromptAssembler {
  /**
   * 根据参数装配 Prompt。
   *
   * 实现需遵守 detailed-design §7：按 6 级裁剪优先级降级超预算输入——
   * 1) 丢 skills → 2) 丢 tools 描述 → 3) 压缩 recall → 4) 压缩 summary →
   * 5) 移除最早非 anchored 历史消息 → 6) 当仍超 `maxContextTokens` 时抛
   * {@link ValidationError.promptTooLarge}。
   *
   * @param params 装配入参
   * @returns 含 `messages` / `promptTokens` / `tokenBudgetLeft` / `truncated` 的装配产物
   * @throws {ValidationError} 当裁剪 6 级仍放不下时抛 `VAL_PROMPT_TOO_LARGE`
   */
  assemble(params: AssembleParams): Promise<AssembledPrompt>;
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

const filterRulesByPhase = (
  rules: RuleDescriptor[],
  phase: RuleDescriptor["scope"][number],
): RuleDescriptor[] =>
  rules.filter((rule) => rule.scope.includes("*") || rule.scope.includes(phase));

const toToolDefinition = (tool: ToolDescriptor): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
});

const renderSystemPrompt = (parts: {
  systemInstruction: string;
  rules: RuleDescriptor[];
  skills: SkillDescriptor[];
  tools: ToolDefinition[];
  summary: string;
  recall: string;
  taskContext: string;
  finalConstraint: string;
}): string => {
  const hardRules = parts.rules
    .filter((rule) => rule.type === "rule")
    .map((rule) => `- ${rule.content}`)
    .join("\n");
  const preferences = parts.rules
    .filter((rule) => rule.type === "preference")
    .map((rule) => `- ${rule.content}`)
    .join("\n");
  const skills = parts.skills.map((skill) => `### ${skill.name}\n${skill.instructions}`).join("\n\n");
  const tools = parts.tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  schema=${JSON.stringify(tool.inputSchema)}`)
    .join("\n");

  return [
    parts.systemInstruction,
    "## Hard Rules",
    hardRules || "- (none)",
    "## Preferences",
    preferences || "- (none)",
    "## Skills",
    skills || "(none)",
    "## Tool Definitions",
    tools || "(none)",
    "## Session Summary",
    parts.summary || "(none)",
    "## Recall Content",
    parts.recall || "(none)",
    "## Current Task Context",
    parts.taskContext || "(none)",
    "## Output Constraint",
    parts.finalConstraint || "请给出清晰、可执行结果。",
  ].join("\n\n");
};

/**
 * 默认 Prompt 组装实现。
 */
export class DefaultPromptAssembler implements PromptAssembler {
  async assemble(params: AssembleParams): Promise<AssembledPrompt> {
    const appliedCuts: string[] = [];
    const reserveOutputTokens = params.reserveOutputTokens ?? 4_096;
    const limit = params.modelCapabilities.maxContextTokens - reserveOutputTokens;

    const activeRules = filterRulesByPhase(params.activeRules, params.phase);
    let activeSkills = [...params.activeSkills];
    let recallEntries = [...params.recalledEntries];
    let tools = [...params.availableTools];
    let historyEntries = [...params.contextWindow.entries];

    const computeSummary = () =>
      historyEntries
        .map((entry) => `${entry.role}: ${stringify(entry.content)}`)
        .slice(-20)
        .join("\n");
    const taskContext = params.currentTaskContext ? stringify(params.currentTaskContext) : "";
    const finalConstraint = params.finalOutputConstraint ?? "请输出结构化且可追踪结果。";

    const build = (): AssembledPrompt => {
      const toolDefinitions = tools.map(toToolDefinition);
      const systemPrompt = renderSystemPrompt({
        systemInstruction:
          params.systemInstruction ??
          "You are Tachu Engine runtime. Follow rules first, then complete the user task.",
        rules: activeRules,
        skills: activeSkills,
        tools: toolDefinitions,
        summary: computeSummary(),
        recall: recallEntries.map((item) => item.content).join("\n"),
        taskContext,
        finalConstraint,
      });

      const messages: Message[] = [{ role: "system", content: systemPrompt }];
      for (const entry of historyEntries) {
        messages.push({
          role: entry.role,
          content: stringify(entry.content),
        });
      }
      for (const record of params.toolCallHistory ?? []) {
        messages.push({ role: "tool", content: record });
      }
      const currentRaw = params.currentInput.content;
      const userContent: Message["content"] =
        typeof currentRaw === "string"
          ? currentRaw
          : Array.isArray(currentRaw) &&
              currentRaw.every(
                (p) =>
                  p &&
                  typeof p === "object" &&
                  ((p as MessageContentPart).type === "text" ||
                    (p as MessageContentPart).type === "image_url"),
              )
            ? (currentRaw as MessageContentPart[])
            : stringify(currentRaw);
      messages.push({
        role: "user",
        content: userContent,
      });

      const tokenCount = params.tokenizer.count(
        messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => (part.type === "text" ? part.text : "[image]"))
                  .join("\n"),
          )
          .join("\n"),
      );

      return {
        messages,
        tools: toolDefinitions,
        tokenCount,
        appliedCuts: [...appliedCuts],
      };
    };

    let built = build();
    if (built.tokenCount <= limit) {
      return built;
    }

    // 裁剪链 level 1: compress-context（调用上游压缩策略）
    if (params.onCompressContext) {
      await params.onCompressContext();
      appliedCuts.push("compress-context");
      built = build();
      if (built.tokenCount <= limit) {
        return built;
      }
    }

    // level 2: trim-skill
    while (activeSkills.length > 0 && built.tokenCount > limit) {
      activeSkills.pop();
      appliedCuts.push("trim-skill");
      built = build();
    }
    if (built.tokenCount <= limit) {
      return built;
    }

    // level 3: trim-recall
    while (recallEntries.length > 0 && built.tokenCount > limit) {
      recallEntries.pop();
      appliedCuts.push("trim-recall");
      built = build();
    }
    if (built.tokenCount <= limit) {
      return built;
    }

    // level 4: trim-tool-definition
    while (tools.length > 0 && built.tokenCount > limit) {
      tools.pop();
      appliedCuts.push("trim-tool-definition");
      built = build();
    }
    if (built.tokenCount <= limit) {
      return built;
    }

    // level 5: trim-history（最后兜底：按时间从最早开始移除非锚定历史消息）
    // 锚定（anchored=true）条目由上游 MemorySystem 明确标记为"关键上下文"
    // （如压缩摘要），即使超预算也优先保留；当所有剩余条目都被锚定时才放弃裁剪。
    while (built.tokenCount > limit) {
      const removeIndex = historyEntries.findIndex((entry) => !entry.anchored);
      if (removeIndex < 0) {
        break;
      }
      historyEntries = [
        ...historyEntries.slice(0, removeIndex),
        ...historyEntries.slice(removeIndex + 1),
      ];
      appliedCuts.push("trim-history");
      built = build();
    }
    if (built.tokenCount <= limit) {
      return built;
    }

    throw ValidationError.promptTooLarge(built.tokenCount, limit);
  }
}

