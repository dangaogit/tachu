import { describe, expect, test } from "bun:test";
import { formatWallDisplay } from "./format-wall-display";

describe("formatWallDisplay", () => {
  test("毫秒段", () => {
    expect(formatWallDisplay(0)).toBe("0ms");
    expect(formatWallDisplay(1)).toBe("1ms");
    expect(formatWallDisplay(999)).toBe("999ms");
  });

  test("秒段（2 位小数，上限与分衔接）", () => {
    expect(formatWallDisplay(1000)).toBe("1.00s");
    expect(formatWallDisplay(1500)).toBe("1.50s");
    expect(formatWallDisplay(59999)).toBe("59.99s");
  });

  test("分秒段", () => {
    expect(formatWallDisplay(60_000)).toBe("1m0s");
    expect(formatWallDisplay(61_000)).toBe("1m1s");
    expect(formatWallDisplay(3_599_000)).toBe("59m59s");
  });

  test("时分段（≥60min）", () => {
    expect(formatWallDisplay(3_600_000)).toBe("1h0m");
    expect(formatWallDisplay(3_660_000)).toBe("1h1m");
    expect(formatWallDisplay(7_200_000)).toBe("2h0m");
  });
});
