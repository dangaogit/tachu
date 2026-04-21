import { describe, expect, it } from "bun:test";
import { DescriptorRegistry, type McpToolAdapter, type ToolDescriptor } from "@tachu/core";
import type { McpExecuteToolOptions, McpTransport } from "@tachu/core";
import { setupMcpServersFromConfig } from "./setup";

/** 最小 mock adapter（参考 mount.test.ts 同款，简化为当前测试需要的字段）。 */
class MockMcpAdapter implements McpToolAdapter {
  transport: McpTransport;
  serverId: string;
  private readonly tools: ToolDescriptor[];
  connectedTo = "";
  disconnectCount = 0;
  constructor(serverId: string, transport: MockMcpAdapter["transport"], tools: ToolDescriptor[]) {
    this.serverId = serverId;
    this.transport = transport;
    this.tools = tools;
  }
  async connect(uri: string): Promise<void> {
    this.connectedTo = uri;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }
  async listTools(): Promise<ToolDescriptor[]> {
    return this.tools;
  }
  async executeTool(
    _name: string,
    _input: unknown,
    _options?: McpExecuteToolOptions,
  ): Promise<unknown> {
    return { ok: true };
  }
  async cancel(_requestId: string): Promise<void> {
    /* noop */
  }
}

const makeTool = (name: string, extras?: Partial<ToolDescriptor>): ToolDescriptor => ({
  kind: "tool",
  name,
  description: `mock ${name}`,
  sideEffect: "readonly",
  idempotent: true,
  requiresApproval: false,
  timeout: 30_000,
  inputSchema: { type: "object", properties: {} },
  execute: `mcp:remoteKb:${name}`,
  ...(extras ?? {}),
});

describe("setupMcpServersFromConfig — 惰性装配 activateForPrompt", () => {
  it("expandOnKeywordMatch=true 时常驻注册为空；命中 keywords 才激活工具", async () => {
    const registry = new DescriptorRegistry({});
    const mock = new MockMcpAdapter("remoteKb", "sse", [
      makeTool("listDocs"),
      makeTool("readDoc"),
    ]);
    const mounted = await setupMcpServersFromConfig(
      {
        mcpServers: {
          remoteKb: {
            url: "http://x.test/sse",
            description: "项目文档检索示例接口",
            keywords: ["文档"],
            expandOnKeywordMatch: true,
          },
        },
      },
      registry,
      { cwd: "/tmp", adapterFactory: () => mock },
    );

    // 初始未激活：registry 里看不到 remoteKb 的任何工具
    expect(registry.get("tool", "remoteKb__listDocs")).toBeNull();
    expect(registry.get("tool", "remoteKb__readDoc")).toBeNull();

    // 命中 keyword："2025 年的项目文档索引" 命中 "文档"
    const r1 = await mounted.activateForPrompt("2025 年的项目文档索引");
    expect(r1.activated).toEqual(["remoteKb__listDocs", "remoteKb__readDoc"]);
    expect(r1.deactivated).toEqual([]);
    expect(registry.get("tool", "remoteKb__listDocs")).not.toBeNull();
    expect(registry.get("tool", "remoteKb__readDoc")).not.toBeNull();

    // 再次命中同一组：幂等，无新增 activation
    const r2 = await mounted.activateForPrompt("查一下文档");
    expect(r2.activated).toEqual([]);
    expect(r2.deactivated).toEqual([]);

    // 不命中：注销该组工具
    const r3 = await mounted.activateForPrompt("今天的销售情况");
    expect(r3.activated).toEqual([]);
    expect(r3.deactivated).toEqual([
      "remoteKb__listDocs",
      "remoteKb__readDoc",
    ]);
    expect(registry.get("tool", "remoteKb__listDocs")).toBeNull();

    await mounted.disconnectAll();
  });

  it("未启用惰性装配的 server 按常驻注册；activateForPrompt 不会影响它们", async () => {
    const registry = new DescriptorRegistry({});
    const mock = new MockMcpAdapter("fs", "stdio", [makeTool("read_resource")]);
    const mounted = await setupMcpServersFromConfig(
      { mcpServers: { fs: { command: "echo" } } },
      registry,
      { cwd: "/tmp", adapterFactory: () => mock },
    );

    // 常驻注册
    expect(registry.get("tool", "fs__read_resource")).not.toBeNull();
    // 无论 prompt 如何，常驻工具保持可见
    const r = await mounted.activateForPrompt("anything");
    expect(r.activated).toEqual([]);
    expect(r.deactivated).toEqual([]);
    expect(registry.get("tool", "fs__read_resource")).not.toBeNull();
  });

  it("hooks.onGroupEvaluated 能观察到每组的命中/工具计数", async () => {
    const registry = new DescriptorRegistry({});
    const mock = new MockMcpAdapter("remoteKb", "sse", [makeTool("listDocs")]);
    const mounted = await setupMcpServersFromConfig(
      {
        mcpServers: {
          remoteKb: {
            url: "http://x.test/sse",
            keywords: ["文档"],
            expandOnKeywordMatch: true,
          },
        },
      },
      registry,
      { cwd: "/tmp", adapterFactory: () => mock },
    );
    const events: Array<{ serverId: string; matched: boolean; activatedCount: number }> = [];
    await mounted.activateForPrompt("2025 文档统计", {
      onGroupEvaluated: (evt) =>
        events.push({
          serverId: evt.serverId,
          matched: evt.matched,
          activatedCount: evt.activatedCount,
        }),
    });
    expect(events).toEqual([
      { serverId: "remoteKb", matched: true, activatedCount: 1 },
    ]);
  });
});
