import { Glob } from "bun";
import { ValidationError } from "../errors";
import type {
  Message,
  MessageContentPart,
  RuleDescriptor,
  SkillDescriptor,
  ToolDefinition,
  ToolDescriptor,
  InputEnvelope,
  ResourceReference,
} from "../types";
import type { ContextWindow, MemoryEntry } from "../modules/memory";
import type { ModelCapabilities } from "../modules/provider";
import type { Tokenizer } from "./tokenizer";
import { renderActiveSkills } from "./render-skills";
import { stripTrailingCurrentTurn } from "./turn-tail";
import { renderTokensToDisplay } from "../utils/resource-pool";

export type SkillPromptSource = "always" | "sticky" | "recall-active" | "available";

export interface TrimmedSkillRecord {
  name: string;
  source: SkillPromptSource;
  reason: "budget";
}

/**
 * Prompt 组装参数。
 */
export interface AssembleParams {
  model: string;
  tokenizer: Tokenizer;
  modelCapabilities: ModelCapabilities;
  currentInput: InputEnvelope;
  activeRules: RuleDescriptor[];
  activeSkills: SkillDescriptor[];
  availableSkills?: SkillDescriptor[];
  availableTools: ToolDescriptor[];
  contextWindow: ContextWindow;
  recalledEntries: Array<{ content: string }>;
  skillSimilarityMap?: Map<string, number>;
  stickySkillNames?: Set<string>;
  alwaysSkillNames?: Set<string>;
  skillBudget?: number;
  currentTaskContext?: Record<string, unknown>;
  toolCallHistory?: string[];
  finalOutputConstraint?: string;
  reserveOutputTokens?: number;
  systemInstruction?: string;
  /**
   * manual-activation 规则的显式点名集合;仅这些名字对应的 `manual` 规则会注入。
   */
  explicitRuleNames?: readonly string[];
  /**
   * 本轮上下文中的文件路径,供 `path`-activation 规则与其 globs 匹配。
   */
  contextFilePaths?: readonly string[];
  /**
   * 调用方判定为语义相关的规则名集合,供 `semantic`-activation 规则注入。
   */
  semanticActiveRuleNames?: readonly string[];
  onCompressContext?: () => Promise<void>;
 /**
 * 来自 ContextBudgetBroker 的裁剪优先级序列。
 * 当提供时，assembler 按该序列依次执行 trim，替代历史固定顺序
 * （compress → skill → recall → tool → history）；未提供时保留旧行为。
 * 已知 token：`recalled-memory` / `available-skills` / `history` /
 * `tool-definitions` / `memory` / `tools` / `skills` / `old-assistant-turns` /
 * `old-tool-observations`。未识别 token 静默跳过并记入 `appliedCuts`
 * （形如 `trim:skipped-unknown:<token>`），方便观测排查。
 */
  trimOrder?: readonly string[];
}

/**
 * Prompt 组装结果。
 */
export interface AssembledPrompt {
  messages: Message[];
  tools: ToolDefinition[];
  tokenCount: number;
  appliedCuts: string[];
 /** Active skills after budget trim; used by final-answer inheritance (). */
  activeSkills: SkillDescriptor[];
  trimmedSkills?: TrimmedSkillRecord[];
}

/**
 * PromptAssembler 接口：把 rules / skills / tools / history / recall / 任务上下文
 * 组装成单条 `AssembledPrompt`（含 system/user/assistant 消息序列与元数据）。
 */
export interface PromptAssembler {
  assemble(params: AssembleParams): Promise<AssembledPrompt>;
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

const isMessageContentParts = (value: unknown): value is MessageContentPart[] =>
  Array.isArray(value) &&
  value.every(
    (p) =>
      p &&
      typeof p === "object" &&
      ((p as MessageContentPart).type === "text" ||
        (p as MessageContentPart).type === "image_url" ||
        (p as MessageContentPart).type === "file"),
  );

/**
 * 规则激活上下文——供 assembler 判定每条规则本轮是否注入 prompt。
 * 全部字段都是**调用方提供的确定性输入**;assembler 不做语义检索、
 * 也不自行判断文件上下文,只按输入过滤(fail-closed:缺省即不注入)。
 */
export interface RuleActivationContext {
  explicitRuleNames: ReadonlySet<string>;
  contextFilePaths: readonly string[];
  semanticActiveRuleNames: ReadonlySet<string>;
}

const isRuleActivated = (rule: RuleDescriptor, ctx: RuleActivationContext): boolean => {
  const activation = rule.activation;
  switch (activation.mode) {
    case "always":
      return true;
    case "manual":
      return ctx.explicitRuleNames.has(rule.name);
    case "semantic":
      return ctx.semanticActiveRuleNames.has(rule.name);
    case "path":
      return ctx.contextFilePaths.some((path) =>
        activation.globs.some((glob) => new Glob(glob).match(path)),
      );
  }
};

const filterRulesByActivation = (
  rules: RuleDescriptor[],
  ctx: RuleActivationContext,
): RuleDescriptor[] => rules.filter((rule) => isRuleActivated(rule, ctx));

const toToolDefinition = (tool: ToolDescriptor): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
});

