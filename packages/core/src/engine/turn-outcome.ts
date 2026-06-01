import type {
  AdapterCallContext,
  EngineEvent,
  ExecutionContext,
  OutputMetadata,
  StreamChunk,
  StreamChunkPayload,
  StepStatus,
  ToolCallRecord,
  TurnError,
  TurnOutcome,
  ValidationOutcome,
} from "../types";

export const streamEnvelopeFromContext = (
  context: ExecutionContext,
): Pick<StreamChunk, "correlation" | "subject"> => ({
  correlation: context.correlation,
  ...(context.subject !== undefined ? { subject: context.subject } : {}),
});

export const withStreamEnvelope = (
  chunk: StreamChunkPayload,
  context: ExecutionContext,
): StreamChunk => ({
  ...chunk,
  ...streamEnvelopeFromContext(context),
});

export const engineEventFromContext = (
  context: ExecutionContext,
  event: Omit<EngineEvent, "correlation" | "subject">,
): EngineEvent => ({
  ...event,
  correlation: context.correlation,
  ...(context.subject !== undefined ? { subject: context.subject } : {}),
});

export const engineEventFromAdapterContext = (
  context: AdapterCallContext,
  event: Omit<EngineEvent, "correlation" | "subject">,
): EngineEvent => ({
  ...event,
  correlation: context.correlation,
  ...(context.subject !== undefined ? { subject: context.subject } : {}),
});

export const turnErrorFromToolCall = (record: ToolCallRecord): TurnError | null => {
  if (record.success || record.error === undefined) {
    return null;
  }
  return {
    code: record.error.code,
    message: record.error.message,
    source: record.source,
    toolName: record.tool,
    callId: record.callId,
    retryable: record.error.retryable,
  };
};

const unresolvedToolFailures = (toolCalls: readonly ToolCallRecord[]): ToolCallRecord[] => {
  const recoveredTools = new Set<string>();
  const unresolved: ToolCallRecord[] = [];
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const record = toolCalls[index];
    if (!record) continue;
    if (record.success) {
      recoveredTools.add(record.tool);
      continue;
    }
    if (!recoveredTools.has(record.tool)) {
      unresolved.push(record);
    }
  }
  return unresolved.reverse();
};

export const deriveTurnOutcome = (args: {
  validationPassed: boolean;
  steps: readonly StepStatus[];
  toolCalls: readonly ToolCallRecord[];
  runFailed?: boolean | undefined;
}): {
  outcome: TurnOutcome;
  errors?: TurnError[] | undefined;
  incompleteSteps?: number | undefined;
} => {
  const failedSteps = args.steps.filter((step) => step.status !== "completed");
  const unresolvedToolCallErrors = unresolvedToolFailures(args.toolCalls)
    .map(turnErrorFromToolCall)
    .filter((item): item is TurnError => item !== null);
  const historicalToolErrors = args.toolCalls
    .map(turnErrorFromToolCall)
    .filter((item): item is TurnError => item !== null);

  const errors: TurnError[] = [...historicalToolErrors];
  if (!args.validationPassed) {
    for (const step of failedSteps) {
      errors.push({
        code: "VALIDATION_INCOMPLETE_STEP",
        message: step.reason ?? `Step ${step.name} did not complete`,
        source: "validation",
      });
    }
  }

  let outcome: TurnOutcome;
  if (args.runFailed) {
    outcome = "failed";
  } else if (!args.validationPassed || unresolvedToolCallErrors.length > 0) {
    outcome = "degraded";
  } else {
    outcome = "completed";
  }

  return {
    outcome,
    ...(errors.length > 0 ? { errors } : {}),
    ...(failedSteps.length > 0 ? { incompleteSteps: failedSteps.length } : {}),
  };
};

export const applyTurnOutcome = (
  metadata: Omit<OutputMetadata, "outcome" | "errors" | "incompleteSteps">,
  args: Parameters<typeof deriveTurnOutcome>[0],
): OutputMetadata => ({
  ...metadata,
  ...deriveTurnOutcome(args),
});

/**
 * 把 `ValidationOutcome` 映射为对应的 `EngineEvent`（不含 correlation）。
 *
 * - `pass` 返回 null（无需事件）；
 * - `retry` → `type: "retry"`；
 * - `degrade` → `type: "degrade"`；
 * - `handoff` → `type: "handoff"`。
 *
 * 该 helper 提取自 engine.ts validation 后置消费段，便于单测断言 5 种 outcome
 * 的事件 schema 不漂移；engine.ts 直接以 helper 输出 + correlation envelope 触发 emit。
 */
export const validationOutcomeToEvent = (
  outcome: ValidationOutcome,
  timestamp: number,
): Omit<EngineEvent, "correlation" | "subject"> | null => {
  switch (outcome.kind) {
    case "pass":
      return null;
    case "retry":
      return {
        timestamp,
        phase: "validation",
        type: "retry",
        payload: {
          reason: outcome.reason,
          target: outcome.target,
        },
      };
    case "degrade":
      return {
        timestamp,
        phase: "validation",
        type: "degrade",
        payload: {
          reason: outcome.reason,
          userVisibleReason: outcome.userVisibleReason,
        },
      };
    case "handoff":
      return {
        timestamp,
        phase: "validation",
        type: "handoff",
        payload: {
          reason: outcome.reason,
          userVisibleReason: outcome.userVisibleReason,
        },
      };
    default: {
 // Exhaustive guard: TS must complain if a new outcome.kind is added without a branch.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return null;
    }
  }
};
