import type { ChatUsage, ProviderAdapter } from "../modules";
import type {
  Message,
  TokenUsageTriplet,
  UsageAccuracy,
  UsageAttribution,
  UsageTerminalState,
} from "../types";

export interface LlmUsageTelemetryEvent {
  attribution: UsageAttribution;
  usage: TokenUsageTriplet;
  accuracy: UsageAccuracy;
  terminal?: UsageTerminalState | undefined;
}

export type EmitLlmUsageTelemetry = (event: LlmUsageTelemetryEvent) => void;

export const chatUsageToTriplet = (usage: ChatUsage): TokenUsageTriplet => ({
  input: usage.promptTokens,
  output: usage.completionTokens,
  total: usage.totalTokens,
});

export const estimateTextTokens = (text: string): number => {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil([...text].length / 4));
};

export const estimateMessagesTokens = async (
  _adapter: ProviderAdapter,
  messages: Message[],
  _model: string,
): Promise<number> => {
  return estimateTextTokens(
    messages
      .map((message) => {
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return `${message.role}:${content}`;
      })
      .join("\n"),
  );
};

export interface LlmUsageTracker {
  start(): void;
  addOutputDelta(text: string): void;
  final(usage: ChatUsage): void;
  terminal(state: UsageTerminalState): void;
}

export const createLlmUsageTracker = (args: {
  attribution: UsageAttribution;
  estimatedInputTokens: number;
  emit?: EmitLlmUsageTelemetry | undefined;
}): LlmUsageTracker => {
  let outputTokens = 0;
  let closed = false;

  const emitSnapshot = (
    accuracy: UsageAccuracy,
    usage: TokenUsageTriplet,
    terminal?: UsageTerminalState,
  ): void => {
    args.emit?.({
      attribution: args.attribution,
      usage,
      accuracy,
      ...(terminal !== undefined ? { terminal } : {}),
    });
  };

  const emitEstimate = (): void => {
    emitSnapshot("estimated", {
      input: args.estimatedInputTokens,
      output: outputTokens,
      total: args.estimatedInputTokens + outputTokens,
    });
  };

  return {
    start(): void {
      if (!closed) {
        emitEstimate();
      }
    },
    addOutputDelta(text: string): void {
      if (closed) {
        return;
      }
      outputTokens += estimateTextTokens(text);
      emitEstimate();
    },
    final(usage: ChatUsage): void {
      closed = true;
      emitSnapshot("final", chatUsageToTriplet(usage));
    },
    terminal(state: UsageTerminalState): void {
      if (closed) {
        return;
      }
      closed = true;
      emitSnapshot(
        "estimated",
        {
          input: args.estimatedInputTokens,
          output: outputTokens,
          total: args.estimatedInputTokens + outputTokens,
        },
        state,
      );
    },
  };
};
