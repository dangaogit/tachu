import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, mergeConfig } from "./config-file";
import { createDefaultEngineConfig } from "@tachu/core";

let tmpDir: string;

describe("mergeConfig", () => {
  it("基础配置覆盖", () => {
    const base = createDefaultEngineConfig();
    const result = mergeConfig(base, {
      budget: { maxTokens: 99999, maxToolCalls: 10, maxWallTimeMs: 1000 },
    });
    expect(result.budget.maxTokens).toBe(99999);
    expect(result.budget.maxToolCalls).toBe(10);
    // 其他字段不受影响
    expect(result.runtime.maxConcurrency).toBe(base.runtime.maxConcurrency);
  });

  it("嵌套对象合并", () => {
    const base = createDefaultEngineConfig();
    const result = mergeConfig(base, {
      safety: { maxInputSizeBytes: 1024, maxRecursionDepth: 5, workspaceRoot: "/tmp", promptInjectionPatterns: [] },
    });
    expect(result.safety.maxInputSizeBytes).toBe(1024);
    expect(result.safety.maxRecursionDepth).toBe(5);
  });

  it("未指定字段保留原值", () => {
    const base = createDefaultEngineConfig();
    const result = mergeConfig(base, {});
    expect(result.runtime.maxConcurrency).toBe(base.runtime.maxConcurrency);
    expect(result.memory.contextTokenLimit).toBe(base.memory.contextTokenLimit);
  });
});

describe("loadConfig", () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("不存在配置文件时返回默认配置", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-load-"));
    const config = await loadConfig(tmpDir);
    expect(config.runtime).toBeDefined();
    expect(config.budget).toBeDefined();
  });

  it("存在配置文件时能加载（TS 格式）", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tachu-load-"));
    const configContent = `
import type { EngineConfig } from '@tachu/core';
const config: Partial<EngineConfig> = {
  budget: { maxTokens: 12345, maxToolCalls: 5, maxWallTimeMs: 1000 }
};
export default config;
`;
    await writeFile(join(tmpDir, "tachu.config.ts"), configContent, "utf8");
    const config = await loadConfig(tmpDir);
    expect(config.budget.maxTokens).toBe(12345);
  });
});
