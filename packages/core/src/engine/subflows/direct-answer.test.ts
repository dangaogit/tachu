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

  test("显式禁止空头承诺（我将/请稍等/I'll fetch）", () => {
    expect(prompt).toContain("禁止空头承诺");
    expect(prompt).toContain("请稍等");
    expect(prompt).toMatch(/I'?ll\s+(fetch|check|look)/i);
  });

  test("显式禁止伪装已执行动作（我已经抓取 / 我刚才打开）", () => {
    expect(prompt).toContain("禁止伪装已经执行了动作");
    expect(prompt).toContain("我已经抓取");
  });

  test("给出无法真正执行时的三步兜底指引", () => {
    expect(prompt).toContain("本轮未匹配到对应工具");
    expect(prompt).toContain("不代表该 URL 的实时内容");
    expect(prompt).toContain("把网页正文");
  });

  test("保留 warn=true 的宿主提示分支", () => {
    expect(prompt).toContain("warn=true");
    expect(prompt).toContain("基于通用知识的建议回答");
  });

  test("保留 Markdown 与代码围栏格式约束", () => {
    expect(prompt).toContain("自然语言 + Markdown");
    expect(prompt).toContain("fenced 代码块");
  });
});
