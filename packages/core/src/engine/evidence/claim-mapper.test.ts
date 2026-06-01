import { describe, expect, it } from "bun:test";
import type { EvidenceEntry } from "../../types/evidence";
import { mapDeterministicClaims } from "./claim-mapper";

describe("mapDeterministicClaims (matrix)", () => {
  it("builds source-derived claims from execution observations without LLM", () => {
    const evidence: EvidenceEntry[] = [
      {
        source: "read-file:c1",
        content: "hello",
        producedBy: "tool-use",
        purpose: "execution-observation",
        recordType: "tool-observation",
      },
    ];
    const claims = mapDeterministicClaims(evidence);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("source-derived");
    expect(claims[0]?.requiredEvidence).toBe("any");
    expect(claims[0]?.sourceRef).toBe("read-file:c1");
  });

  it("treats agent-run evidence as source-derived (any)", () => {
    const evidence: EvidenceEntry[] = [
      {
        source: "agent:analyst:r1",
        content: "agent answer",
        producedBy: "agent-runtime",
        purpose: "execution-observation",
        recordType: "agent-run",
      },
    ];
    const claims = mapDeterministicClaims(evidence);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("source-derived");
    expect(claims[0]?.requiredEvidence).toBe("any");
    expect(claims[0]?.producedBy).toBe("agent-runtime");
  });

  it("maps file-write evidence to file-changed claim with requiredEvidence same-source", () => {
    const evidence: EvidenceEntry[] = [
      {
        source: "write-file:c2",
        content: "ok",
        producedBy: "tool-use",
        purpose: "execution-observation",
        recordType: "file-write",
      },
    ];
    const claims = mapDeterministicClaims(evidence);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("file-changed");
    expect(claims[0]?.requiredEvidence).toBe("same-source");
    expect(claims[0]?.sourceRef).toBe("write-file:c2");
  });

  it("maps external-source evidence to external-fact claim with requiredEvidence same-source", () => {
    const evidence: EvidenceEntry[] = [
      {
        source: "web-fetch:c3",
        content: "https://example.com",
        producedBy: "tool-use",
        purpose: "claim-support",
        recordType: "external-source",
      },
    ];
    const claims = mapDeterministicClaims(evidence);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe("external-fact");
    expect(claims[0]?.requiredEvidence).toBe("same-source");
    expect(claims[0]?.sourceRef).toBe("web-fetch:c3");
  });

  it("never turns context evidence into claims", () => {
    const claims = mapDeterministicClaims([
      {
        source: "memory:1",
        content: "prior turn",
        producedBy: "host",
        purpose: "context",
        recordType: "tool-observation",
      },
    ]);
    expect(claims).toEqual([]);
  });

  it("returns no claims when evidence is empty", () => {
    expect(mapDeterministicClaims([])).toEqual([]);
  });
});
