import { describe, expect, it } from "bun:test";
import { McpSseAdapter } from "../../src/mcp/sse-adapter";
import { McpStdioAdapter } from "../../src/mcp/stdio-adapter";

type PendingClient = {
  listTools: () => Promise<{
    tools: Array<{
      name: string;
      description?: string;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
      };
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
  }>;
  callTool: (
    request: { name: string; arguments: Record<string, unknown> },
    _meta?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

const injectClient = (adapter: object, client: PendingClient): void => {
  (adapter as { client: PendingClient }).client = client;
};

const createPendingClient = (): {
  client: PendingClient;
  seenSignals: AbortSignal[];
  seenArguments: Array<{ name: string; arguments: Record<string, unknown> }>;
} => {
  const seenSignals: AbortSignal[] = [];
  const seenArguments: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  return {
    seenSignals,
    seenArguments,
    client: {
      async listTools() {
        return {
          tools: [
            {
              name: "read_resource",
              description: "read",
              annotations: { readOnlyHint: true, idempotentHint: true },
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          ],
        };
      },
      callTool(request, _meta, options) {
        seenArguments.push(request);
        const signal = options?.signal;
        if (!signal) {
          return Promise.resolve({ ok: true });
        }
        seenSignals.push(signal);
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
          setTimeout(() => resolve({ ok: true, request }), 5);
        });
      },
    },
  };
};

const assertAdapterCancelSemantics = async (
  adapter:
    | McpStdioAdapter
    | McpSseAdapter
    | {
        callTool(
          name: string,
          input: unknown,
          signal?: AbortSignal,
          requestId?: string,
        ): Promise<unknown>;
        cancel(requestId: string): Promise<void>;
        disconnect(): Promise<void>;
      },
): Promise<void> => {
  const { client, seenSignals, seenArguments } = createPendingClient();
  injectClient(adapter, client);

  const request = (adapter as McpStdioAdapter | McpSseAdapter).callTool(
    "read_resource",
    { path: "/tmp/a.txt" },
    undefined,
    "req-1",
  );
  expect((adapter as { pendingRequests: Map<string, AbortController> }).pendingRequests.has("req-1")).toBe(
    true,
  );
  await expect(
    (adapter as McpStdioAdapter | McpSseAdapter).callTool(
      "read_resource",
      { path: "/tmp/a.txt" },
      undefined,
      "req-1",
    ),
  ).rejects.toThrow("already in progress");
  await (adapter as McpStdioAdapter | McpSseAdapter).cancel("req-1");
  await expect(request).rejects.toThrow("cancelled");

  const requestWithExternalAbort = (adapter as McpStdioAdapter | McpSseAdapter).callTool(
    "read_resource",
    { path: "/tmp/b.txt" },
    (() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("external-abort")), 1);
      return controller.signal;
    })(),
    "req-2",
  );
  await expect(requestWithExternalAbort).rejects.toThrow("external-abort");
  await (adapter as McpStdioAdapter | McpSseAdapter).cancel("missing-request");

  const longRequest = (adapter as McpStdioAdapter | McpSseAdapter).callTool(
    "read_resource",
    { path: "/tmp/c.txt" },
    undefined,
    "req-3",
  );
  await (adapter as McpStdioAdapter | McpSseAdapter).disconnect();
  await expect(longRequest).rejects.toThrow("disconnected");

  expect(seenSignals.length).toBeGreaterThan(0);
  expect(seenArguments[0]?.name).toBe("read_resource");
};

