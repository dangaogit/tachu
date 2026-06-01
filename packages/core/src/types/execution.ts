import type { ExecutionContext } from "./context";

/**
 * 执行单元声明维度。
 */
export interface ExecutionTraits {
  sideEffect: "readonly" | "write" | "irreversible";
  idempotent: boolean;
  requiresApproval: boolean;
  timeout: number;
}

/**
 * 统一执行单元接口。
 */
export interface ExecutionUnit<TInput, TOutput> {
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