interface SkillPromptEntry {
  skill: SkillDescriptor;
  source: SkillPromptSource;
  similarity: number;
  stickyIndex: number;
}

const sourceRank: Record<SkillPromptSource, number> = {
  available: 0,
  "recall-active": 1,
  sticky: 2,
  always: 3,
};

const compareSkillTrimOrder = (a: SkillPromptEntry, b: SkillPromptEntry): number => {
  if (sourceRank[a.source] !== sourceRank[b.source]) {
    return sourceRank[a.source] - sourceRank[b.source];
  }
  if (a.source === "available" || a.source === "recall-active") {
    return a.similarity - b.similarity;
  }
  if (a.source === "sticky") {
    return a.stickyIndex - b.stickyIndex;
  }
  return 0;
};

const classifyActiveSkillSource = (
  skill: SkillDescriptor,
  params: AssembleParams,
): SkillPromptSource => {
  if (params.alwaysSkillNames?.has(skill.name)) {
    return "always";
  }
  if (params.stickySkillNames?.has(skill.name)) {
    return "sticky";
  }
  return "recall-active";
};

const buildSkillEntries = (params: AssembleParams): SkillPromptEntry[] => {
  const stickyOrder = params.stickySkillNames
    ? [...params.stickySkillNames]
    : [];
  const stickyIndex = (name: string): number => {
    const index = stickyOrder.indexOf(name);
    return index >= 0 ? index : stickyOrder.length;
  };

  const entries: SkillPromptEntry[] = [];
  for (const skill of params.activeSkills) {
    entries.push({
      skill,
      source: classifyActiveSkillSource(skill, params),
      similarity: params.skillSimilarityMap?.get(skill.name) ?? 1,
      stickyIndex: stickyIndex(skill.name),
    });
  }
  for (const skill of params.availableSkills ?? []) {
    if (params.activeSkills.some((item) => item.name === skill.name)) {
      continue;
    }
    entries.push({
      skill,
      source: "available",
      similarity: params.skillSimilarityMap?.get(skill.name) ?? 0,
      stickyIndex: stickyOrder.length,
    });
  }
  return entries;
};

const renderAvailableSkills = (skills: SkillDescriptor[]): string =>
  skills.map((skill) => `- **${skill.name}**: ${skill.description}`).join("\n");

