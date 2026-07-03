import { describe, expect, test } from "bun:test";
import { ValidationError } from "../errors";
import { DefaultPromptAssembler } from "./assembler";
import type { Tokenizer } from "./tokenizer";

const tokenizer: Tokenizer = {
  count: (text) => text.length,
  encode: (text) => [...Buffer.from(text, "utf8").values()],
  decode: (tokens) => Buffer.from(tokens).toString("utf8"),
};

describe("DefaultPromptAssembler", () => {
 test("assembles 11 segments in stable order", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({      model: "dev-large",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 8_192,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      currentInput: { content: "user input", metadata: { modality: "text", size: 12 } },
      activeRules: [
        {
          kind: "rule",
          name: "r1",
          description: "rule desc",
          type: "rule",
          activation: { mode: "always" },
          content: "must be safe",
        },
        {
          kind: "rule",
          name: "p1",
          description: "pref desc",
          type: "preference",
          activation: { mode: "always" },
          content: "prefer concise answer",
        },
      ],
      activeSkills: [
        {
          kind: "skill",
          name: "plan-skill",
          description: "do planning",
          instructions: "steps and constraints",
        },
      ],
      availableTools: [
        {
          kind: "tool",
          name: "read-file",
          description: "read file",
          sideEffect: "readonly",
          idempotent: true,
          requiresApproval: false,
          timeout: 1_000,
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          execute: "readFile",
        },
      ],
      contextWindow: {
        entries: [{ id: "h1", role: "assistant", content: "history", timestamp: Date.now(), anchored: false }],
        tokenCount: 100,
        limit: 4000,
      },
      recalledEntries: [{ content: "recall text" }],
      currentTaskContext: { task: "build plan" },
      toolCallHistory: ["tool result history"],
      finalOutputConstraint: "json only",
      reserveOutputTokens: 512,
    });
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.messages[2]?.role).toBe("tool");
    expect(result.messages.at(-1)?.role).toBe("user");
    expect(result.activeSkills.map((skill) => skill.name)).toEqual(["plan-skill"]);
    const systemContent = result.messages[0]?.content ?? "";
    const systemPrompt =
      typeof systemContent === "string"
        ? systemContent
        : systemContent.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(systemPrompt.indexOf("## Hard Rules")).toBeLessThan(systemPrompt.indexOf("## Preferences"));
    expect(systemPrompt).toContain("## Active Skills");
    expect(systemPrompt).not.toContain("## Available Skills");
    expect(systemPrompt).toContain("## Tool Definitions");
    expect(systemPrompt).toContain("## Session Summary");
    expect(systemPrompt).toContain("## Recall Content");
    expect(systemPrompt).toContain("## Current Task Context");
    expect(systemPrompt).toContain("## Output Constraint");
    expect(systemPrompt).toContain("- read-file: read file");
    expect(systemPrompt).not.toContain("schema=");
    expect(systemPrompt).not.toContain('"properties"');
    expect(result.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(result.tokenCount).toBeGreaterThan(0);
  });

 test("applies trim strategy in contract order", async () => {
    const assembler = new DefaultPromptAssembler();
    const compressed: string[] = [];
    const result = await assembler.assemble({      model: "dev-small",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 700,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      reserveOutputTokens: 100,
      onCompressContext: async () => {
        compressed.push("done");
      },
      currentInput: { content: "short user input", metadata: { modality: "text", size: 20 } },
      activeRules: [
        {
          kind: "rule",
          name: "hard-rule",
          description: "must follow",
          type: "rule",
          activation: { mode: "always" },
          content: "always do this",
        },
      ],
      activeSkills: [
        {
          kind: "skill",
          name: "s1",
          description: "skill 1",
          instructions: "x".repeat(400),
        },
      ],
      availableTools: [
        {
          kind: "tool",
          name: "tool1",
          description: "y".repeat(500),
          sideEffect: "readonly",
          idempotent: true,
          requiresApproval: false,
          timeout: 1_000,
          inputSchema: { type: "object", properties: { p: { type: "string" } } },
          execute: "exec1",
        },
      ],
      contextWindow: {
        entries: [],
        tokenCount: 0,
        limit: 1_000,
      },
      recalledEntries: [{ content: "z".repeat(300) }],
    });
    expect(compressed).toEqual(["done"]);
    expect(result.appliedCuts[0]).toBe("compress-context");
    expect(result.appliedCuts).toContain("trim-skill");
    expect(result.appliedCuts).toContain("trim-recall");
    expect(result.appliedCuts).toContain("trim-tool-definition");
  });

 // P2 ζ：assembler 必须按 envelope.trimOrder 顺序执行裁剪。
 test("trimOrder 优先于内置顺序（history 在第一位则先裁 history）", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({      model: "dev",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 5_000,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      reserveOutputTokens: 100,
      currentInput: { content: "q", metadata: { modality: "text", size: 1 } },
      activeRules: [],
      activeSkills: [],
      availableTools: [],
      contextWindow: {
        entries: Array.from({ length: 30 }, (_, i) => ({
          id: `h${i}`,
          role: "assistant" as const,
          content: `H${i} ` + "x".repeat(120),
          timestamp: i,
          anchored: false,
        })),
        tokenCount: 0,
        limit: 100_000,
      },
      recalledEntries: [{ content: "R " + "y".repeat(60) }],
      trimOrder: ["history", "recalled-memory"],
    });
    const idxHist = result.appliedCuts.indexOf("trim-history");
    const idxRecall = result.appliedCuts.indexOf("trim-recall");
    expect(idxHist).toBeGreaterThanOrEqual(0);
    if (idxRecall >= 0) {
      expect(idxHist).toBeLessThan(idxRecall);
    }
  });

 test("trimOrder 中未识别 token 静默跳过并记录 appliedCuts", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({      model: "dev",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 5_000,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      reserveOutputTokens: 100,
      currentInput: { content: "q", metadata: { modality: "text", size: 1 } },
      activeRules: [],
      activeSkills: [],
      availableTools: [],
      contextWindow: {
        entries: Array.from({ length: 30 }, (_, i) => ({
          id: `h${i}`,
          role: "assistant" as const,
          content: `H${i} ` + "x".repeat(120),
          timestamp: i,
          anchored: false,
        })),
        tokenCount: 0,
        limit: 100_000,
      },
      recalledEntries: [],
      trimOrder: ["sub-agent-output", "history"],
    });
    expect(result.appliedCuts).toContain("trim:skipped-unknown:sub-agent-output");
    expect(result.appliedCuts).toContain("trim-history");
  });

 test("当 history 末尾就是 currentInput（session 已 append）时，不重复 push 末尾 user", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({      model: "dev-large",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 8_192,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      currentInput: { content: "你好", metadata: { modality: "text", size: 2 } },
      activeRules: [],
      activeSkills: [],
      availableTools: [],
      contextWindow: {
        entries: [
          { id: "u1", role: "user", content: "你好", timestamp: Date.now(), anchored: false },
        ],
        tokenCount: 0,
        limit: 4_000,
      },
      recalledEntries: [],
      reserveOutputTokens: 512,
    });
    const userMessages = result.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("你好");
  });

 test("用户连发两次相同内容（历史已含 N-1 轮的同字面 user + assistant + 本轮 user）→ 历史那条不被误吞", async () => {
    const assembler = new DefaultPromptAssembler();
    const ts = Date.now();
    const result = await assembler.assemble({      model: "dev-large",
      tokenizer,
      modelCapabilities: {
        supportedModalities: ["text"],
        maxContextTokens: 8_192,
        supportsStreaming: true,
        supportsFunctionCalling: true,
      },
      currentInput: { content: "hello", metadata: { modality: "text", size: 5 } },
      activeRules: [],
      activeSkills: [],
      availableTools: [],
      contextWindow: {
        entries: [
          { id: "h1", role: "user", content: "hello", timestamp: ts - 30, anchored: false },
          { id: "h2", role: "assistant", content: "hi back", timestamp: ts - 20, anchored: false },
          { id: "h3", role: "user", content: "hello", timestamp: ts - 10, anchored: false },
        ],
        tokenCount: 0,
        limit: 4_000,
      },
      recalledEntries: [],
      reserveOutputTokens: 512,
    });
    const userMessages = result.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((m) => m.content)).toEqual(["hello", "hello"]);
  });

 test("throws ValidationError.promptTooLarge when all trims still exceed limit", async () => {
    const assembler = new DefaultPromptAssembler();
    await expect(
      assembler.assemble({        model: "dev-small",
        tokenizer,
        modelCapabilities: {
          supportedModalities: ["text"],
          maxContextTokens: 200,
          supportsStreaming: true,
          supportsFunctionCalling: true,
        },
        reserveOutputTokens: 50,
        currentInput: { content: "u".repeat(600), metadata: { modality: "text", size: 600 } },
        activeRules: [],
        activeSkills: [],
        availableTools: [],
        contextWindow: { entries: [], tokenCount: 0, limit: 1_000 },
        recalledEntries: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("DefaultPromptAssembler rule activation", () => {
  const baseParams = (activeRules: import("../types").RuleDescriptor[]) => ({
    model: "dev",
    tokenizer,
    modelCapabilities: {
      supportedModalities: ["text"],
      maxContextTokens: 8_192,
      supportsStreaming: true,
      supportsFunctionCalling: true,
    },
    currentInput: { content: "q", metadata: { modality: "text" as const, size: 1 } },
    activeRules,
    activeSkills: [],
    availableTools: [],
    contextWindow: { entries: [], tokenCount: 0, limit: 4_000 },
    recalledEntries: [],
    reserveOutputTokens: 512,
  });

  const systemTextOf = (messages: import("../types").Message[]): string => {
    const content = messages[0]?.content ?? "";
    return typeof content === "string"
      ? content
      : content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };

  test("activation always: 恒注入 prompt", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble(
      baseParams([
        {
          kind: "rule",
          name: "always-rule",
          description: "d",
          type: "rule",
          activation: { mode: "always" },
          content: "ALWAYS-RULE-MARKER",
        },
      ]),
    );
    expect(systemTextOf(result.messages)).toContain("ALWAYS-RULE-MARKER");
  });

  test("activation manual: 未被点名时不注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble(
      baseParams([
        {
          kind: "rule",
          name: "manual-rule",
          description: "d",
          type: "rule",
          activation: { mode: "manual" },
          content: "MANUAL-RULE-MARKER",
        },
      ]),
    );
    expect(systemTextOf(result.messages)).not.toContain("MANUAL-RULE-MARKER");
  });

  test("activation manual: 命中 explicitRuleNames 时注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({
      ...baseParams([
        {
          kind: "rule",
          name: "manual-rule",
          description: "d",
          type: "rule",
          activation: { mode: "manual" },
          content: "MANUAL-RULE-MARKER",
        },
      ]),
      explicitRuleNames: ["manual-rule"],
    });
    expect(systemTextOf(result.messages)).toContain("MANUAL-RULE-MARKER");
  });

  const pathRule = (): import("../types").RuleDescriptor => ({
    kind: "rule",
    name: "path-rule",
    description: "d",
    type: "rule",
    activation: { mode: "path", globs: ["src/**/*.ts"] },
    content: "PATH-RULE-MARKER",
  });

  test("activation path: 无匹配文件时不注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({
      ...baseParams([pathRule()]),
      contextFilePaths: ["docs/readme.md"],
    });
    expect(systemTextOf(result.messages)).not.toContain("PATH-RULE-MARKER");
  });

  test("activation path: 命中 glob 的文件在上下文时注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({
      ...baseParams([pathRule()]),
      contextFilePaths: ["src/engine/engine.ts"],
    });
    expect(systemTextOf(result.messages)).toContain("PATH-RULE-MARKER");
  });

  const semanticRule = (): import("../types").RuleDescriptor => ({
    kind: "rule",
    name: "semantic-rule",
    description: "d",
    type: "rule",
    activation: { mode: "semantic" },
    content: "SEMANTIC-RULE-MARKER",
  });

  test("activation semantic: 缺省无活跃集时 fail-closed 不注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble(baseParams([semanticRule()]));
    expect(systemTextOf(result.messages)).not.toContain("SEMANTIC-RULE-MARKER");
  });

  test("activation semantic: 命中 semanticActiveRuleNames 时注入", async () => {
    const assembler = new DefaultPromptAssembler();
    const result = await assembler.assemble({
      ...baseParams([semanticRule()]),
      semanticActiveRuleNames: ["semantic-rule"],
    });
    expect(systemTextOf(result.messages)).toContain("SEMANTIC-RULE-MARKER");
  });
});

