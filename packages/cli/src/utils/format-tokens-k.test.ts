import { describe, expect, test } from "bun:test";
import { formatTokensK } from "./format-tokens-k";

describe("formatTokensK", () => {
  test("0 与非法值为 0k", () => {
    expect(formatTokensK(0)).toBe("0k");
    expect(formatTokensK(-1)).toBe("0k");
    expect(formatTokensK(Number.NaN)).toBe("0k");
  });

  test("以 k 为单位，最多 3 位小数并去尾 0", () => {
    expect(formatTokensK(1000)).toBe("1k");
    expect(formatTokensK(6172)).toBe("6.172k");
    expect(formatTokensK(1)).toBe("0.001k");
    expect(formatTokensK(500)).toBe("0.5k");
  });
});
