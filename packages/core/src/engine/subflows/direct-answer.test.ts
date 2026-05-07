import { describe, expect, test } from "bun:test";

import { DIRECT_ANSWER_CONSTANTS } from "./direct-answer";

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
