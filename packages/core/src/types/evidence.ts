import type { EnginePhase } from "./io";

export type EvidenceProducerId =
  | EnginePhase
  | "tool-use"
  | "direct-answer"
  | "agent-runtime"
  | "host";

export type EvidencePurpose = "context" | "claim-support" | "execution-observation";

/**
 * Evidence 记录类型（）。供 deterministic claim mapper 区分
 * 普通工具观察、文件写入与外部事实来源，不再依赖关键词匹配。
 *
 * - `"tool-observation"`：来自 `tool-use` 子流程的工具调用观察（缺省语义）。
 * - `"agent-run"`：来自 `agent-runtime` 子任务上报的 evidence。
 * - `"file-write"`：descriptor 标注 `sideEffect ∈ {write, irreversible}` 的
 * 工具/智能体写入记录；deterministic claim mapper 将其翻译为 `file-changed` claim。
 * - `"external-source"`：descriptor 标注 `dataSource: "external"` 的外部事实
 * 引用记录；deterministic claim mapper 将其翻译为 `external-fact` claim。
 */
export type EvidenceRecordType =
  | "tool-observation"
  | "agent-run"
  | "file-write"
  | "external-source";

export interface EvidenceEntry {
  source: string;
  content: unknown;
  producedBy: EvidenceProducerId;
  purpose: EvidencePurpose;
  agentRunId?: string | undefined;
 /**
 * 记录种类标签（）。缺省视为 `"tool-observation"` 以保持向后兼容。
 * 仅供 deterministic claim mapper / 校验规则消费，不参与对外渲染。
 */
  recordType?: EvidenceRecordType | undefined;
}

export type ClaimKind =
  | "action-completed"
  | "source-derived"
  | "file-changed"
  | "external-fact"
  | "limitation";

export interface ClaimEntry {
  id: string;
  content: string;
  kind: ClaimKind;
  requiredEvidence: "none" | "any" | "same-source";
  producedBy: EvidenceProducerId;
  sourceRef?: string | undefined;
}

export interface CandidateAnswer {
  content: string;
  producedBy: EvidenceProducerId;
  claims: readonly ClaimEntry[];
  evidence: readonly EvidenceEntry[];
}
