import type { ToolDescriptor } from "../types";

/**
 * MCP 传输类型。
 */
export type McpTransport = "stdio" | "sse";

/**
 * `McpToolAdapter.executeTool` 调用选项。
 *
 * 新增（D1-LOW-21）：
 * - `signal`：外部 AbortSignal。桥接到底层 transport 的请求级 signal，abort
 *   后 adapter 应发送协议级 `notifications/cancelled`（stdio）或 HTTP cancel
 *   （SSE）并让该次 `executeTool` 拒绝。
 * - `requestId`：请求级 ID，便于对 adapter 侧 `cancel(requestId)` 精确定位。
 */
export interface McpExecuteToolOptions {
  signal?: AbortSignal;
  requestId?: string;
}

/**
 * MCP Tool 适配器接口。
 */
export interface McpToolAdapter {
  readonly transport: McpTransport;
  connect(serverUri: string): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  executeTool(
    name: string,
    input: unknown,
    options?: McpExecuteToolOptions,
  ): Promise<unknown>;
  cancel(requestId: string): Promise<void>;
}