describe("MCP adapters", () => {
  it("maps stdio listTools and prefixes execute id", async () => {
    const adapter = new McpStdioAdapter({ command: "bunx", args: ["--version"], serverId: "fs" });
    const { client } = createPendingClient();
    injectClient(adapter, client);
    const tools = await adapter.listTools();
    expect(adapter.transport).toBe("stdio");
    expect(tools.length).toBe(1);
    expect(tools[0]?.execute).toBe("mcp:fs:read_resource");
    expect(tools[0]?.sideEffect).toBe("readonly");
    expect(tools[0]?.idempotent).toBe(true);
  });

  it("maps sse listTools and prefixes execute id", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    const { client } = createPendingClient();
    injectClient(adapter, client);
    const tools = await adapter.listTools();
    expect(adapter.transport).toBe("sse");
    expect(tools[0]?.execute).toBe("mcp:sse:read_resource");
  });

  it("supports requestId based cancel semantics for stdio", async () => {
    const adapter = new McpStdioAdapter({ command: "bunx", args: ["--version"] });
    await assertAdapterCancelSemantics(adapter);
  });

  it("supports requestId based cancel semantics for sse", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    await assertAdapterCancelSemantics(adapter);
  });

  it("propagates cancel(requestId) to transport via notifications/cancelled (stdio)", async () => {
    const adapter = new McpStdioAdapter({ command: "bunx", args: ["--version"] });
    const sentNotifications: Array<{ method: string; params: unknown }> = [];
    const pendingClient: PendingClient = {
      async listTools() {
        return { tools: [] };
      },
      callTool(request, _meta, options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("expected signal"));
            return;
          }
          if (signal.aborted) {
            sentNotifications.push({
              method: "notifications/cancelled",
              params: { requestId: request.name, reason: String(signal.reason) },
            });
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              sentNotifications.push({
                method: "notifications/cancelled",
                params: {
                  requestId: request.name,
                  reason: String(signal.reason),
                },
              });
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    };
    injectClient(adapter, pendingClient);

    const call = adapter.callTool("read_resource", { path: "/tmp/a.txt" }, undefined, "req-cancel");
    await adapter.cancel("req-cancel");
    await expect(call).rejects.toThrow("cancelled");

    expect(sentNotifications.length).toBe(1);
    expect(sentNotifications[0]?.method).toBe("notifications/cancelled");
    const params = sentNotifications[0]?.params as {
      requestId: string;
      reason: string;
    };
    expect(params.requestId).toBe("read_resource");
    expect(params.reason).toContain("cancelled");
  });

  it("propagates cancel(requestId) to transport via HTTP cancel notification (sse)", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    const httpCancelEvents: Array<{
      type: "http-cancel";
      requestId: string;
      reason: string;
    }> = [];
    const pendingClient: PendingClient = {
      async listTools() {
        return { tools: [] };
      },
      callTool(request, _meta, options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("expected signal"));
            return;
          }
          const onAbort = () => {
            httpCancelEvents.push({
              type: "http-cancel",
              requestId: request.name,
              reason: String(signal.reason),
            });
            reject(signal.reason);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    injectClient(adapter, pendingClient);

    const call = adapter.callTool("read_resource", { path: "/tmp/b.txt" }, undefined, "req-cancel-sse");
    await adapter.cancel("req-cancel-sse");
    await expect(call).rejects.toThrow("cancelled");

    expect(httpCancelEvents.length).toBe(1);
    expect(httpCancelEvents[0]?.type).toBe("http-cancel");
    expect(httpCancelEvents[0]?.requestId).toBe("read_resource");
    expect(httpCancelEvents[0]?.reason).toContain("cancelled");
  });

  it("throws not-connected error when client missing", async () => {
    const adapter = new McpStdioAdapter({ command: "bunx" });
    await expect(adapter.listTools()).rejects.toThrow("not connected");
    await expect(adapter.callTool("x", {})).rejects.toThrow("not connected");
  });

  it("retries reconnect with backoff for stdio", async () => {
    const adapter = new McpStdioAdapter({ command: "bunx" });
    let attempts = 0;
    (adapter as { connectInternal: () => Promise<void> }).connectInternal = async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("connect failed");
      }
    };
    await (adapter as { reconnectWithBackoff: () => Promise<void> }).reconnectWithBackoff();
    expect(attempts).toBe(2);
  });

  it("retries reconnect with backoff for sse", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    let attempts = 0;
    (adapter as { connectInternal: () => Promise<void> }).connectInternal = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("connect failed");
      }
    };
    await (adapter as { reconnectWithBackoff: () => Promise<void> }).reconnectWithBackoff();
    expect(attempts).toBe(3);
  });

  it("sse disconnect tears down transport and aborts pending requests", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    let closed = 0;
    (adapter as { transportImpl: { close: () => Promise<void> } | null }).transportImpl = {
      close: async () => {
        closed += 1;
      },
    };
    const pendingController = new AbortController();
    (adapter as { pendingRequests: Map<string, AbortController> }).pendingRequests.set(
      "req-pending",
      pendingController,
    );
    await adapter.disconnect();
    expect(closed).toBe(1);
    expect(pendingController.signal.aborted).toBe(true);
    expect(
      (adapter as { pendingRequests: Map<string, AbortController> }).pendingRequests.size,
    ).toBe(0);
    expect((adapter as { client: unknown }).client).toBeNull();
  });

  it("sse callTool surfaces default 30s timeout (shortened to 5ms for testability)", async () => {
    const adapter = new McpSseAdapter({
      url: "https://example.com/sse",
      defaultTimeoutMs: 5,
    });
    const pendingClient: PendingClient = {
      async listTools() {
        return { tools: [] };
      },
      callTool(_request, _meta, options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("expected signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    injectClient(adapter, pendingClient);
    await expect(
      adapter.callTool("slow", {}, undefined, "req-timeout"),
    ).rejects.toThrow("timed out");
  });

  it("sse defaults defaultTimeoutMs to 30s when options omit it", () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    expect((adapter as { defaultTimeoutMs: number }).defaultTimeoutMs).toBe(30_000);
  });

  it("sse accepts defaultTimeoutMs=0 to disable the adapter-level timeout", async () => {
    const adapter = new McpSseAdapter({
      url: "https://example.com/sse",
      defaultTimeoutMs: 0,
    });
    expect((adapter as { defaultTimeoutMs: number }).defaultTimeoutMs).toBe(0);
    injectClient(adapter, createPendingClient().client);
    const result = (await adapter.callTool("read_resource", {})) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("sse reconnect does not restart when adapter was closed manually", async () => {
    const adapter = new McpSseAdapter({ url: "https://example.com/sse" });
    let attempts = 0;
    (adapter as { closedManually: boolean }).closedManually = true;
    (adapter as { connectInternal: () => Promise<void> }).connectInternal = async () => {
      attempts += 1;
    };
    await (adapter as { reconnectWithBackoff: () => Promise<void> }).reconnectWithBackoff();
    expect(attempts).toBe(0);
  });

  it("stdio defaults defaultTimeoutMs to 30s when options omit it", () => {
    const adapter = new McpStdioAdapter({ command: "bunx" });
    expect((adapter as { defaultTimeoutMs: number }).defaultTimeoutMs).toBe(30_000);
  });

  it("stdio callTool surfaces default timeout", async () => {
    const adapter = new McpStdioAdapter({
      command: "bunx",
      args: ["--version"],
      defaultTimeoutMs: 5,
    });
    const pendingClient: PendingClient = {
      async listTools() {
        return { tools: [] };
      },
      callTool(_request, _meta, options) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("expected signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };
    injectClient(adapter, pendingClient);
    await expect(
      adapter.callTool("slow", {}, undefined, "req-timeout"),
    ).rejects.toThrow("timed out");
  });
});
