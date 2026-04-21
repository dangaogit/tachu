import { describe, expect, it } from "bun:test";
import {
  CliError,
  CliArgumentError,
  ConfigLoadError,
  DescriptorScanError,
  SessionStoreError,
  formatError,
} from "./errors";
import { EngineError } from "@tachu/core";

describe("CliError", () => {
  it("继承自 EngineError", () => {
    const err = new ConfigLoadError("test");
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toBeInstanceOf(CliError);
  });

  it("ConfigLoadError 有正确 code", () => {
    const err = new ConfigLoadError("failed");
    expect(err.code).toBe("CLI_CONFIG_LOAD_ERROR");
    expect(err.message).toBe("failed");
  });

  it("DescriptorScanError 带 cause", () => {
    const cause = new Error("原始错误");
    const err = new DescriptorScanError("scan failed", cause);
    expect(err.code).toBe("CLI_DESCRIPTOR_SCAN_ERROR");
    expect(err.cause).toBe(cause);
  });

  it("SessionStoreError 有正确 code", () => {
    const err = new SessionStoreError("store error");
    expect(err.code).toBe("CLI_SESSION_STORE_ERROR");
  });

  it("CliArgumentError 有正确 code", () => {
    const err = new CliArgumentError("bad arg");
    expect(err.code).toBe("CLI_ARGUMENT_ERROR");
  });
});

describe("formatError", () => {
  it("EngineError 格式化为 [code] message", () => {
    const err = new ConfigLoadError("load error");
    expect(formatError(err)).toBe("[CLI_CONFIG_LOAD_ERROR] load error");
  });

  it("普通 Error 返回 message", () => {
    const err = new Error("plain error");
    expect(formatError(err)).toBe("plain error");
  });

  it("字符串返回自身", () => {
    expect(formatError("string error")).toBe("string error");
  });

  it("数字转为字符串", () => {
    expect(formatError(42)).toBe("42");
  });
});
