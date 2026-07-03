import { EngineError, TimeoutError } from "../errors";
import type { HookAction, HookEvent, HookPoint, RegisterHandler, SubscribeHandler } from "../types";
import type { ObservabilityEmitter } from "./observability";

interface RegisteredHandler {
  id: string;
  priority: number;
  timeoutMs: number;
  handler: RegisterHandler;
}

interface SubscribedHandler {
  id: string;
  handler: SubscribeHandler;
}

type GuardHookAction = Extract<HookAction, { type: "guard" }>;
type FindingHookAction = Extract<HookAction, { type: "finding" }>;

const mergeGuardAction = (
  current: GuardHookAction | undefined,
  next: GuardHookAction,
): GuardHookAction => {
  const existing = current?.decision;
  const incoming = next.decision;
  if (!existing || existing.kind === "pass") return next;
  if (incoming.kind === "pass") return current;
  if (existing.kind === "block") return current;
  if (incoming.kind === "block") return next;
  if (existing.kind === "degrade") return current;
  if (incoming.kind === "degrade") return next;
  const prefixes = [existing.prefix, incoming.prefix]
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
  if (prefixes.length === 0) {
    return { type: "guard", decision: { kind: "pass" } };
  }
  return { type: "guard", decision: { kind: "annotate", prefix: prefixes.join(" ") } };
};

const mergeFindingAction = (
  current: FindingHookAction | undefined,
  next: FindingHookAction,
): FindingHookAction => ({
  type: "finding",
  findings: [...(current?.findings ?? []), ...next.findings],
});

/**
 * 单次 Hook 执行失败时的处理策略。
 *
 * - `'continue'`：吞错并通过 ObservabilityEmitter 发 `error` 事件，主流程继续
 * - `'abort'`：立即向上抛出（由调用方决定是否捕获并中止整次执行）
 *
 * 对应 detailed-design §9.8 "运行约束"。
 */
export type HookFailureBehavior = "continue" | "abort";

/**
 * Hook 注册中心接口。
 */
export interface HookRegistry {
 /**
 * 注册只读订阅处理器。
 *
 * @param point 挂载点
 * @param handler 只读处理器
 * @param options 可选元信息（id）；同 point 同 id 视为更新并覆盖既有 handler
 * @returns 取消订阅函数
 */
  subscribe(
    point: HookPoint,
    handler: SubscribeHandler,
    options?: { id?: string },
  ): () => void;
 /**
 * 注册可写处理器。
 *
 * @param point 挂载点
 * @param handler 可写处理器
 * @param options 可选元信息（id、优先级、超时）
 * @returns 取消注册函数
 */
  register(
    point: HookPoint,
    handler: RegisterHandler,
    options?: { id?: string; priority?: number; timeout?: number },
  ): () => void;
 /**
 * 触发指定挂载点。
 *
 * @param point 挂载点
 * @param event Hook 事件
 * @returns 第一个改变主流程的动作；若无则返回 undefined
 */
  fire(point: HookPoint, event: HookEvent): Promise<HookAction | undefined>;
 /**
 * 清空所有订阅与注册处理器。
 */
  clear(): void;
}

/**
 * 默认 Hook 注册中心。
 *
 * 与 detailed-design §9.8 对齐：
 * - `subscribe` / `register` 均返回取消函数
 * - 同 point 同 id 的新注册会覆盖已有 handler
 * - `fire` 时依据 `failureBehavior` 决定吞错继续或抛错中断
 */
export class DefaultHookRegistry implements HookRegistry {
  private readonly subscribers = new Map<HookPoint, SubscribedHandler[]>();
  private readonly registrars = new Map<HookPoint, RegisteredHandler[]>();

  constructor(
    private readonly observability: ObservabilityEmitter,
    private readonly writeHookTimeout = 5_000,
    private readonly failureBehavior: HookFailureBehavior = "continue",
  ) {}

