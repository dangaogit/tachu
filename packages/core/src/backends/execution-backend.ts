import type { ExecutionContext, ExecutionTraits, ExecutionUnit } from "../types";

/**
 * 执行后端类别。
 */
export type ExecutionBackendKind = "terminal" | "file" | "web" | "custom";

/**
 * 后端输入。
 */
export interface BackendInput {
  taskId: string;
  payload: Record<string, unknown>;
}

/**
 * 后端输出。
 */
export interface BackendOutput {
  success: boolean;
  result: unknown;
}

/**
 * 执行后端接口。
 */
export interface ExecutionBackend
  extends ExecutionUnit<BackendInput, BackendOutput> {
  readonly name: string;
  readonly kind: ExecutionBackendKind;
  readonly traits: ExecutionTraits;
  execute(input: BackendInput, context: ExecutionContext): Promise<BackendOutput>;
}

