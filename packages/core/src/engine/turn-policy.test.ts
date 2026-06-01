import { describe, expect, test } from "bun:test";
import { emptyTurnPolicy, normalizeTurnPolicy, readTurnPolicy, withTurnPolicyMetadata } from "./turn-policy";

describe("normalizeTurnPolicy", () => {
 test("no LLM turnPolicy + scope explicitSkillNames → stable shell with explicitSkills", () => {
    const policy = normalizeTurnPolicy({
      scope: { explicitSkillNames: ["chart-output"] },
      knownSkillNames: new Set(["chart-output"]),
    });
    expect(policy).toEqual({
      excludeTools: [],
      includeTools: [],
      explicitSkills: ["chart-output"],
      excludeSkills: [],
      pinSkills: [],
      visualization: "",
    });
  });

 test("dedupes and ignores unknown registry names", () => {
    const policy = normalizeTurnPolicy({
      llm: {
        excludeTools: ["image.qwen", "image.qwen", "unknown.tool"],
        pinSkills: ["chart-output", "missing-skill"],
        visualization: "data-chart",
      },
      scope: { explicitSkillNames: ["chart-output"] },
      knownToolNames: new Set(["image.qwen"]),
      knownSkillNames: new Set(["chart-output"]),
    });
    expect(policy.excludeTools).toEqual(["image.qwen"]);
    expect(policy.pinSkills).toEqual(["chart-output"]);
    expect(policy.explicitSkills).toEqual(["chart-output"]);
    expect(policy.visualization).toBe("data-chart");
  });
});

describe("readTurnPolicy", () => {
 test("returns empty shell when metadata missing", () => {
    expect(readTurnPolicy({ content: "hi", metadata: {} })).toEqual(emptyTurnPolicy());
  });

 test("round-trips via withTurnPolicyMetadata", () => {
    const policy = normalizeTurnPolicy({
      llm: { includeTools: ["image.qwen"] },
      knownToolNames: new Set(["image.qwen"]),
    });
    const input = withTurnPolicyMetadata({ content: "draw", metadata: {} }, policy);
    expect(readTurnPolicy(input).includeTools).toEqual(["image.qwen"]);
  });
});
