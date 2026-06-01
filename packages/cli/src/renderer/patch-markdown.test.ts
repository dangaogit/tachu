import { describe, expect, it } from "bun:test";
import { patchMarkdown } from "./patch-markdown";

describe("patchMarkdown", () => {
  it("空字符串不变", () => {
    expect(patchMarkdown("")).toBe("");
  });

  it("奇数个 fence 时补闭合", () => {
    const src = "```ts\nconst x = 1";
    const out = patchMarkdown(src);
    expect(out.includes("const x = 1")).toBe(true);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("已闭合 fence 不重复追加", () => {
    const src = "```\nok\n```";
    expect(patchMarkdown(src)).toBe(src);
  });

  it("fence 外奇数个 ** 补全", () => {
    expect(patchMarkdown("hello **world")).toBe("hello **world**");
  });

  it("fence 内不补 **", () => {
    const src = "```\na ** b\n";
    const out = patchMarkdown(src);
    expect(out).toContain("a ** b");
  });

  it("fence 外 __ 补全", () => {
    expect(patchMarkdown("__x")).toBe("__x__");
  });
});
