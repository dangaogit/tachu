import { describe, expect, test } from "bun:test";

import { DefaultModelRouter } from "../../modules/model-router";
import { DefaultObservabilityEmitter } from "../../modules/observability";
import type { ChatRequest, ChatResponse, ProviderAdapter } from "../../modules/provider";
import type { EngineConfig, Message } from "../../types";
import type { AdapterCallContext } from "../../types/context";
import { DEFAULT_ADAPTER_CALL_CONTEXT } from "../../types/context";
import { createDefaultEngineConfig } from "../../utils";
import type { AssembledPrompt } from "../../prompt/assembler";
import {
  DIRECT_ANSWER_CONSTANTS,
  __testing as directAnswerInternals,
  executeDirectAnswer,
  type DirectAnswerContext,
} from "./direct-answer";

const ASSEMBLER_MARKER = "[assembler] global system instruction";

const baseConfig = (directAnswerBase?: string): EngineConfig => {
  const config = createDefaultEngineConfig();
  config.models.capabilityMapping = {
    intent: { provider: "scripted", model: "scripted-medium" },
    "fast-cheap": { provider: "scripted", model: "scripted-small" },
  };
  if (directAnswerBase !== undefined) {
    config.directAnswer = { systemPromptBase: directAnswerBase };
  }
  return config;
};

const prebuiltWithAssembler = (): AssembledPrompt => ({
  messages: [
    { role: "system", content: ASSEMBLER_MARKER },
    { role: "user", content: "hello" },
  ],
  tools: [],
  tokenCount: 0,
  appliedCuts: [],
  activeSkills: [],
});

