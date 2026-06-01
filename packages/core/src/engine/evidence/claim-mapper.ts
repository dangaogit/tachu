import type { ClaimEntry, EvidenceEntry } from "../../types/evidence";

/**
 * Deterministic evidence → claim mapping.
 *
 * Each branch is **strictly driven by the evidence entry's `recordType`**
 * — no regex or keyword matching is performed on the surrounding text. This
 * is what allows the validation pipeline to reason about claims without an
 * LLM and without conflating "wrote a file" with the literal word "write"
 * appearing in a tool name (a keyword-matching anti-pattern this rule avoids).
 *
 * Mapping table:
 * | recordType | ClaimKind | requiredEvidence | producedBy |
 * |---------------------|------------------|------------------|-------------------|
 * | `tool-observation` | `source-derived` | `any` | (preserved) |
 * | `agent-run` | `source-derived` | `any` | (preserved) |
 * | `file-write` | `file-changed` | `same-source` | (preserved) |
 * | `external-source` | `external-fact` | `same-source` | (preserved) |
 *
 * Evidence with `purpose === "context"` is **never** turned into claims —
 * pure-context entries are advisory and must not advance the answer.
 */
export const mapDeterministicClaims = (evidence: readonly EvidenceEntry[]): ClaimEntry[] => {
  const claims: ClaimEntry[] = [];
  for (const entry of evidence) {
    if (entry.purpose === "context") continue;
    const recordType = entry.recordType ?? "tool-observation";
    switch (recordType) {
      case "tool-observation":
      case "agent-run": {
        if (entry.purpose !== "execution-observation") continue;
        claims.push({
          id: `claim-${entry.source}`,
          content: `Observation recorded for ${entry.source}`,
          kind: "source-derived",
          requiredEvidence: "any",
          producedBy: entry.producedBy,
          sourceRef: entry.source,
        });
        break;
      }
      case "file-write": {
        claims.push({
          id: `claim-file-write-${entry.source}`,
          content: `File-changing tool invocation recorded at ${entry.source}`,
          kind: "file-changed",
          requiredEvidence: "same-source",
          producedBy: entry.producedBy,
          sourceRef: entry.source,
        });
        break;
      }
      case "external-source": {
        claims.push({
          id: `claim-external-source-${entry.source}`,
          content: `External source referenced at ${entry.source}`,
          kind: "external-fact",
          requiredEvidence: "same-source",
          producedBy: entry.producedBy,
          sourceRef: entry.source,
        });
        break;
      }
      default: {
 // Forward-compat: unknown recordType variants are ignored rather than
 // crashing the validation pipeline.
        break;
      }
    }
  }
  return claims;
};
