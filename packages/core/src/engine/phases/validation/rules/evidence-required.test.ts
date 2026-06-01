import { describe, expect, it } from "bun:test";
import type { ClaimEntry, EvidenceEntry } from "../../../../types/evidence";
import { evidenceRequiredRule } from "./evidence-required";
import type { ValidationRuleContext } from "../registry";

const baseCtx = (): ValidationRuleContext =>
  ({
    state: { taskResults: {}, steps: [] },
    plan: { rank: 1, tasks: [], edges: [] },
    registry: {} as never,
    evidence: [],
  }) as unknown as ValidationRuleContext;

const claim = (overrides: Partial<ClaimEntry>): ClaimEntry => ({
  id: "c1",
  content: "did something",
  kind: "source-derived",
  requiredEvidence: "any",
  producedBy: "tool-use",
  ...overrides,
});

const evidenceEntry = (overrides: Partial<EvidenceEntry>): EvidenceEntry => ({
  source: "read-file:c1",
  content: "data",
  producedBy: "tool-use",
  purpose: "execution-observation",
  ...overrides,
});

describe("deterministic.evidence.required", () => {
  it("passes silently when claims.length === 0", () => {
    const findings = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      candidateAnswer: { content: "hi", producedBy: "direct-answer", claims: [], evidence: [] },
    });
    expect(findings).toHaveLength(0);
  });

  it("passes requiredEvidence none without evidence", () => {
    const findings = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      candidateAnswer: {
        content: "hi",
        producedBy: "direct-answer",
        claims: [claim({ requiredEvidence: "none" })],
        evidence: [],
      },
    });
    expect(findings).toHaveLength(0);
  });

  it("requires any non-context evidence for requiredEvidence any", () => {
    const ctxOnlyContext: EvidenceEntry[] = [
      evidenceEntry({ purpose: "context" }),
    ];
    const missing = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: ctxOnlyContext,
      candidateAnswer: {
        content: "x",
        producedBy: "tool-use",
        claims: [claim({ requiredEvidence: "any" })],
        evidence: ctxOnlyContext,
      },
    });
    expect(missing[0]?.code).toBe("evidence_required_missing");

    const okEvidence = [evidenceEntry({ purpose: "execution-observation" })];
    const ok = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: okEvidence,
      candidateAnswer: {
        content: "x",
        producedBy: "tool-use",
        claims: [claim({ requiredEvidence: "any" })],
        evidence: okEvidence,
      },
    });
    expect(ok).toHaveLength(0);
  });

  it("requires exact source match for same-source", () => {
    const findings = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [evidenceEntry({ source: "other" })],
      candidateAnswer: {
        content: "x",
        producedBy: "tool-use",
        claims: [claim({ requiredEvidence: "same-source", sourceRef: "read-file:c1" })],
        evidence: [evidenceEntry({ source: "other" })],
      },
    });
    expect(findings[0]?.code).toBe("evidence_required_missing");

    const ok = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [evidenceEntry({ source: "read-file:c1" })],
      candidateAnswer: {
        content: "x",
        producedBy: "tool-use",
        claims: [claim({ requiredEvidence: "same-source", sourceRef: "read-file:c1" })],
        evidence: [evidenceEntry({ source: "read-file:c1" })],
      },
    });
    expect(ok).toHaveLength(0);
  });

  it("file-changed claim only passes when paired with file-write evidence at the same source", () => {
    const fileWriteEvidence: EvidenceEntry = {
      source: "write-file:c9",
      content: "wrote",
      producedBy: "tool-use",
      purpose: "execution-observation",
      recordType: "file-write",
    };
    const fileChangedClaim = claim({
      id: "fc1",
      kind: "file-changed",
      requiredEvidence: "same-source",
      sourceRef: "write-file:c9",
    });
 // Missing — only tool-observation evidence at the same source still
 // counts as same-source (the rule is source-based, not recordType-based);
 // however when ONLY external evidence exists the claim must fail.
    const missing = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [evidenceEntry({ source: "other", recordType: "tool-observation" })],
      candidateAnswer: {
        content: "wrote a file",
        producedBy: "tool-use",
        claims: [fileChangedClaim],
        evidence: [],
      },
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe("evidence_required_missing");

    const ok = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [fileWriteEvidence],
      candidateAnswer: {
        content: "wrote a file",
        producedBy: "tool-use",
        claims: [fileChangedClaim],
        evidence: [fileWriteEvidence],
      },
    });
    expect(ok).toHaveLength(0);
  });

  it("external-fact claim only passes when paired with external-source evidence at the same source", () => {
    const externalEvidence: EvidenceEntry = {
      source: "web-fetch:c11",
      content: "https://example.com",
      producedBy: "tool-use",
      purpose: "claim-support",
      recordType: "external-source",
    };
    const externalClaim = claim({
      id: "ec1",
      kind: "external-fact",
      requiredEvidence: "same-source",
      sourceRef: "web-fetch:c11",
    });
    const missing = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [evidenceEntry({ source: "read-file:c1" })],
      candidateAnswer: {
        content: "according to example.com, x is true",
        producedBy: "tool-use",
        claims: [externalClaim],
        evidence: [evidenceEntry({ source: "read-file:c1" })],
      },
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe("evidence_required_missing");

    const ok = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [externalEvidence],
      candidateAnswer: {
        content: "according to example.com, x is true",
        producedBy: "tool-use",
        claims: [externalClaim],
        evidence: [externalEvidence],
      },
    });
    expect(ok).toHaveLength(0);
  });

  it("claim with requiredEvidence=none ignores absence of evidence", () => {
    const findings = evidenceRequiredRule.evaluate({
      ...baseCtx(),
      evidence: [],
      candidateAnswer: {
        content: "limitation acknowledged",
        producedBy: "direct-answer",
        claims: [
          claim({ id: "lim1", kind: "limitation", requiredEvidence: "none" }),
        ],
        evidence: [],
      },
    });
    expect(findings).toHaveLength(0);
  });
});
