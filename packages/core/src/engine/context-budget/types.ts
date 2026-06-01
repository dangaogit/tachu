export type ContextScope =
  | "intent"
  | "main-agent"
  | "direct-answer"
  | "tool-use-loop"
  | "tool-use-final-answer"
  | "fallback-summary"
  | "validation"
  | "memory-compression"
  | "sub-agent"
  | "fan-in-synthesis";

export type ContextInputShape =
  | "text"
  | "multimodal"
  | "tool-observations"
  | "memory-entries";

export type ContextBudgetAction =
  | "trim"
  | "compress"
  | "chunk"
  | "drop-memory"
  | "drop-tools"
  | "degrade";

export type ContextBudgetRisk =
  | "none"
  | "partial-context"
  | "compressed-input"
  | "degraded";

export interface ContextBudgetPolicy {
  trimAllowed?: boolean | undefined;
  compressionAllowed?: boolean | undefined;
  chunkingAllowed?: boolean | undefined;
  degradeAllowed?: boolean | undefined;
}

export interface ContextBudgetRequest {
  phase: string;
  scope: ContextScope;
  purpose: string;
  model: string;
  modelMaxContextTokens: number;
  configuredMaxContextTokens?: number | undefined;
  estimatedInputTokens: number;
  reserveOutputTokens: number;
  inputShape: ContextInputShape;
  policy: ContextBudgetPolicy;
}

export interface ContextBudgetAudit {
  scope: ContextScope;
  model: string;
  maxContextTokens: number;
  estimatedInputTokens: number;
  reserveOutputTokens: number;
  appliedActions: ContextBudgetAction[];
  droppedSources?: string[] | undefined;
  risk?: ContextBudgetRisk | undefined;
}

export interface ContextBudgetEnvelope {
  maxInputTokens: number;
  reserveOutputTokens: number;
  trimOrder: string[];
  compressionAllowed: boolean;
  chunkingAllowed: boolean;
  degradeAllowed: boolean;
  audit: ContextBudgetAudit;
}

export type ContextBudgetDecision =
  | { kind: "fit"; envelope: ContextBudgetEnvelope }
  | { kind: "trim"; envelope: ContextBudgetEnvelope }
  | { kind: "compress"; envelope: ContextBudgetEnvelope; targets: string[] }
  | { kind: "chunk"; strategy: "summarize" | "map-reduce" | "sliding-window" }
  | { kind: "degrade"; userVisibleReason: string; envelope: ContextBudgetEnvelope }
  | { kind: "reject"; reason: string; audit: ContextBudgetAudit };

export interface ContextBudgetBroker {
  decide(request: ContextBudgetRequest): ContextBudgetDecision;
}
