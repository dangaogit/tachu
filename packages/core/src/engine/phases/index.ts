import type { EngineConfig } from "../../types";
import type { AdapterCallContext } from "../../types/context";
import type {
  HookRegistry,
  MemorySystem,
  ModelRouter,
  ObservabilityEmitter,
  ProviderAdapter,
  RuntimeState,
  SafetyModule,
  SessionManager,
} from "../../modules";
import type { DescriptorRegistry } from "../../registry";
import type { TaskScheduler } from "../scheduler";

/**
 * 各阶段运行环境依赖。
 *
 * `onProviderUsage` 为 D1-LOW-04 引入的回调：每次 Provider.chat 真实返回 usage
 * 时由阶段调用，引擎主干据此把真实 token 消耗回流到 `ExecutionOrchestrator`，替代
 * 先前只用 Prompt 估算 token 的做法，保证预算熔断与可观测事件拿到准确数据。
 */
export interface PhaseEnvironment {
  config: EngineConfig;
  registry: DescriptorRegistry;
  sessionManager: SessionManager;
  memorySystem: MemorySystem;
  runtimeState: RuntimeState;
  modelRouter: ModelRouter;
  providers: Map<string, ProviderAdapter>;
  safetyModule: SafetyModule;
  observability: ObservabilityEmitter;
  hooks: HookRegistry;
  scheduler: TaskScheduler;
  activeAbortSignal: AbortSignal;
  /** 本轮 `ExecutionContext` 导出的 Provider / Memory / Vector 调用上下文。 */
  adapterContext: AdapterCallContext;
  onProviderUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => void;
}

export * from "./execution";
export * from "./graph-check";
export * from "./intent";
export * from "./output";
export * from "./planning";
export * from "./precheck";
export * from "./safety";
export * from "./session";
export * from "./validation";