 /**
 * @inheritdoc
 */
  subscribe(
    point: HookPoint,
    handler: SubscribeHandler,
    options?: { id?: string },
  ): () => void {
    const bucket = this.subscribers.get(point) ?? [];
    const id = options?.id ?? `${point}-sub-${bucket.length + 1}`;
    const existingIndex = bucket.findIndex((entry) => entry.id === id);
    const item: SubscribedHandler = { id, handler };
    if (existingIndex >= 0) {
      bucket[existingIndex] = item;
    } else {
      bucket.push(item);
    }
    this.subscribers.set(point, bucket);
    return () => {
      const current = this.subscribers.get(point) ?? [];
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === 0) {
        this.subscribers.delete(point);
      } else {
        this.subscribers.set(point, next);
      }
    };
  }

 /**
 * @inheritdoc
 */
  register(
    point: HookPoint,
    handler: RegisterHandler,
    options?: { id?: string; priority?: number; timeout?: number },
  ): () => void {
    const bucket = this.registrars.get(point) ?? [];
    const id = options?.id ?? `${point}-${bucket.length + 1}`;
    const item: RegisteredHandler = {
      id,
      priority: options?.priority ?? 100,
      timeoutMs: options?.timeout ?? this.writeHookTimeout,
      handler,
    };
    const existingIndex = bucket.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      bucket[existingIndex] = item;
    } else {
      bucket.push(item);
    }
    bucket.sort((a, b) => a.priority - b.priority);
    this.registrars.set(point, bucket);
    return () => {
      const current = this.registrars.get(point) ?? [];
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === 0) {
        this.registrars.delete(point);
      } else {
        this.registrars.set(point, next);
      }
    };
  }

 /**
 * @inheritdoc
 *
 * 每次调用无条件发一条 `hook_fired` observability 事件(ADR-0006 D2 纪律:
 * 每个挂载点必须有真实 fire 位,即使当前无人订阅/注册,也要留下可观测痕迹,
 * 防止"定义了却查不出是否真被触发"的死面问题重演)。
 */
  async fire(point: HookPoint, event: HookEvent): Promise<HookAction | undefined> {
    const subscribers = [...(this.subscribers.get(point) ?? [])];
    const registrars = [...(this.registrars.get(point) ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
    let resultAction: HookAction | undefined;

    for (const { id, handler } of subscribers) {
      try {
        await handler(event);
      } catch (error) {
        this.handleHookError(point, event, {
          source: "hook-subscribe",
          handlerId: id,
          error,
        });
      }
    }

    for (const item of registrars) {
      try {
        const action = await Promise.race([
          item.handler(event),
          new Promise<HookAction>((_, reject) => {
            setTimeout(() => reject(TimeoutError.hookTimeout(point, item.timeoutMs)), item.timeoutMs);
          }),
        ]);
        if (action?.type === "guard") {
          resultAction = mergeGuardAction(
            resultAction?.type === "guard" ? resultAction : undefined,
            action,
          );
          continue;
        }
        if (action?.type === "finding") {
          resultAction = mergeFindingAction(
            resultAction?.type === "finding" ? resultAction : undefined,
            action,
          );
          continue;
        }
        if (action && action.type !== "continue") {
          resultAction = action;
          break;
        }
      } catch (error) {
        this.handleHookError(point, event, {
          source: "hook-register",
          handlerId: item.id,
          error,
        });
      }
    }

    this.observability.emit({
      timestamp: Date.now(),
      correlation: event.correlation,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      phase: point,
      type: "hook_fired",
      payload: {
        point,
        subscriberCount: subscribers.length,
        registrarCount: registrars.length,
        ...(resultAction !== undefined ? { action: resultAction.type } : {}),
      },
    });
    return resultAction;
  }

 /**
 * @inheritdoc
 */
  clear(): void {
    this.subscribers.clear();
    this.registrars.clear();
  }

 /**
 * 按 `failureBehavior` 处理单个 Hook 失败：
 * - `'continue'`：吞错并以 ObservabilityEmitter 发 `error` 事件
 * - `'abort'`：额外抛出 `EngineError`（由 `fromUnknown` 包装），让 `fire` 的
 * 调用方可以根据需要决定是否中断主流程
 */
  private handleHookError(
    point: HookPoint,
    event: HookEvent,
    ctx: { source: "hook-subscribe" | "hook-register"; handlerId: string; error: unknown },
  ): void {
    this.observability.emit({
      timestamp: Date.now(),
      correlation: event.correlation,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      phase: point,
      type: "error",
      payload: {
        source: ctx.source,
        point,
        handlerId: ctx.handlerId,
        error: ctx.error,
      },
    });
    if (this.failureBehavior === "abort") {
      throw EngineError.fromUnknown(ctx.error, "HOOK_EXECUTION_FAILED");
    }
  }
}
