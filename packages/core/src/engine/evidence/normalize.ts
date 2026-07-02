import type {
  AgentDescriptor,
  AnyDescriptor,
  ExecutionRoute,
  StepStatus,
  ToolDescriptor,
  ToolUseObservation,
  ToolUseResult,
} from "../../types";
import type { EvidenceEntry } from "../../types/evidence";

/**
 * Minimal registry view consumed by descriptor-driven normalization. Avoids
 * pulling in `Registry` concrete class so the evidence module stays free of
 * the larger registry surface.
 */
export interface DescriptorRegistryView {
  get(kind: "tool" | "agent", ref: string): AnyDescriptor | undefined;
}

/**
 * Tool-use observation → evidence entry（保持历史语义）。
 *
 * 入口默认产出 `recordType: "tool-observation"`，方便下游 claim mapper
 * 与 `normalizeFileWriteRecords` / `normalizeExternalSourceRefs` 通过
 * recordType 区分通道，而不再依赖关键词匹配。
 */
export const normalizeToolObservations = (
  toolUseResult: ToolUseResult | null,
): EvidenceEntry[] => {
  if (!toolUseResult) return [];
  return toolUseResult.observations.map((observation, index) =>
    observationToEvidence(observation, index),
  );
};

export const normalizeAgentRunEvidence = (result: {
  agent: string;
  evidence?: readonly EvidenceEntry[] | readonly unknown[] | undefined;
}): EvidenceEntry[] => {
  if (!Array.isArray(result.evidence)) return [];
  return result.evidence.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Partial<EvidenceEntry>;
    if (
      typeof candidate.source !== "string" ||
      candidate.producedBy === undefined ||
      candidate.purpose === undefined
    ) {
      return [];
    }
    return [
      {
        source: candidate.source,
        content: candidate.content,
        producedBy: candidate.producedBy,
        purpose: candidate.purpose,
        recordType: candidate.recordType ?? "agent-run",
        ...(typeof candidate.agentRunId === "string"
          ? { agentRunId: candidate.agentRunId }
          : {}),
      } satisfies EvidenceEntry,
    ];
  });
};

const observationToEvidence = (
  observation: ToolUseObservation,
  index: number,
): EvidenceEntry => ({
  source: `${observation.tool}:${observation.callId || index}`,
  content: observation.text,
  producedBy: "tool-use",
  purpose: "execution-observation",
  recordType: "tool-observation",
});

/**
 * descriptor-driven file-write evidence normalization.
 *
 * Walks the executed plan tasks (`steps.status !== "skipped"`), matches each
 * to its descriptor, and emits one `file-write` evidence entry per task whose
 * descriptor declares `sideEffect ∈ {write, irreversible}`. When the matching
 * tool observation can be located by `observation.tool === task.ref` and the
 * step name links back, the observation text is attached as `content`.
 *
 * The function is purely descriptor-driven — there is no `/write|edit|patch/i`
 * keyword matching anywhere in its body.
 */
export interface FileWriteNormalizationInput {
  steps: readonly StepStatus[];
  plan?: ExecutionRoute | undefined;
  registry?: DescriptorRegistryView | undefined;
  toolUseResult?: ToolUseResult | null | undefined;
}

export const normalizeFileWriteRecords = (
  input: FileWriteNormalizationInput,
): EvidenceEntry[] => {
  const { steps, plan, registry, toolUseResult } = input;
  if (!plan || !registry || typeof registry.get !== "function") return [];
  const executed = new Set(
    steps.filter((step) => step.status !== "skipped").map((step) => step.name),
  );
  const observationsByTool = indexObservationsByTool(toolUseResult);
  const results: EvidenceEntry[] = [];
  for (const task of plan.tasks) {
    if (!executed.has(task.id)) continue;
    if (task.type !== "tool" && task.type !== "agent") continue;
    const descriptor = registry.get(task.type, task.ref) as
      | ToolDescriptor
      | AgentDescriptor
      | undefined;
    if (!descriptor) continue;
    if (descriptor.sideEffect !== "write" && descriptor.sideEffect !== "irreversible") continue;
    const observation = observationsByTool.get(task.ref)?.shift();
    const source = observation
      ? `${observation.tool}:${observation.callId || task.id}`
      : `${task.type}:${task.ref}:${task.id}`;
    const content =
      observation?.text ??
      `${task.type} "${task.ref}" executed with sideEffect=${descriptor.sideEffect}`;
    results.push({
      source,
      content,
      producedBy: "tool-use",
      purpose: "execution-observation",
      recordType: "file-write",
    });
  }
  return results;
};

/**
 * descriptor-driven external-source evidence normalization.
 *
 * Same shape as {@link normalizeFileWriteRecords} but selects descriptors that
 * declare `dataSource: "external"`. The resulting `external-source` entries
 * power `external-fact` claim mapping with `requiredEvidence: "same-source"`.
 */
export const normalizeExternalSourceRefs = (
  input: FileWriteNormalizationInput,
): EvidenceEntry[] => {
  const { steps, plan, registry, toolUseResult } = input;
  if (!plan || !registry || typeof registry.get !== "function") return [];
  const executed = new Set(
    steps.filter((step) => step.status !== "skipped").map((step) => step.name),
  );
  const observationsByTool = indexObservationsByTool(toolUseResult);
  const results: EvidenceEntry[] = [];
  for (const task of plan.tasks) {
    if (!executed.has(task.id)) continue;
    if (task.type !== "tool" && task.type !== "agent") continue;
    const descriptor = registry.get(task.type, task.ref) as
      | ToolDescriptor
      | AgentDescriptor
      | undefined;
    if (!descriptor) continue;
    if (descriptor.dataSource !== "external") continue;
    const observation = observationsByTool.get(task.ref)?.shift();
    const source = observation
      ? `${observation.tool}:${observation.callId || task.id}`
      : `${task.type}:${task.ref}:${task.id}`;
    const content =
      observation?.text ??
      `${task.type} "${task.ref}" referenced an external source`;
    results.push({
      source,
      content,
      producedBy: "tool-use",
      purpose: "claim-support",
      recordType: "external-source",
    });
  }
  return results;
};

const indexObservationsByTool = (
  toolUseResult: ToolUseResult | null | undefined,
): Map<string, ToolUseObservation[]> => {
  const index = new Map<string, ToolUseObservation[]>();
  if (!toolUseResult) return index;
  for (const observation of toolUseResult.observations) {
    const bucket = index.get(observation.tool) ?? [];
    bucket.push(observation);
    index.set(observation.tool, bucket);
  }
  return index;
};

export const mergeEvidence = (
  ...groups: readonly (readonly EvidenceEntry[])[]
): EvidenceEntry[] => {
  const seen = new Set<string>();
  const merged: EvidenceEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      const recordType = entry.recordType ?? "tool-observation";
      const key = `${entry.source}:${entry.producedBy}:${entry.purpose}:${recordType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
};
