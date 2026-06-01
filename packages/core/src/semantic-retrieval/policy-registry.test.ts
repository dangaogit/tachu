import { describe, expect, test } from "bun:test";
import { DefaultRetrievalPolicyRegistry, DEFAULT_RETRIEVAL_POLICIES } from "./policy-registry";

describe("DefaultRetrievalPolicyRegistry ( P4 α)", () => {
 test("returns sensible defaults for each caller", () => {
    const reg = new DefaultRetrievalPolicyRegistry();
    expect(reg.get("skill", "anything").topK).toBe(5);
    expect(reg.get("tool", "anything").topK).toBe(8);
    expect(reg.get("memory", "anything").topK).toBe(10);
    expect(reg.get("memory", "anything").staleFallback).toBe("bypass_semantic");
    expect(reg.get("skill", "anything").staleFallback).toBe("local_scan");
  });

 test("namespace override wins over caller-wide override", () => {
    const reg = new DefaultRetrievalPolicyRegistry({
      overrides: [
        { caller: "skill", policy: { topK: 3, staleFallback: "throw_error" } },
        {
          caller: "skill",
          namespace: "git",
          policy: { topK: 99, staleFallback: "bypass_semantic" },
        },
      ],
    });
    expect(reg.get("skill", "other").topK).toBe(3);
    expect(reg.get("skill", "git").topK).toBe(99);
    expect(reg.get("skill", "git").staleFallback).toBe("bypass_semantic");
  });

 test("exports DEFAULT_RETRIEVAL_POLICIES snapshot", () => {
    expect(DEFAULT_RETRIEVAL_POLICIES.skill.topK).toBe(5);
    expect(DEFAULT_RETRIEVAL_POLICIES.tool.minScoreThreshold).toBe(0.18);
  });
});
