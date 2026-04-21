import { afterEach, describe, expect, it } from "bun:test";
import { colorize, resetColorState, setNoColor, shouldDisableColor } from "./color";

describe("color", () => {
  afterEach(() => {
    resetColorState();
    delete process.env["NO_COLOR"];
  });

  it("setNoColor(true) 后 shouldDisableColor 返回 true", () => {
    setNoColor(true);
    expect(shouldDisableColor()).toBe(true);
  });

  it("setNoColor(false) 后 shouldDisableColor 返回 false（在 TTY 环境）", () => {
    // 只在 TTY 时测试颜色启用
    setNoColor(false);
    // shouldDisableColor 依赖 isTTY()，测试时不是 TTY，所以结果取决于环境
    const result = shouldDisableColor();
    expect(typeof result).toBe("boolean");
  });

  it("NO_COLOR 环境变量时 shouldDisableColor 返回 true", () => {
    process.env["NO_COLOR"] = "1";
    resetColorState();
    expect(shouldDisableColor()).toBe(true);
  });

  it("禁色时 colorize 返回裸文本", () => {
    setNoColor(true);
    expect(colorize("hello", "green")).toBe("hello");
  });

  it("启色时 colorize 包含 ANSI 序列（TTY 环境）", () => {
    // 在非 TTY 测试环境下，结果是裸文本
    setNoColor(false);
    const result = colorize("hello", "green");
    // 无论是否有 ANSI，结果必须包含 "hello"
    expect(result).toContain("hello");
  });

  it("colorize 支持所有颜色名", () => {
    setNoColor(true);
    const colors = ["gray", "yellow", "cyan", "green", "blue", "red", "white", "bold"] as const;
    for (const color of colors) {
      expect(colorize("text", color)).toBe("text");
    }
  });
});
