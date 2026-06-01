import type { ValidationFinding } from "../../../../types";
import type { ClaimEntry, EvidenceEntry } from "../../../../types/evidence";
import type { ValidationRule } from "../registry";

const isNonContextEvidence = (entry: EvidenceEntry): boolean => entry.purpose !== "context";

const claimHasEvidence = (
  claim: ClaimEntry,
  evidence: readonly EvidenceEntry[],
): boolean => {
  const usable = evidence.filter(isNonContextEvidence);
  if (claim.requiredEvidence === "any") {
    return usable.length > 0;
  }
  if (claim.requiredEvidence === "same-source") {
    if (claim.sourceRef === undefined) return false;
    return usable.some((entry) => entry.source === claim.sourceRef);
  }
  return true;
};

export const evidenceRequiredRule: ValidationRule = {
  id: "deterministic.evidence.required",
  kind: "deterministic",
  evaluate({ candidateAnswer, evidence }) {
    const claims = candidateAnswer?.claims ?? [];
    if (claims.length === 0) return [];
    const evidenceList = evidence ?? [];
    const findings: ValidationFinding[] = [];
    for (const claim of claims) {
      if (claim.requiredEvidence === "none") continue;
      if (claimHasEvidence(claim, evidenceList)) continue;
      findings.push({
        ruleId: "deterministic.evidence.required",
        kind: "deterministic",
        severity: "error",
        code: "evidence_required_missing",
        message: `claim "${claim.id}" requires evidence (${claim.requiredEvidence})`,
        userVisibleMessage: "当前回答包含需要证据支撑的主张，但缺少可确认的执行证据。",
        retryable: false,
      });
    }
    return findings;
  },
};
