import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DefaultObservabilityEmitter, type EngineEvent, type McpToolAdapter, type ToolDescriptor } from "@tachu/core";
import type { McpExecuteToolOptions, McpTransport } from "@tachu/core";
import type { ToolExecutionContext } from "@tachu/extensions";
import { buildNamespacedName, matchesKeywords, mountMcpServers } from "./mount";

/**
 * In-memory McpToolAdapter mock：不触达网络 / 子进程，按注入 spec 返回固定 tools，
 * 并记录 executeTool 的调用。
 */
interface MockAdapterSpec {
  tools: ToolDescriptor[];
  /** 在 connect 时主动抛错（模拟连接失败） */
  connectError?: Error;
  /** connect 之前 sleep 的毫秒数（模拟慢连接用于超时测试） */
  connectDelayMs?: number;
  /** executeTool 被调用时返回的值（默认 `{ ok: true, tool: name }`） */
  executeReturn?: unknown;
  /** executeTool 被调用时抛错 */
  executeError?: Error;
}

class MockMcpAdapter implements McpToolAdapter {
  readonly transport: McpTransport;
  readonly serverId: string;
  private readonly spec: MockAdapterSpec;
  connectedTo = "";
  disconnectCount = 0;
  readonly executeCalls: Array<{
    name: string;
    input: unknown;
    options: McpExecuteToolOptions | undefined;
  }> = [];

  constructor(
    serverId: string,
    transport: MockMcpAdapter["transport"],
    spec: MockAdapterSpec,
  ) {
    this.serverId = serverId;
    this.transport = transport;
    this.spec = spec;
  }

  async connect(serverUri: string): Promise<void> {
    if (this.spec.connectDelayMs && this.spec.connectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.spec.connectDelayMs));
    }
    if (this.spec.connectError) {
      throw this.spec.connectError;
    }
    this.connectedTo = serverUri;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return this.spec.tools;
  }

  async executeTool(
    name: string,
    input: unknown,
    options?: McpExecuteToolOptions,
  ): Promise<unknown> {
    this.executeCalls.push({ name, input, options });
    if (this.spec.executeError) {
      throw this.spec.executeError;
    }
    return this.spec.executeReturn ?? { ok: true, tool: name };
  }

  async cancel(_requestId: string): Promise<void> {
    // noop
  }
}

const makeTool = (name: string, extras?: Partial<ToolDescriptor>): ToolDescriptor => ({
  kind: "tool",
  name,
  description: `mock tool ${name}`,
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 30_000,
  inputSchema: { type: "object", properties: {} },
  execute: `mcp:__mock__:${name}`,
  ...(extras ?? {}),
});

const makeExecContext = (signal = new AbortController().signal): ToolExecutionContext => ({
  abortSignal: signal,
  workspaceRoot: "/tmp/tachu-ws",
  allowedRoots: ["/tmp/tachu-ws"],
  sandboxWaived: false,
  session: {
    id: "sess-mcp",
    status: "active",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  },
});

