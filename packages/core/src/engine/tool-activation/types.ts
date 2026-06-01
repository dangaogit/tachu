import type { ObservabilityEmitter } from "../../modules/observability";
import type { ToolDescriptor } from "../../types/descriptor";
import type { TurnPolicy } from "../../types/turn-policy";
import type { SemanticRetrievalFacade } from "../../semantic-retrieval";
import type { DescriptorRegistry } from "../../registry";
import type { ExecutionCorrelation, ExecutionSubject } from "../../types/context";

export interface ToolCandidateContribution {
  toolName: string;
  score: number;
  reason: string;
  promote?: { reason: string };
 /** Hard-exclude this tool regardless of other strategies' scores. */
  exclude?: { reason: string };
}

export interface ToolActivationContext {
  query: string;
  agentVisibleTools: ReadonlyArray<ToolDescriptor>;
  registry: DescriptorRegistry;
 /** Policy-aware semantic retrieval. */
  semanticRetrieval?: SemanticRetrievalFacade;
  observability: ObservabilityEmitter;
  signal: AbortSignal;
 /** Correlation for observability events. */
  correlation: ExecutionCorrelation;
 /** Subject for observability events. */
  subject?: ExecutionSubject | undefined;
 /** When true, all strategies are bypassed and agentVisibleTools is returned as-is. */
  disableAllStrategies?: boolean;
 /** Turn-level include/exclude manifest from intent. */
  turnPolicy?: TurnPolicy;
}

export interface ToolCandidateStrategy {
  readonly name: string;
  score(ctx: ToolActivationContext): Promise<ToolCandidateContribution[]>;
}

export interface ToolActivatorOptions {
  strategies: ToolCandidateStrategy[];
  topK?: number;
}

export interface ToolActivationResult {
  visibleTools: ToolDescriptor[];
 /**
 * Tool names that had at least one accepted strategy contribution.
 * Empty when the activator returned the full visible set as a no-hit fallback.
 */
  matchedToolNames: string[];
  fallbackUsed: boolean;
  perStrategyMs: Record<string, number>;
  trace: {
    strategyFailures: Array<{ strategy: string; error: string }>;
  };
}

export interface ToolActivator {
  activate(ctx: ToolActivationContext): Promise<ToolActivationResult>;
}
