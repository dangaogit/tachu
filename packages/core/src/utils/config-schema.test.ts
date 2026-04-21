import { describe, expect, test } from "bun:test";
import { ValidationError } from "../errors";
import { createDefaultEngineConfig, validateEngineConfig } from "./config-schema";

describe("validateEngineConfig", () => {
  test("returns defaults when undefined", () => {
    const config = validateEngineConfig(undefined);
    expect(config.runtime.maxConcurrency).toBeGreaterThan(0);
    expect(config.runtime.streamingOutput).toBe(true);
  });

  test("throws on invalid config", () => {
    expect(() =>
      validateEngineConfig({
        runtime: {
          maxConcurrency: 0,
        },
      }),
    ).toThrow();
  });

  test("accepts valid partial config and merges defaults", () => {
    const config = validateEngineConfig({
      runtime: { maxConcurrency: 8, failFast: true },
      models: {
        capabilityMapping: {
          intent: { provider: "noop", model: "dev-medium" },
        },
      },
    });
    expect(config.runtime.maxConcurrency).toBe(8);
    expect(config.runtime.failFast).toBe(true);
    expect(config.memory.contextTokenLimit).toBeGreaterThan(0);
  });

  test("throws typed ValidationError for invalid field type", () => {
    expect(() =>
      validateEngineConfig({
        safety: {
          promptInjectionPatterns: "invalid",
        },
      }),
    ).toThrow(ValidationError);
  });

  test("creates deep-cloned default config", () => {
    const a = createDefaultEngineConfig();
    const b = createDefaultEngineConfig();
    a.registry.descriptorPaths.push("changed");
    expect(b.registry.descriptorPaths.includes("changed")).toBe(false);
  });

  test("accepts providers block with partial fields", () => {
    const config = validateEngineConfig({
      providers: {
        openai: {
          apiKey: "sk-test",
          baseURL: "https://gateway.example.com/v1",
          organization: "org-abc",
          timeoutMs: 45_000,
        },
        anthropic: {
          baseURL: "https://gateway.example.com/anthropic",
        },
      },
    });
    expect(config.providers?.openai?.apiKey).toBe("sk-test");
    expect(config.providers?.openai?.baseURL).toBe("https://gateway.example.com/v1");
    expect(config.providers?.openai?.organization).toBe("org-abc");
    expect(config.providers?.openai?.timeoutMs).toBe(45_000);
    expect(config.providers?.anthropic?.baseURL).toBe(
      "https://gateway.example.com/anthropic",
    );
  });

  test("omits providers field when not supplied", () => {
    const config = validateEngineConfig({});
    expect(config.providers).toBeUndefined();
  });

  test("safety.allowedWriteRoots 默认空数组", () => {
    const config = validateEngineConfig({});
    expect(config.safety.allowedWriteRoots).toEqual([]);
  });

  test("safety.allowedWriteRoots 接受字符串数组并原样透传", () => {
    const config = validateEngineConfig({
      safety: { allowedWriteRoots: ["/opt/tachu-scratch", "./shared"] },
    });
    expect(config.safety.allowedWriteRoots).toEqual([
      "/opt/tachu-scratch",
      "./shared",
    ]);
  });

  test("safety.allowedWriteRoots 类型错误抛 ValidationError", () => {
    expect(() =>
      validateEngineConfig({
        safety: { allowedWriteRoots: "not-an-array" },
      }),
    ).toThrow(ValidationError);
  });

  test("rejects providers with wrong value types", () => {
    expect(() =>
      validateEngineConfig({
        providers: {
          openai: { baseURL: 123 },
        },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        providers: {
          openai: { timeoutMs: 0 },
        },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        providers: "not-an-object",
      }),
    ).toThrow(ValidationError);
  });

  test("preserves extra passthrough object", () => {
    const config = validateEngineConfig({
      providers: {
        openai: {
          extra: { defaultQuery: { foo: "bar" } },
        },
      },
    });
    expect(config.providers?.openai?.extra).toEqual({ defaultQuery: { foo: "bar" } });
  });

  test("runtime.toolLoop: 默认值回填（ADR-0002）", () => {
    const config = validateEngineConfig({});
    expect(config.runtime.toolLoop).toBeDefined();
    expect(config.runtime.toolLoop?.maxSteps).toBe(8);
    expect(config.runtime.toolLoop?.parallelism).toBe(4);
    expect(config.runtime.toolLoop?.requireApprovalGlobal).toBe(false);
  });

  test("runtime.toolLoop: 部分字段覆盖保留默认其余字段", () => {
    const config = validateEngineConfig({
      runtime: { toolLoop: { maxSteps: 12 } },
    });
    expect(config.runtime.toolLoop?.maxSteps).toBe(12);
    expect(config.runtime.toolLoop?.parallelism).toBe(4);
    expect(config.runtime.toolLoop?.requireApprovalGlobal).toBe(false);
  });

  test("runtime.toolLoop: 违反区间限制抛 ValidationError", () => {
    expect(() =>
      validateEngineConfig({
        runtime: { toolLoop: { maxSteps: 0 } },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        runtime: { toolLoop: { maxSteps: 100 } },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        runtime: { toolLoop: { parallelism: 0 } },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        runtime: { toolLoop: { parallelism: 32 } },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEngineConfig({
        runtime: { toolLoop: { requireApprovalGlobal: "yes" } },
      }),
    ).toThrow(ValidationError);
  });

  test("runtime.toolLoop: null / undefined 均兜底为默认对象", () => {
    const withNull = validateEngineConfig({ runtime: { toolLoop: null } });
    expect(withNull.runtime.toolLoop?.maxSteps).toBe(8);
    const withUndef = validateEngineConfig({ runtime: {} });
    expect(withUndef.runtime.toolLoop?.parallelism).toBe(4);
  });

  describe("mcpServers", () => {
    test("未指定时字段省略（保持向后兼容）", () => {
      const config = validateEngineConfig({});
      expect(config.mcpServers).toBeUndefined();
    });

    test("stdio：最小合法形态", () => {
      const config = validateEngineConfig({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      });
      expect(config.mcpServers?.fs?.command).toBe("npx");
      expect(config.mcpServers?.fs?.args).toEqual([
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp",
      ]);
    });

    test("sse：最小合法形态 + headers 透传", () => {
      const config = validateEngineConfig({
        mcpServers: {
          remoteKb: {
            url: "https://mcp.example.com/sse/",
            headers: { Authorization: "Bearer x" },
            timeoutMs: 50_000,
          },
        },
      });
      expect(config.mcpServers?.remoteKb?.url).toBe(
        "https://mcp.example.com/sse/",
      );
      expect(config.mcpServers?.remoteKb?.headers?.Authorization).toBe("Bearer x");
      expect(config.mcpServers?.remoteKb?.timeoutMs).toBe(50_000);
    });

    test("stdio 缺 command 抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: { fs: { args: ["--help"] } },
        }),
      ).toThrow(ValidationError);
    });

    test("sse 缺 url 抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: { remoteKb: { transport: "sse", headers: {} } },
        }),
      ).toThrow(ValidationError);
    });

    test("非法 url 抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: { remoteKb: { url: "not-a-url" } },
        }),
      ).toThrow(ValidationError);
    });

    test("非法 serverId（含空格）抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: { "remote kb": { url: "http://x.test/sse" } },
        }),
      ).toThrow(ValidationError);
    });

    test("transport 非 stdio | sse 抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            fs: {
              command: "echo",
              transport: "websocket",
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("env / headers 非字符串 value 抛 ValidationError", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            fs: { command: "echo", env: { A: 1 } },
          },
        }),
      ).toThrow(ValidationError);
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            remoteKb: { url: "http://x.test/sse", headers: { X: null } },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("disabled / allowTools / denyTools / tags / requiresApproval 全量字段透传", () => {
      const config = validateEngineConfig({
        mcpServers: {
          remoteKb: {
            url: "https://mcp.example.com/sse/",
            disabled: false,
            allowTools: ["read_resource"],
            denyTools: ["danger"],
            tags: ["example"],
            requiresApproval: true,
            timeoutMs: 0,
            connectTimeoutMs: 5_000,
          },
        },
      });
      expect(config.mcpServers?.remoteKb?.disabled).toBe(false);
      expect(config.mcpServers?.remoteKb?.allowTools).toEqual(["read_resource"]);
      expect(config.mcpServers?.remoteKb?.denyTools).toEqual(["danger"]);
      expect(config.mcpServers?.remoteKb?.tags).toEqual(["example"]);
      expect(config.mcpServers?.remoteKb?.requiresApproval).toBe(true);
      expect(config.mcpServers?.remoteKb?.timeoutMs).toBe(0);
      expect(config.mcpServers?.remoteKb?.connectTimeoutMs).toBe(5_000);
    });

    test("description / keywords / expandOnKeywordMatch 合法组合透传", () => {
      const config = validateEngineConfig({
        mcpServers: {
          remoteKb: {
            url: "https://mcp.example.com/sse/",
            description: "项目文档检索示例接口",
            keywords: ["文档", "docs"],
            expandOnKeywordMatch: true,
          },
        },
      });
      expect(config.mcpServers?.remoteKb?.description).toBe("项目文档检索示例接口");
      expect(config.mcpServers?.remoteKb?.keywords).toEqual(["文档", "docs"]);
      expect(config.mcpServers?.remoteKb?.expandOnKeywordMatch).toBe(true);
    });

    test("expandOnKeywordMatch=true 但 keywords 缺失或为空时必须抛错", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            remoteKb: {
              url: "https://mcp.example.com/sse/",
              expandOnKeywordMatch: true,
            },
          },
        }),
      ).toThrow(ValidationError);
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            remoteKb: {
              url: "https://mcp.example.com/sse/",
              expandOnKeywordMatch: true,
              keywords: [],
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("description 非字符串 / keywords 非字符串数组必须抛错", () => {
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            remoteKb: { url: "http://x.test/sse", description: 123 },
          },
        }),
      ).toThrow(ValidationError);
      expect(() =>
        validateEngineConfig({
          mcpServers: {
            remoteKb: { url: "http://x.test/sse", keywords: [1, 2] },
          },
        }),
      ).toThrow(ValidationError);
    });
  });
});