describe("mountMcpServers — 装配 + 命名 + 过滤", () => {
  it("stdio 最小形态：工具以 namespaced 名字进入 descriptors 与 executors", async () => {
    const mock = new MockMcpAdapter("fs", "stdio", {
      tools: [makeTool("read_resource"), makeTool("write_resource")],
    });
    const mounted = await mountMcpServers(
      {
        fs: { command: "bunx", args: ["--version"] },
      },
      {
        cwd: "/tmp/tachu-ws",
        adapterFactory: () => mock,
      },
    );

    expect(mounted.servers).toHaveLength(1);
    expect(mounted.servers[0]?.status).toBe("ok");
    expect(mounted.servers[0]?.toolsRegistered).toBe(2);
    expect(mounted.descriptors.map((d) => d.name)).toEqual([
      buildNamespacedName("fs", "read_resource"),
      buildNamespacedName("fs", "write_resource"),
    ]);
    expect(Object.keys(mounted.executors)).toEqual([
      buildNamespacedName("fs", "read_resource"),
      buildNamespacedName("fs", "write_resource"),
    ]);
    // execute 字段保留 `mcp:<serverId>:<origName>` 便于观测
    expect(mounted.descriptors[0]?.execute).toBe("mcp:fs:read_resource");
    await mounted.disconnectAll();
    expect(mock.disconnectCount).toBe(1);
  });

  it("sse 用户场景：remoteKb 配置按 SSE transport 装配，headers + timeoutMs 透传", async () => {
    let captured:
      | {
          serverId: string;
          transport: string;
          headers: Record<string, string> | undefined;
          timeoutMs: number;
        }
      | undefined;
    const mock = new MockMcpAdapter("remoteKb", "sse", {
      tools: [makeTool("getStatus")],
    });
    const mounted = await mountMcpServers(
      {
        remoteKb: {
          url: "https://mcp.example.com/sse/",
          headers: { "X-Token": "abc" },
          timeoutMs: 50_000,
        },
      },
      {
        cwd: "/tmp/tachu-ws",
        adapterFactory: (serverId, transport, config) => {
          captured = {
            serverId,
            transport,
            headers: config.headers,
            timeoutMs: config.timeoutMs,
          };
          return mock;
        },
      },
    );
    expect(captured?.serverId).toBe("remoteKb");
    expect(captured?.transport).toBe("sse");
    expect(captured?.headers?.["X-Token"]).toBe("abc");
    expect(captured?.timeoutMs).toBe(50_000);
    expect(mounted.servers[0]?.status).toBe("ok");
    expect(mock.connectedTo).toBe("https://mcp.example.com/sse/");
    await mounted.disconnectAll();
  });

  it("disabled=true 的 server 直接跳过，不实例化 adapter，也不计入 executors", async () => {
    let factoryCalled = 0;
    const mounted = await mountMcpServers(
      {
        fs: { command: "echo", disabled: true },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => {
          factoryCalled += 1;
          return new MockMcpAdapter("fs", "stdio", { tools: [] });
        },
      },
    );
    expect(factoryCalled).toBe(0);
    expect(mounted.servers[0]?.status).toBe("disabled");
    expect(mounted.descriptors).toHaveLength(0);
    expect(Object.keys(mounted.executors)).toHaveLength(0);
  });

  it("allowTools / denyTools 生效，且 server 级 requiresApproval 会 OR 到所有工具", async () => {
    const mock = new MockMcpAdapter("fs", "stdio", {
      tools: [
        makeTool("read"),
        makeTool("write", { requiresApproval: false }),
        makeTool("danger", { sideEffect: "irreversible" }),
      ],
    });
    const mounted = await mountMcpServers(
      {
        fs: {
          command: "echo",
          allowTools: ["read", "write"],
          denyTools: ["danger"],
          requiresApproval: true,
          tags: ["example"],
        },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => mock,
      },
    );
    expect(mounted.descriptors.map((d) => d.name)).toEqual([
      buildNamespacedName("fs", "read"),
      buildNamespacedName("fs", "write"),
    ]);
    for (const d of mounted.descriptors) {
      expect(d.requiresApproval).toBe(true);
      expect(d.tags).toContain("example");
      expect(d.tags).toContain("mcp:fs");
    }
  });

  it("连接失败：标记 status=failed，adapter 被调用 disconnect 做回收，emit warning", async () => {
    const events: EngineEvent[] = [];
    const obs = new DefaultObservabilityEmitter();
    obs.on("warning", (e) => events.push(e));

    const mock = new MockMcpAdapter("fs", "stdio", {
      tools: [],
      connectError: new Error("boom"),
    });
    const mounted = await mountMcpServers(
      {
        fs: { command: "echo" },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => mock,
        observability: obs,
      },
    );
    expect(mounted.servers[0]?.status).toBe("failed");
    expect(mounted.servers[0]?.error).toContain("boom");
    expect(mounted.descriptors).toHaveLength(0);
    expect(mock.disconnectCount).toBe(1);
    expect(events.some((e) => (e.payload as { message?: string }).message?.includes("连接 MCP server fs 失败"))).toBe(true);
  });

  it("连接超时：connectTimeoutMs 到期即被计为失败", async () => {
    const mock = new MockMcpAdapter("remoteKb", "sse", {
      tools: [],
      connectDelayMs: 200,
    });
    const mounted = await mountMcpServers(
      {
        remoteKb: {
          url: "http://x.test/sse",
          connectTimeoutMs: 20,
        },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => mock,
      },
    );
    expect(mounted.servers[0]?.status).toBe("failed");
    expect(mounted.servers[0]?.error).toContain("连接超时");
  });

  it("executor wrapper 把 abortSignal / 原始工具名透传给 adapter", async () => {
    const mock = new MockMcpAdapter("fs", "stdio", {
      tools: [makeTool("read")],
      executeReturn: { content: "hello" },
    });
    const mounted = await mountMcpServers(
      {
        fs: { command: "echo" },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => mock,
      },
    );
    const name = buildNamespacedName("fs", "read");
    const executor = mounted.executors[name];
    expect(executor).toBeDefined();
    const ctrl = new AbortController();
    const result = await executor!({ path: "/a" }, makeExecContext(ctrl.signal));
    expect(result).toEqual({ content: "hello" });
    expect(mock.executeCalls).toHaveLength(1);
    expect(mock.executeCalls[0]?.name).toBe("read");
    expect(mock.executeCalls[0]?.input).toEqual({ path: "/a" });
    expect(mock.executeCalls[0]?.options?.signal).toBe(ctrl.signal);
    expect(typeof mock.executeCalls[0]?.options?.requestId).toBe("string");
  });

  it("executor wrapper 在 adapter 抛错时包上 namespaced name 以便定位", async () => {
    const mock = new MockMcpAdapter("fs", "stdio", {
      tools: [makeTool("read")],
      executeError: new Error("upstream 500"),
    });
    const mounted = await mountMcpServers(
      {
        fs: { command: "echo" },
      },
      {
        cwd: "/tmp",
        adapterFactory: () => mock,
      },
    );
    const executor = mounted.executors[buildNamespacedName("fs", "read")]!;
    await expect(executor({}, makeExecContext())).rejects.toThrow(/fs__read/);
    await expect(executor({}, makeExecContext())).rejects.toThrow(/upstream 500/);
  });

  it("stdio.cwd 相对路径按宿主 cwd 展开为绝对路径", async () => {
    let seenCwd: string | undefined;
    const mock = new MockMcpAdapter("fs", "stdio", { tools: [] });
    await mountMcpServers(
      {
        fs: { command: "echo", cwd: "./sub" },
      },
      {
        cwd: "/work/root",
        adapterFactory: (_id, _t, cfg) => {
          seenCwd = cfg.cwd;
          return mock;
        },
      },
    );
    expect(seenCwd).toBe("/work/root/sub");
  });

  it("transport 显式声明时优先级最高，即使出现 command + url 也不推断为 sse", async () => {
    let seen: { transport: string } | undefined;
    const mock = new MockMcpAdapter("fs", "stdio", { tools: [] });
    await mountMcpServers(
      {
        fs: {
          command: "echo",
          url: "http://x.test/sse",
          transport: "stdio",
        },
      },
      {
        cwd: "/tmp",
        adapterFactory: (_id, transport) => {
          seen = { transport };
          return mock;
        },
      },
    );
    expect(seen?.transport).toBe("stdio");
  });

  it("disconnectAll 幂等：多次调用只断一次", async () => {
    const mock = new MockMcpAdapter("fs", "stdio", { tools: [] });
    const mounted = await mountMcpServers(
      { fs: { command: "echo" } },
      { cwd: "/tmp", adapterFactory: () => mock },
    );
    await mounted.disconnectAll();
    await mounted.disconnectAll();
    await mounted.disconnectAll();
    expect(mock.disconnectCount).toBe(1);
  });

  it("空 mcpServers 不触发任何 adapter 工厂调用", async () => {
    let factoryCalled = 0;
    const mountedUndef = await mountMcpServers(undefined, {
      cwd: "/tmp",
      adapterFactory: () => {
        factoryCalled += 1;
        return new MockMcpAdapter("x", "stdio", { tools: [] });
      },
    });
    const mountedEmpty = await mountMcpServers({}, {
      cwd: "/tmp",
      adapterFactory: () => {
        factoryCalled += 1;
        return new MockMcpAdapter("x", "stdio", { tools: [] });
      },
    });
    expect(factoryCalled).toBe(0);
    expect(mountedUndef.servers).toHaveLength(0);
    expect(mountedEmpty.servers).toHaveLength(0);
  });

  describe("setup redirects warnings when observability disabled", () => {
    // 保证 emitWarning 走 console.warn 分支但不污染其他测试。
    let originalWarn = console.warn;
    const warnings: string[] = [];
    beforeEach(() => {
      originalWarn = console.warn;
      warnings.length = 0;
      console.warn = (...args: unknown[]): void => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
    });
    afterEach(() => {
      console.warn = originalWarn;
    });

    it("未注入 observability 时失败写到 console.warn", async () => {
      const mock = new MockMcpAdapter("fs", "stdio", {
        tools: [],
        connectError: new Error("no route"),
      });
      await mountMcpServers(
        { fs: { command: "echo" } },
        { cwd: "/tmp", adapterFactory: () => mock },
      );
      expect(warnings.some((w) => w.includes("连接 MCP server fs 失败"))).toBe(true);
    });
  });

  describe("description / keywords / 惰性装配", () => {
    it("description 非空时会作为前缀拼进每个工具的 description，便于 LLM 路由", async () => {
      const mock = new MockMcpAdapter("remoteKb", "sse", {
        tools: [makeTool("getStatus", { description: "查询服务状态" })],
      });
      const mounted = await mountMcpServers(
        {
          remoteKb: {
            url: "http://x.test/sse",
            description: "项目文档检索示例接口",
          },
        },
        { cwd: "/tmp", adapterFactory: () => mock },
      );
      expect(mounted.descriptors[0]?.description).toContain(
        "[remoteKb: 项目文档检索示例接口]",
      );
      expect(mounted.descriptors[0]?.description).toContain("查询服务状态");
      expect(mounted.servers[0]?.description).toBe("项目文档检索示例接口");
      expect(mounted.servers[0]?.gated).toBe(false);
    });

    it("expandOnKeywordMatch=true：装配阶段不会把工具放进常驻 descriptors，而是写入 gatedGroups", async () => {
      const mock = new MockMcpAdapter("remoteKb", "sse", {
        tools: [makeTool("listDocs"), makeTool("readDoc")],
      });
      const mounted = await mountMcpServers(
        {
          remoteKb: {
            url: "http://x.test/sse",
            keywords: ["文档", "docs"],
            expandOnKeywordMatch: true,
          },
        },
        { cwd: "/tmp", adapterFactory: () => mock },
      );
      // 常驻 descriptors 空；gated 组里拿到 2 个
      expect(mounted.descriptors).toHaveLength(0);
      expect(mounted.gatedGroups).toHaveLength(1);
      expect(mounted.gatedGroups[0]?.serverId).toBe("remoteKb");
      expect(mounted.gatedGroups[0]?.keywords).toEqual(["文档", "docs"]);
      expect(mounted.gatedGroups[0]?.descriptors.map((d) => d.name)).toEqual([
        buildNamespacedName("remoteKb", "listDocs"),
        buildNamespacedName("remoteKb", "readDoc"),
      ]);
      // executor 仍然全量挂载（方便引擎侧合并），gating 只控制 registry 可见性
      expect(Object.keys(mounted.executors)).toHaveLength(2);
      // summary 正确标记
      expect(mounted.servers[0]?.gated).toBe(true);
      expect(mounted.servers[0]?.keywords).toEqual(["文档", "docs"]);
    });

    it("expandOnKeywordMatch=true 但 keywords 为空（绕过 schema）时按常驻逻辑回退", async () => {
      // 实际上 schema 会拦住这种组合；这里构造 raw 对象直接走 mount，验证防御分支
      const mock = new MockMcpAdapter("fs", "stdio", {
        tools: [makeTool("read")],
      });
      const mounted = await mountMcpServers(
        {
          // deliberately bypass schema to exercise mount's defensive branch
          fs: {
            command: "echo",
            expandOnKeywordMatch: true,
          } as unknown as import("@tachu/core").McpServerConfig,
        },
        { cwd: "/tmp", adapterFactory: () => mock },
      );
      expect(mounted.descriptors).toHaveLength(1);
      expect(mounted.gatedGroups).toHaveLength(0);
      expect(mounted.servers[0]?.gated).toBe(false);
    });

    it("matchesKeywords 按子串大小写不敏感匹配，空 keywords 返回 false", () => {
      expect(matchesKeywords("2025 年的项目文档索引", ["文档"])).toBe(true);
      expect(matchesKeywords("Recent DOCS access", ["docs"])).toBe(true);
      expect(matchesKeywords("今天的销售数据", ["文档", "docs"])).toBe(false);
      expect(matchesKeywords("anything", [])).toBe(false);
      // 对结构化输入先 JSON.stringify 再匹配
      expect(
        matchesKeywords({ question: "查一下最新的项目文档数量" }, ["文档"]),
      ).toBe(true);
    });
  });
});
