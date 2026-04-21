import { describe, expect, it } from "bun:test";
import { takeTailLines } from "./windowed-text";

describe("takeTailLines", () => {
  it("保留末尾 N 行", () => {
    const s = "a\nb\nc\nd\ne";
    expect(takeTailLines(s, 2)).toBe("d\ne");
  });

  it("行数不足时原样返回", () => {
    expect(takeTailLines("a\nb", 10)).toBe("a\nb");
  });

  it("maxLines 为 0 返回空", () => {
    expect(takeTailLines("a\nb", 0)).toBe("");
  });
});
