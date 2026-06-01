import { describe, expect, it, afterEach } from "bun:test";
import { shouldUseInkCli, shouldUseInkForChat } from "./ink-features";

describe("shouldUseInkCli", () => {
  const prevInk = process.env.TACHU_INK;

  afterEach(() => {
    if (prevInk === undefined) {
      delete process.env.TACHU_INK;
    } else {
      process.env.TACHU_INK = prevInk;
    }
  });

  it("显式 ink=false（--no-ink）时关闭，不受 TACHU_INK=1 影响", () => {
    process.env.TACHU_INK = "1";
    expect(
      shouldUseInkCli({
        ink: false,
        noColor: false,
        planMode: false,
      }),
    ).toBe(false);
  });

  it("TACHU_INK=0 时关闭（默认开启可被环境覆盖）", () => {
    process.env.TACHU_INK = "0";
    expect(
      shouldUseInkCli({
        ink: true,
        noColor: false,
        planMode: false,
      }),
    ).toBe(false);
  });

  it("无 TACHU_INK 且 ink=true 时：仅 TTY 为 true", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkCli({
        ink: true,
        noColor: false,
        planMode: false,
      }),
    ).toBe(Boolean(process.stdout.isTTY));
  });

  it("plan-mode 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkCli({
        ink: true,
        noColor: false,
        planMode: true,
      }),
    ).toBe(false);
  });

  it("no-color 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkCli({
        ink: true,
        noColor: true,
        planMode: false,
      }),
    ).toBe(false);
  });
});

describe("shouldUseInkForChat", () => {
  const prevInk = process.env.TACHU_INK;

  afterEach(() => {
    if (prevInk === undefined) {
      delete process.env.TACHU_INK;
    } else {
      process.env.TACHU_INK = prevInk;
    }
  });

  it("显式 readline 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkForChat({
        readline: true,
        noColor: false,
        planMode: false,
      }),
    ).toBe(false);
  });

  it("TACHU_INK=0 时关闭", () => {
    process.env.TACHU_INK = "0";
    expect(
      shouldUseInkForChat({
        readline: false,
        noColor: false,
        planMode: false,
      }),
    ).toBe(false);
  });

  it("plan-mode 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkForChat({
        readline: false,
        noColor: false,
        planMode: true,
      }),
    ).toBe(false);
  });

  it("no-color 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkForChat({
        readline: false,
        noColor: true,
        planMode: false,
      }),
    ).toBe(false);
  });

  it("无 TTY 时关闭", () => {
    delete process.env.TACHU_INK;
    expect(
      shouldUseInkForChat({
        readline: false,
        noColor: false,
        planMode: false,
      }),
    ).toBe(Boolean(process.stdout.isTTY));
  });
});
