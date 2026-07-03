import { describe, expect, test } from "bun:test";
import { emptyGatingPolicy, normalizeGatingPolicy, readGatingPolicy, withGatingPolicyMetadata } from "./gating-policy";

describe("normalizeGatingPolicy", () => {
 test("scope explicitSkillNames → stable shell with explicitSkills", () => {
    const policy = normalizeGatingPolicy({
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
    const policy = normalizeGatingPolicy({
      preseed: {
        excludeTools: ["image.qwen", "image.qwen", "unknown.tool"],
        includeTools: [],
        explicitSkills: [],
        excludeSkills: [],
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

describe("readGatingPolicy", () => {
 test("returns empty shell when metadata missing", () => {
    expect(readGatingPolicy({ content: "hi", metadata: {} })).toEqual(emptyGatingPolicy());
  });

 test("round-trips via withGatingPolicyMetadata", () => {
    const policy = normalizeGatingPolicy({
      preseed: {
        excludeTools: [],
        includeTools: ["image.qwen"],
        explicitSkills: [],
        excludeSkills: [],
        pinSkills: [],
        visualization: "",
      },
      knownToolNames: new Set(["image.qwen"]),
    });
    const input = withGatingPolicyMetadata({ content: "draw", metadata: {} }, policy);
    expect(readGatingPolicy(input).includeTools).toEqual(["image.qwen"]);
  });
});