const createScriptedProvider = (): {
  adapter: ProviderAdapter;
  calls: Array<{ messages: Message[] }>;
} => {
  const calls: Array<{ messages: Message[] }> = [];
  const adapter: ProviderAdapter = {
    id: "scripted",
    name: "scripted",
    async listAvailableModels() {
      return [
        {
          modelName: "scripted-medium",
          capabilities: {
            supportedModalities: ["text"],
            maxContextTokens: 128_000,
            supportsStreaming: true,
            supportsFunctionCalling: true,
          },
        },
      ];
    },
    async chat(req: ChatRequest, _ctx: AdapterCallContext): Promise<ChatResponse> {
      calls.push({ messages: req.messages.map((m) => ({ ...m })) });
      return {
        content: "ok",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
    async *chatStream() {
      throw new Error("not used");
    },
    async countTokens() {
      return 0;
    },
  };
  return { adapter, calls };
};

const buildDirectAnswerCtx = (args: {
  config: EngineConfig;
  provider: ProviderAdapter;
  prebuilt: AssembledPrompt;
}): DirectAnswerContext => ({
  config: args.config,
  providers: new Map([[args.provider.id, args.provider]]),
  modelRouter: new DefaultModelRouter(args.config),
  memorySystem: {} as DirectAnswerContext["memorySystem"],
  observability: new DefaultObservabilityEmitter(),
  signal: new AbortController().signal,
  adapterContext: DEFAULT_ADAPTER_CALL_CONTEXT,
  prebuiltPrompt: args.prebuilt,
});

/**
 * direct-answer Sub-flow 的 SYSTEM_PROMPT 是**面向用户回复**的最后一道闸门，
 * 任何"请稍等 / 我将去获取 / 我已经抓到了"类空承诺一旦漏网，整个 turn 就变成废话。
 *
 * 这里把关键约束文本作为**硬契约**测一遍 —— 改 prompt 时如果不小心删掉这些条款，
 * CI 会立即红灯。
 */
describe("DIRECT_ANSWER_CONSTANTS.SYSTEM_PROMPT 硬契约", () => {
  const prompt = DIRECT_ANSWER_CONSTANTS.SYSTEM_PROMPT;

 test("显式禁止空头承诺（I'll fetch / let me check / 请稍等）", () => {
    expect(prompt).toContain("No empty promises");
    expect(prompt).toContain("请稍等");
    expect(prompt).toMatch(/I'?ll\s+(fetch|check|look)/i);
    expect(prompt).toMatch(/let\s+me\s+check/i);
  });

 test("显式禁止伪装已执行动作（I fetched / I ran / I just opened）", () => {
    expect(prompt).toContain("No pretending you executed an action");
    expect(prompt).toMatch(/I\s+fetched/i);
    expect(prompt).toMatch(/I\s+ran/i);
  });

 test("给出无法真正执行时的三步兜底指引", () => {
    expect(prompt).toContain("no matching tool was available this turn");
    expect(prompt).toContain("based on general knowledge rather than the live content");
    expect(prompt).toMatch(/paste the page text/i);
  });

 test("保留 warn=true 的宿主提示分支", () => {
    expect(prompt).toContain("warn=true");
    expect(prompt).toContain("knowledge-based answer");
  });

 test("保留 Markdown 与代码围栏格式约束", () => {
    expect(prompt).toContain("natural language + Markdown");
    expect(prompt).toContain("fenced code block");
  });

 test("末尾要求 LLM 跟随用户语言（language mirror）", () => {
    expect(prompt).toContain(
      "Respond in the same language as the latest user message",
    );
  });
});

describe("directAnswer.systemPromptBase 覆盖", () => {
 test("宿主 base 完整替换默认 DIRECT_ANSWER_SYSTEM_PROMPT", () => {
    const hostBase = "HOST-DIRECT-ANSWER-BASE";
    const resolved = directAnswerInternals.resolveDirectAnswerSystemPrompt({
      directAnswer: { systemPromptBase: hostBase },
    } as EngineConfig);
    expect(resolved).toBe(hostBase);
  });

 test("未设置 override 时与 DIRECT_ANSWER_CONSTANTS.SYSTEM_PROMPT 一致", () => {
    expect(directAnswerInternals.resolveDirectAnswerSystemPrompt({} as EngineConfig)).toBe(
      DIRECT_ANSWER_CONSTANTS.SYSTEM_PROMPT,
    );
  });
});

describe("directAnswer prebuilt 组合提示词", () => {
 test("Assembler system 在前，phase override 在后", () => {
    const hostBase = "HOST-DIRECT-ANSWER-BASE";
    const messages = directAnswerInternals.buildDirectAnswerMessagesFromPrebuilt(
      { prompt: "hello" },
      prebuiltWithAssembler(),
      baseConfig(hostBase),
    );
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain(ASSEMBLER_MARKER);
    expect(messages[1]).toEqual({ role: "system", content: hostBase });
    expect(messages[2]).toEqual({ role: "user", content: "hello" });
  });

 test("warn=true 时 phase override 仍在 user 之前，warn hint 在最后", () => {
    const hostBase = "HOST-DIRECT-ANSWER-BASE";
    const messages = directAnswerInternals.buildDirectAnswerMessagesFromPrebuilt(
      { prompt: "hello", warn: true },
      prebuiltWithAssembler(),
      baseConfig(hostBase),
    );
    expect(messages[1]).toEqual({ role: "system", content: hostBase });
    expect(messages[2]).toEqual({ role: "user", content: "hello" });
    expect(messages.at(-1)?.role).toBe("system");
    expect(String(messages.at(-1)?.content)).toContain("[Host hint]");
    expect(String(messages.at(-1)?.content)).toContain("no matching tool was found");
  });

 test("executeDirectAnswer 经 prebuilt 向 Provider 发送双 system", async () => {
    const hostBase = "HOST-DIRECT-ANSWER-BASE";
    const { adapter, calls } = createScriptedProvider();
    const ctx = buildDirectAnswerCtx({
      config: baseConfig(hostBase),
      provider: adapter,
      prebuilt: prebuiltWithAssembler(),
    });
    await executeDirectAnswer({ prompt: "hello" }, ctx);
    expect(calls).toHaveLength(1);
    const systemMessages = calls[0]?.messages.filter((m) => m.role === "system") ?? [];
    expect(systemMessages).toHaveLength(2);
    expect(String(systemMessages[0]?.content)).toContain(ASSEMBLER_MARKER);
    expect(systemMessages[1]?.content).toBe(hostBase);
  });
});
