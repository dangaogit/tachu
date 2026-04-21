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
    const result = await assembler.assemble({
      phase: "planning",
      model: "dev-large",
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
          scope: ["*"],
          content: "must be safe",
        },
        {
          kind: "rule",
          name: "p1",
          description: "pref desc",
          type: "preference",
          scope: ["planning"],
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
        entries: [{ role: "assistant", content: "history", timestamp: Date.now(), anchored: false }],
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
    const systemContent = result.messages[0]?.content ?? "";
    const systemPrompt =
      typeof systemContent === "string"
        ? systemContent
        : systemContent.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(systemPrompt.indexOf("## Hard Rules")).toBeLessThan(systemPrompt.indexOf("## Preferences"));
    expect(systemPrompt).toContain("## Skills");
    expect(systemPrompt).toContain("## Tool Definitions");
    expect(systemPrompt).toContain("## Session Summary");
    expect(systemPrompt).toContain("## Recall Content");
    expect(systemPrompt).toContain("## Current Task Context");
    expect(systemPrompt).toContain("## Output Constraint");
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test("applies trim strategy in contract order", async () => {
    const assembler = new DefaultPromptAssembler();
    const compressed: string[] = [];
    const result = await assembler.assemble({
      phase: "planning",
      model: "dev-small",
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
          scope: ["*"],
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

  test("throws ValidationError.promptTooLarge when all trims still exceed limit", async () => {
    const assembler = new DefaultPromptAssembler();
    await expect(
      assembler.assemble({
        phase: "planning",
        model: "dev-small",
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

