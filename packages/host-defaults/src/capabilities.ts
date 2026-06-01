import type { ObservabilityEmitter } from "@tachu/core";
import { ENGINE_INIT_CORRELATION } from "./constants";

/**
 * 通用能力契约检查。
 *
 * 当宿主声明依赖某个能力（例如 providers / embeddingRuntime）但传入
 * 了 noop / 空实现时，此函数 throw 让启动 fail-closed，同时 emit `factory.fail-closed`
 * 事件供宿主审计。`provided` 为 `true` 时静默返回。
 */
export function assertCapabilityProvided(
  observability: ObservabilityEmitter,
  capability: string,
  provided: boolean,
  adapterName: string,
): void {
  if (provided) return;
  observability.emit({
    timestamp: Date.now(),
    correlation: ENGINE_INIT_CORRELATION,
    phase: "init",
    type: "error",
    payload: {
      status: "factory.fail-closed",
      capability,
      adapter: adapterName,
      reason: `declared capability "${capability}" is not provided by adapter "${adapterName}"`,
    },
  });
  throw new Error(
    `[factory] declared capability "${capability}" is not provided by adapter "${adapterName}" — refusing to start (fail-closed)`,
  );
}
