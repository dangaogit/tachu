import { describe, expect, it } from "bun:test";
import { isTTY, isStdinTTY, isStderrTTY, terminalWidth } from "./tty";

describe("tty utils", () => {
  it("isTTY 返回布尔值", () => {
    expect(typeof isTTY()).toBe("boolean");
  });

  it("isStdinTTY 返回布尔值", () => {
    expect(typeof isStdinTTY()).toBe("boolean");
  });

  it("isStderrTTY 返回布尔值", () => {
    expect(typeof isStderrTTY()).toBe("boolean");
  });

  it("terminalWidth 返回正整数", () => {
    const width = terminalWidth();
    expect(width).toBeGreaterThan(0);
    expect(Number.isInteger(width)).toBe(true);
  });

  it("terminalWidth 非 TTY 时返回 80", () => {
    const original = process.stdout.columns;
    try {
      // @ts-expect-error 测试用
      process.stdout.columns = undefined;
      expect(terminalWidth()).toBe(80);
    } finally {
      process.stdout.columns = original;
    }
  });
});