const renderSystemPrompt = (parts: {
  systemInstruction: string;
  rules: RuleDescriptor[];
  activeSkills: SkillDescriptor[];
  availableSkills: SkillDescriptor[];
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
  const activeSkills = renderActiveSkills(parts.activeSkills);
  const availableSkills =
    parts.availableSkills.length > 0 ? renderAvailableSkills(parts.availableSkills) : "";
  const tools = parts.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");

  const sections = [
    parts.systemInstruction,
    "## Hard Rules",
    hardRules || "- (none)",
    "## Preferences",
    preferences || "- (none)",
    "## Tool Definitions",
    tools || "(none)",
    "## Active Skills",
    activeSkills || "(none)",
  ];
  if (availableSkills.length > 0) {
    sections.push("## Available Skills", availableSkills);
  }
  sections.push(
    "## Session Summary",
    parts.summary || "(none)",
    "## Recall Content",
    parts.recall || "(none)",
    "## Current Task Context",
    parts.taskContext || "(none)",
    "## Output Constraint",
    parts.finalConstraint || "请给出清晰、可执行结果。",
  );

  return sections.join("\n\n");
};

const countSkillSectionTokens = (
  tokenizer: Tokenizer,
  active: SkillDescriptor[],
  available: SkillDescriptor[],
): number => {
  const text = [
    "## Active Skills",
    renderActiveSkills(active) || "(none)",
    "## Available Skills",
    renderAvailableSkills(available) || "(none)",
  ].join("\n\n");
  return tokenizer.count(text);
};

const splitSkillEntries = (
  entries: SkillPromptEntry[],
): { active: SkillDescriptor[]; available: SkillDescriptor[] } => {
  const active: SkillDescriptor[] = [];
  const available: SkillDescriptor[] = [];
  for (const entry of entries) {
    if (entry.source === "available") {
      available.push(entry.skill);
    } else {
      active.push(entry.skill);
    }
  }
  return { active, available };
};

/**
 * 默认 Prompt 组装实现。
 */
export class DefaultPromptAssembler implements PromptAssembler {
  async assemble(params: AssembleParams): Promise<AssembledPrompt> {
    const appliedCuts: string[] = [];
    const trimmedSkills: TrimmedSkillRecord[] = [];
    const reserveOutputTokens = params.reserveOutputTokens ?? 4_096;
    const limit = params.modelCapabilities.maxContextTokens - reserveOutputTokens;
    const skillBudget = params.skillBudget ?? 0.8;
    const skillTokenLimit = Math.floor(limit * skillBudget);

    const activeRules = filterRulesByActivation(params.activeRules, {
      explicitRuleNames: new Set(params.explicitRuleNames ?? []),
      contextFilePaths: params.contextFilePaths ?? [],
      semanticActiveRuleNames: new Set(params.semanticActiveRuleNames ?? []),
    });
    let skillEntries = buildSkillEntries(params);
    let recallEntries = [...params.recalledEntries];
    let tools = [...params.availableTools];

 // 本轮 user 的归一化形态：同时用于剥 session.append 写入 memory 的那条
 // 以及最终拼到 messages 末尾。先算一次，避免在 build() 闭包里重复计算。
    const currentRaw = params.currentInput.content;
    const userContent: Message["content"] =
      typeof currentRaw === "string"
        ? currentRaw
        : isMessageContentParts(currentRaw)
          ? (currentRaw as MessageContentPart[])
          : stringify(currentRaw);

 // Session 阶段在装配之前已把本轮 user 写入 memory（崩溃恢复语义），
 // 这里把 memory 末尾"本轮影像"剥掉，避免与下面的 push 形成双发。
 // 契约见 stripTrailingCurrentTurn：只看末尾、至多剥 1 条，绝不向前回溯，
 // 用户连续多轮发同样字面也不会被误吞。
    let historyEntries = [
      ...stripTrailingCurrentTurn(params.contextWindow.entries, userContent),
    ];

 // 本轮 + 历史的 Resource Pool（按 key 去重）。
 // Session Summary 用它把 token 渲染成 displayLabel（可读、零物化）；
 // 历史/本轮消息体保留 canonical token + 挂 resources，供 seam 按需物化。
    const buildResourcePool = (
      entries: readonly MemoryEntry[],
    ): ResourceReference[] => {
      const byKey = new Map<string, ResourceReference>();
      for (const ref of params.currentInput.resources ?? []) {
        byKey.set(ref.key, ref);
      }
      for (const entry of entries) {
        for (const ref of entry.resources ?? []) {
          if (!byKey.has(ref.key)) {
            byKey.set(ref.key, ref);
          }
        }
      }
      return [...byKey.values()];
    };

    const popLowestPrioritySkill = (): boolean => {
      if (skillEntries.length === 0) {
        return false;
      }
      const sorted = [...skillEntries].sort(compareSkillTrimOrder);
      const removed = sorted[0];
      if (!removed) {
        return false;
      }
      skillEntries = skillEntries.filter(
        (entry) => entry.skill.name !== removed.skill.name,
      );
      trimmedSkills.push({
        name: removed.skill.name,
        source: removed.source,
        reason: "budget",
      });
      appliedCuts.push("trim-skill");
      return true;
    };

    const trimSkillBudget = (): void => {
      let { active, available } = splitSkillEntries(skillEntries);
      while (
        skillEntries.length > 0 &&
        countSkillSectionTokens(params.tokenizer, active, available) > skillTokenLimit
      ) {
        if (!popLowestPrioritySkill()) {
          break;
        }
        ({ active, available } = splitSkillEntries(skillEntries));
      }
    };

    trimSkillBudget();

    const computeSummary = () => {
      const pool = buildResourcePool(historyEntries);
      return historyEntries
        .map(
          (entry) =>
            `${entry.role}: ${renderTokensToDisplay(stringify(entry.content), pool)}`,
        )
        .slice(-20)
        .join("\n");
    };
    const taskContext = params.currentTaskContext ? stringify(params.currentTaskContext) : "";
    const finalConstraint = params.finalOutputConstraint ?? "请输出结构化且可追踪结果。";

    const build = (): AssembledPrompt => {
      const { active, available } = splitSkillEntries(skillEntries);
      const toolDefinitions = tools.map(toToolDefinition);
      const systemPrompt = renderSystemPrompt({
        systemInstruction:
          params.systemInstruction ??
          "You are Tachu Engine runtime. Follow rules first, then complete the user task.",
        rules: activeRules,
        activeSkills: active,
        availableSkills: available,
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
          content: isMessageContentParts(entry.content)
            ? entry.content
            : stringify(entry.content),
          ...(entry.resources && entry.resources.length > 0
            ? { resources: entry.resources }
            : {}),
        });
      }
      for (const record of params.toolCallHistory ?? []) {
        messages.push({ role: "tool", content: record });
      }
      messages.push({
        role: "user",
        content: userContent,
        ...(params.currentInput.resources && params.currentInput.resources.length > 0
          ? { resources: params.currentInput.resources }
          : {}),
      });

      const tokenCount = params.tokenizer.count(
        messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) =>
                    part.type === "text"
                      ? part.text
                      : part.type === "image_url"
                        ? "[image]"
                        : `[file:${part.file.mimeType}]`,
                  )
                  .join("\n"),
          )
          .join("\n"),
      );

      return {
        messages,
        tools: toolDefinitions,
        tokenCount,
        appliedCuts: [...appliedCuts],
        activeSkills: active,
        ...(trimmedSkills.length > 0 ? { trimmedSkills } : {}),
      };
    };

    let built = build();
    if (built.tokenCount <= limit) {
      return built;
    }

    if (params.onCompressContext) {
      await params.onCompressContext();
      appliedCuts.push("compress-context");
      built = build();
      if (built.tokenCount <= limit) {
        return built;
      }
    }

 // 把 trim 拆分为命名 handler，由 envelope.trimOrder 顺序驱动。
    const trimRecall = (): boolean => {
      if (recallEntries.length === 0) return false;
      recallEntries.pop();
      appliedCuts.push("trim-recall");
      return true;
    };
    const trimTools = (): boolean => {
      if (tools.length === 0) return false;
      tools.pop();
      appliedCuts.push("trim-tool-definition");
      return true;
    };
    const trimHistory = (): boolean => {
      const removeIndex = historyEntries.findIndex((entry) => !entry.anchored);
      if (removeIndex < 0) return false;
      historyEntries = [
        ...historyEntries.slice(0, removeIndex),
        ...historyEntries.slice(removeIndex + 1),
      ];
      appliedCuts.push("trim-history");
      return true;
    };
    const handlerFor = (token: string): (() => boolean) | undefined => {
      switch (token) {
        case "recalled-memory":
        case "memory":
        case "old-observations":
          return trimRecall;
        case "available-skills":
        case "skills":
          return popLowestPrioritySkill;
        case "tool-definitions":
        case "tools":
          return trimTools;
        case "history":
        case "old-assistant-turns":
        case "old-tool-observations":
        case "previous-results":
          return trimHistory;
        default:
          return undefined;
      }
    };

    const trimSequence: readonly string[] =
      params.trimOrder !== undefined && params.trimOrder.length > 0
        ? params.trimOrder
        : // 旧默认顺序（保持向后兼容）：skills → recall → tools → history
          ["available-skills", "recalled-memory", "tool-definitions", "history"];

    for (const token of trimSequence) {
      if (built.tokenCount <= limit) break;
      const handler = handlerFor(token);
      if (handler === undefined) {
        appliedCuts.push(`trim:skipped-unknown:${token}`);
        continue;
      }
      while (built.tokenCount > limit && handler()) {
        built = build();
      }
    }

    if (built.tokenCount <= limit) {
      return built;
    }

    throw ValidationError.promptTooLarge(built.tokenCount, limit);
  }
}
