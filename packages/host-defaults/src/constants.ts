import type { ExecutionCorrelation } from "@tachu/core";

/** Shared correlation for engine-init observability events across host wiring. */
export const ENGINE_INIT_CORRELATION: ExecutionCorrelation = {
  traceId: "engine-init",
  requestId: "engine-init",
  sessionId: "engine-init",
  turnId: "engine-init",
};
