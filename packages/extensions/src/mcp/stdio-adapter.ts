import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpToolAdapter, ToolDescriptor } from "@tachu/core";

interface McpStdioAdapterOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  serverId?: string;
  /**
   * 单次 `callTool` 的默认超时（毫秒）。到期后会在 adapter 层 abort 下游请求
   * 并抛出 "MCP stdio request timed out" 错误。宿主显式传入 `0` 可关闭默认超时，
   * 此时仅依赖调用方传入的 `AbortSignal`。详见 D1-LOW-08。
   *
   * @default 30_000
   */
  defaultTimeoutMs?: number;
}

/** D1-LOW-08：默认 30s 的工具调用超时窗口。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

const createRequestId = (): string =>
  `mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * MCP stdio 传输适配器。
 */
export class McpStdioAdapter implements McpToolAdapter {
  readonly transport = "stdio" as const;

  private readonly options: McpStdioAdapterOptions;
  private readonly maxReconnectAttempts = 3;
  private readonly defaultTimeoutMs: number;
  private client: Client | null = null;
  private transportImpl: StdioClientTransport | null = null;
  private reconnecting = false;
  private closedManually = false;
  private connected = false;
  private serverUri = "";
  private readonly pendingRequests = new Map<string, AbortController>();

  /**
   * 创建 stdio MCP 适配器。
   *
   * @param options stdio 启动参数
   */
  constructor(options: McpStdioAdapterOptions) {
    this.options = options;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs === undefined
        ? DEFAULT_CALL_TIMEOUT_MS
        : Math.max(0, options.defaultTimeoutMs);
  }

  /**
   * 建立 MCP 连接。
   *
   * @param serverUri 服务端 URI（可留空）
   */
  async connect(serverUri: string): Promise<void> {
    this.serverUri = serverUri;
    this.closedManually = false;
    await this.connectInternal();
  }

  /**
   * 断开连接。
   */
  async disconnect(): Promise<void> {
    this.closedManually = true;
    this.connected = false;
    for (const controller of this.pendingRequests.values()) {
      controller.abort(new Error("MCP stdio adapter disconnected"));
    }
    this.pendingRequests.clear();
    await this.transportImpl?.close().catch(() => undefined);
    this.transportImpl = null;
    this.client = null;
  }

  /**
   * 列出远端工具并映射为引擎 ToolDescriptor。
   *
   * @returns 工具描述符数组
   */
  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.client) {
      throw new Error("MCP stdio adapter not connected");
    }
    const response = await this.client.listTools();
    return response.tools.map((tool) => ({
      kind: "tool",
      name: tool.name,
      description: tool.description ?? `mcp tool: ${tool.name}`,
      sideEffect: tool.annotations?.readOnlyHint
        ? "readonly"
        : tool.annotations?.destructiveHint
          ? "irreversible"
          : "write",
      idempotent: tool.annotations?.idempotentHint ?? false,
      requiresApproval: tool.annotations?.destructiveHint ?? false,
      timeout: 30_000,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
      execute: `mcp:${this.options.serverId ?? "stdio"}:${tool.name}`,
    }));
  }

  /**
   * 调用远端工具（core 协议方法）。
   *
   * @param name 工具名
   * @param input 入参
   * @returns 工具执行结果
   */
  async executeTool(
    name: string,
    input: unknown,
    options?: { signal?: AbortSignal; requestId?: string },
  ): Promise<unknown> {
    return this.callTool(name, input, options?.signal, options?.requestId);
  }

  /**
   * 调用远端工具（支持 AbortSignal）。
   *
   * @param name 工具名
   * @param input 入参
   * @param signal 取消信号
   * @param requestId 请求 ID（可选；用于后续 cancel 显式取消）
   * @returns 工具执行结果
   */
  async callTool(
    name: string,
    input: unknown,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error("MCP stdio adapter not connected");
    }
    const mappedRequestId = requestId?.trim() ? requestId : createRequestId();
    if (this.pendingRequests.has(mappedRequestId)) {
      throw new Error(`MCP stdio request already in progress: ${mappedRequestId}`);
    }

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(signal?.reason ?? new Error(`MCP stdio request aborted: ${mappedRequestId}`));
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    // D1-LOW-08：为 callTool 套上 adapter 层默认超时，避免远端挂起拖垮引擎。
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (this.defaultTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new Error(
            `MCP stdio request timed out after ${this.defaultTimeoutMs}ms: ${mappedRequestId}`,
          ),
        );
      }, this.defaultTimeoutMs);
    }

    this.pendingRequests.set(mappedRequestId, controller);
    try {
      const result = await this.client.callTool(
        { name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { signal: controller.signal },
      );
      return result;
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `MCP stdio request timed out after ${this.defaultTimeoutMs}ms: ${mappedRequestId}`,
        );
      }
      throw error;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
      signal?.removeEventListener("abort", onAbort);
      this.pendingRequests.delete(mappedRequestId);
    }
  }

  /**
   * 按 requestId 取消请求（通过信号机制由调用方透传）。
   *
   * @param _requestId 请求 ID
   */
  async cancel(requestId: string): Promise<void> {
    const controller = this.pendingRequests.get(requestId);
    if (!controller) {
      return;
    }
    controller.abort(new Error(`MCP stdio request cancelled: ${requestId}`));
  }

  private async connectInternal(): Promise<void> {
    const serverParams: StdioServerParameters = {
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stderr: "pipe",
    };

    this.client = new Client({ name: "tachu-mcp-stdio", version: "1.0.0" });
    this.transportImpl = new StdioClientTransport(serverParams);
    this.transportImpl.onclose = () => {
      this.connected = false;
      if (!this.closedManually) {
        void this.reconnectWithBackoff();
      }
    };
    await this.client.connect(this.transportImpl);
    this.connected = true;
  }

  private async reconnectWithBackoff(): Promise<void> {
    if (this.reconnecting || this.closedManually) {
      return;
    }
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
        const delay = 200 * 2 ** attempt;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        try {
          await this.connectInternal();
          return;
        } catch {
          // retry
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}
